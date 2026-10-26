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

pub async fn start_heartbeat(
    config: HeartbeatConfig,
    http_client: SharedHttpClient,
    heartbeat_state: HeartbeatState,
    status_state: HeartbeatStatusState,
    task_state: HeartbeatTaskState,
    app_handle: AppHandle,
) -> Result<(), String> {
    stop_heartbeat(
        heartbeat_state.clone(),
        status_state.clone(),
        task_state.clone(),
    )
    .await?;

    {
        let mut state = heartbeat_state.lock().await;
        *state = Some(config.clone());
    }

    let heartbeat_state_clone = heartbeat_state.clone();
    let status_state_clone = status_state.clone();
    let app_handle_clone = app_handle.clone();

    let task_handle = tokio::spawn(async move {
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
    });

    {
        let mut task = task_state.lock().await;
        *task = Some(task_handle);
    }

    Ok(())
}

pub async fn stop_heartbeat(
    heartbeat_state: HeartbeatState,
    status_state: HeartbeatStatusState,
    task_state: HeartbeatTaskState,
) -> Result<(), String> {
    {
        let mut task = task_state.lock().await;
        if let Some(handle) = task.take() {
            handle.abort();
            log::info!("Previous heartbeat task cancelled");
        }
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

    log::info!("Heartbeat stopped");
    Ok(())
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
    stop_heartbeat(
        heartbeat_state.clone(),
        status_state.clone(),
        task_state.clone(),
    )
    .await?;
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
