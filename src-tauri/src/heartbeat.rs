use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{interval, MissedTickBehavior};

use crate::http_client::{check_response, SharedHttpClient};
use crate::WatchedFolderState;

const SETTINGS_STORE_FILENAME: &str = "settings.json";

const HEARTBEAT_INTERVAL_SECS: u64 = 30;
const OFFLINE_STATUS: &str = "offline";

#[derive(Clone, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    device_fingerprint: String,
    app_version: String,
    is_watching: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HeartbeatResponse {
    status: String,
    first_seen: String,
    last_seen: String,
    app_version: String,
    #[serde(skip_serializing)]
    new_token: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HeartbeatStatus {
    pub status: Option<HeartbeatResponse>,
    pub is_loading: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct HeartbeatConfig {
    pub url: String,
    pub token: String,
    pub device_fingerprint: String,
    pub app_version: String,
}

pub type HeartbeatState = Arc<Mutex<Option<HeartbeatConfig>>>;
pub type HeartbeatStatusState = Arc<Mutex<HeartbeatStatus>>;
pub type HeartbeatTaskState = Arc<Mutex<Option<JoinHandle<()>>>>;

/// Stops any running heartbeat loop and starts a new one.
pub async fn start_heartbeat(
    config: HeartbeatConfig,
    http_client: SharedHttpClient,
    heartbeat_state: HeartbeatState,
    status_state: HeartbeatStatusState,
    task_state: HeartbeatTaskState,
    app_handle: AppHandle,
) -> Result<(), String> {
    let (loop_config, loop_status) = (heartbeat_state.clone(), status_state.clone());
    replace_heartbeat_task(config, &heartbeat_state, &status_state, &task_state, || {
        spawn_heartbeat_loop(http_client, loop_config, loop_status, app_handle)
    })
    .await;
    Ok(())
}

/// The task lock is held from the abort until the new handle is stored. If it
/// were released in between, two overlapping starts (React StrictMode runs the
/// `useHeartbeat` effect twice in dev) could both find no task to abort, both
/// spawn, and the second store would overwrite the first handle, leaving that
/// loop running with nothing able to abort it.
async fn replace_heartbeat_task(
    config: HeartbeatConfig,
    heartbeat_state: &HeartbeatState,
    status_state: &HeartbeatStatusState,
    task_state: &HeartbeatTaskState,
    spawn_loop: impl FnOnce() -> JoinHandle<()>,
) {
    let mut task = task_state.lock().await;
    clear_heartbeat(&mut task, heartbeat_state, status_state).await;
    *heartbeat_state.lock().await = Some(config);
    *task = Some(spawn_loop());
}

fn spawn_heartbeat_loop(
    http_client: SharedHttpClient,
    heartbeat_state_clone: HeartbeatState,
    status_state_clone: HeartbeatStatusState,
    app_handle_clone: AppHandle,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            let config = {
                let state = heartbeat_state_clone.lock().await;
                state.clone()
            };

            let Some(config) = config else {
                break;
            };

            let is_watching = app_handle_clone
                .try_state::<WatchedFolderState>()
                .is_some_and(|folder| folder.lock().is_some());
            let result = make_heartbeat_request(&http_client, &config, is_watching).await;
            let status = match result {
                Ok(response) => {
                    log::info!("Heartbeat successful");

                    // Handle token rotation
                    if let Some(ref new_token) = response.new_token {
                        log::info!("Received rotated token from server, updating store");
                        match app_handle_clone.store(SETTINGS_STORE_FILENAME) {
                            Ok(store) => {
                                store.set(
                                    "token",
                                    serde_json::Value::String(new_token.clone()),
                                );
                                // Update the in-memory config so future heartbeats use the new token
                                {
                                    let mut state = heartbeat_state_clone.lock().await;
                                    if let Some(ref mut cfg) = *state {
                                        cfg.token = new_token.clone();
                                    }
                                }

                            }
                            Err(e) => {
                                log::error!("Failed to persist rotated token: {e}");
                            }
                        }
                    }

                    HeartbeatStatus {
                        status: Some(response),
                        is_loading: false,
                        error: None,
                    }
                }
                Err(e) => {
                    log::error!("Heartbeat failed: {e}");
                    let previous_response = {
                        let state = status_state_clone.lock().await;
                        state.status.clone()
                    };
                    let failed_response = previous_response.map(|mut prev| {
                        prev.status = OFFLINE_STATUS.to_string();
                        prev
                    });
                    HeartbeatStatus {
                        status: failed_response,
                        is_loading: false,
                        error: Some(e),
                    }
                }
            };

            {
                let mut state = status_state_clone.lock().await;
                *state = status.clone();
            }
            let _ = app_handle_clone.emit("heartbeat_status", &status);

            interval.tick().await;
        }
    })
}

pub async fn stop_heartbeat(
    heartbeat_state: HeartbeatState,
    status_state: HeartbeatStatusState,
    task_state: HeartbeatTaskState,
) -> Result<(), String> {
    let mut task = task_state.lock().await;
    clear_heartbeat(&mut task, &heartbeat_state, &status_state).await;
    log::info!("Heartbeat stopped");
    Ok(())
}

/// Aborts the running loop, if any, and clears the config and status.
/// The caller must hold the task lock.
async fn clear_heartbeat(
    task: &mut Option<JoinHandle<()>>,
    heartbeat_state: &HeartbeatState,
    status_state: &HeartbeatStatusState,
) {
    if let Some(handle) = task.take() {
        handle.abort();
        log::info!("Previous heartbeat task cancelled");
    }

    {
        let mut state = heartbeat_state.lock().await;
        *state = None;
    }

    {
        let mut status = status_state.lock().await;
        *status = HeartbeatStatus {
            status: None,
            is_loading: false,
            error: None,
        };
    }
}

async fn make_heartbeat_request(
    client: &SharedHttpClient,
    config: &HeartbeatConfig,
    is_watching: bool,
) -> Result<HeartbeatResponse, String> {
    let request_body = HeartbeatRequest {
        device_fingerprint: config.device_fingerprint.clone(),
        app_version: config.app_version.clone(),
        is_watching,
    };

    log::info!("Making heartbeat request to: {}", config.url);

    let response = client
        .post(&config.url)
        .header("Authorization", format!("Bearer {}", config.token))
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let response = check_response(response, "Heartbeat").await?;

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))
}

pub async fn get_heartbeat_status(status_state: HeartbeatStatusState) -> HeartbeatStatus {
    let state = status_state.lock().await;
    state.clone()
}

pub async fn update_heartbeat_config(
    new_config: HeartbeatConfig,
    http_client: SharedHttpClient,
    heartbeat_state: HeartbeatState,
    status_state: HeartbeatStatusState,
    task_state: HeartbeatTaskState,
    app_handle: AppHandle,
) -> Result<(), String> {
    // start_heartbeat replaces the running loop itself.
    start_heartbeat(
        new_config,
        http_client,
        heartbeat_state,
        status_state,
        task_state,
        app_handle,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> HeartbeatConfig {
        HeartbeatConfig {
            url: "http://localhost/api/sync/heartbeat".to_string(),
            token: "token".to_string(),
            device_fingerprint: "fingerprint".to_string(),
            app_version: "0.0.0".to_string(),
        }
    }

    #[tokio::test]
    async fn start_spawns_the_loop_while_holding_the_task_lock() {
        let heartbeat_state: HeartbeatState = Arc::new(Mutex::new(None));
        let status_state: HeartbeatStatusState = Arc::new(Mutex::new(HeartbeatStatus {
            status: None,
            is_loading: false,
            error: None,
        }));
        let task_state: HeartbeatTaskState = Arc::new(Mutex::new(None));

        // If the lock is free at spawn time, an overlapping start can slip in
        // between the abort and the store and orphan a loop.
        let spawn_loop = || {
            assert!(
                task_state.try_lock().is_err(),
                "task lock released before spawn"
            );
            tokio::spawn(std::future::pending::<()>())
        };

        replace_heartbeat_task(
            test_config(),
            &heartbeat_state,
            &status_state,
            &task_state,
            spawn_loop,
        )
        .await;
        let first = task_state.lock().await.as_ref().unwrap().abort_handle();

        replace_heartbeat_task(
            test_config(),
            &heartbeat_state,
            &status_state,
            &task_state,
            spawn_loop,
        )
        .await;
        tokio::task::yield_now().await;
        assert!(
            first.is_finished(),
            "first loop still running after second start"
        );
        assert!(task_state.lock().await.is_some());

        stop_heartbeat(heartbeat_state.clone(), status_state, task_state.clone())
            .await
            .unwrap();
        assert!(task_state.lock().await.is_none());
        assert!(heartbeat_state.lock().await.is_none());
    }
}
