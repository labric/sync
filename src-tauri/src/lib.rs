use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use sysinfo::{CpuRefreshKind, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

// File system constants
const DEVICE_ID_FILENAME: &str = "device_id.txt";

// Event type constants
pub const EVENT_TYPE_CREATED: &str = "created";
pub const EVENT_TYPE_MODIFIED: &str = "modified";
pub const EVENT_TYPE_DELETED: &str = "deleted";
pub const EVENT_TYPE_INITIAL: &str = "initial";
const EVENT_TYPE_OTHER: &str = "other";

// Memory conversion constant
const BYTES_TO_GB_DIVISOR: u64 = 1024 * 1024 * 1024;

mod http_client;
use http_client::{create_shared_client, SharedHttpClient};
#[doc(hidden)]
pub use http_client::check_sync_response;

fn show_main_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

mod upload;
use tauri_plugin_store::StoreExt;
use upload::{
    add_to_upload_queue_sync, add_to_upload_queue_with_event_type, clear_session_context,
    clear_upload_queue, get_org_members, get_queue_size, get_session_context, get_upload_config,
    get_upload_progress, get_upload_status_backlog, process_upload_queue, restore_session_context,
    restore_upload_config, set_session_context, set_upload_config, trigger_manual_upload,
    SessionContext, SessionContextState, UploadProgress, UploadProgressState, UploadQueueGeneration,
    SETTINGS_STORE_FILENAME,
};
// Public so integration tests can drive the watch lifecycle; not a real API
#[doc(hidden)]
pub use upload::{
    emit_file_upload_status, FileUploadStatus, UploadConfig, UploadConfigState, UploadQueue,
    UploadStatusLog, MAX_UPLOAD_STATUS_LOG,
};

mod heartbeat;
use heartbeat::{
    get_heartbeat_status, start_heartbeat, stop_heartbeat, update_heartbeat_config,
    HeartbeatStatus, HeartbeatStatusState, HeartbeatTaskState,
};
// Public so integration tests can check the token-rejection sign-out; not a real API
#[doc(hidden)]
pub use heartbeat::{HeartbeatConfig, HeartbeatState};

mod sync_token;
#[doc(hidden)]
pub use sync_token::{sign_out_rejected_token, store_rotated_token, TOKEN_REJECTED_STORE_KEY};

mod diagnostics;
use diagnostics::run_network_diagnostics;

#[doc(hidden)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub event_type: String,
    pub timestamp: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct DeviceInfo {
    hostname: String,
    platform: String,
    release: String,
    arch: String,
    cpus: usize,
    total_memory: u64, // in GB
    os_type: String,
    device_id: String,
    device_fingerprint: String,
}

// Global watcher state
#[doc(hidden)]
pub type WatcherState = Arc<Mutex<Option<RecommendedWatcher>>>;
// Folder currently being watched, if any
#[doc(hidden)]
pub type WatchedFolderState = Arc<Mutex<Option<String>>>;

/// Tells the frontend the watched folder (or null) whenever it changes; the
/// heartbeat reports the same state as `is_watching`.
const WATCHED_FOLDER_CHANGED_EVENT: &str = "watched_folder_changed";

// Bumped by every start/stop request so an in-flight start (whose initial scan
// can take a long time on big folders) can detect it was superseded and abort
// instead of undoing a newer stop or folder change
#[doc(hidden)]
pub type WatchGeneration = Arc<AtomicU64>;
// Recent file-change events, oldest first, one entry per path. Tauri drops
// events emitted before the webview has registered listeners (e.g. the whole
// initial scan of a watch resumed at startup), so the frontend replays this
// backlog on mount via get_file_change_backlog.
#[doc(hidden)]
pub type FileChangeLog = Arc<Mutex<VecDeque<FileChangeEvent>>>;

// Matches the frontend's file-change list cap
#[doc(hidden)]
pub const MAX_FILE_CHANGE_LOG: usize = 500;

fn record_and_emit_file_change<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    event: &FileChangeEvent,
) {
    if let Some(log) = app_handle.try_state::<FileChangeLog>() {
        let mut log = log.lock();
        // Keep only the latest event per path, mirroring the frontend list
        log.retain(|e| e.path != event.path);
        if log.len() >= MAX_FILE_CHANGE_LOG {
            log.pop_front();
        }
        log.push_back(event.clone());
    }
    let _ = app_handle.emit("file_change", event);
}

const WATCHED_FOLDER_STORE_KEY: &str = "watched_folder";

#[doc(hidden)]
#[derive(Debug)]
pub enum WatchStartOutcome {
    Started,
    Superseded,
}

#[tauri::command]
async fn start_watching(
    folder_path: String,
    app_handle: AppHandle,
    watcher_state: tauri::State<'_, WatcherState>,
    upload_queue: tauri::State<'_, UploadQueue>,
    upload_config: tauri::State<'_, UploadConfigState>,
    watched_folder: tauri::State<'_, WatchedFolderState>,
    generation: tauri::State<'_, WatchGeneration>,
) -> Result<String, String> {
    let expected_generation = generation.fetch_add(1, Ordering::SeqCst) + 1;
    match start_watching_impl(
        folder_path.clone(),
        &app_handle,
        watcher_state.inner(),
        upload_queue.inner(),
        upload_config.inner(),
        watched_folder.inner(),
        generation.inner(),
        expected_generation,
    )? {
        WatchStartOutcome::Started => Ok(format!("Started watching: {folder_path}")),
        WatchStartOutcome::Superseded => Ok("Watch superseded by a newer request".to_string()),
    }
}

// Public (doc-hidden) so integration tests can exercise the supersede logic
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn start_watching_impl<R: tauri::Runtime>(
    folder_path: String,
    app_handle: &AppHandle<R>,
    watcher_state: &WatcherState,
    upload_queue: &UploadQueue,
    upload_config: &UploadConfigState,
    watched_folder: &WatchedFolderState,
    generation: &WatchGeneration,
    expected_generation: u64,
) -> Result<WatchStartOutcome, String> {
    let is_superseded = || generation.load(Ordering::SeqCst) != expected_generation;

    // Stop any existing watcher — checked under the lock so a stale start can
    // never tear down a watcher that a newer request has already installed
    {
        let mut watcher = watcher_state.lock();
        if is_superseded() {
            return Ok(WatchStartOutcome::Superseded);
        }
        *watcher = None;
    }

    // Drop backlog entries from any previously watched folder, matching the
    // frontend clearing its list when the watched folder changes
    if let Some(log) = app_handle.try_state::<FileChangeLog>() {
        log.lock().clear();
    }

    // Scan the folder without touching the upload queue. Enqueueing is
    // deferred until after the commit point below, so a start that is
    // superseded mid-scan (the user stopped or picked another folder) leaves
    // no uploads behind.
    let files = match scan_folder_contents(&folder_path, app_handle, &is_superseded)? {
        Some(files) => files,
        None => {
            log::info!("Initial scan of {folder_path} superseded before it finished; discarding");
            return Ok(WatchStartOutcome::Superseded);
        }
    };

    let app_handle_clone = app_handle.clone();
    let upload_queue_clone = upload_queue.clone();
    let upload_config_clone = upload_config.clone();
    let folder_path_clone = folder_path.clone();

    // Channel to move work off the watcher callback thread so it never blocks
    let (watcher_tx, mut watcher_rx) =
        tokio::sync::mpsc::unbounded_channel::<(String, String)>();

    // Spawn a task that drains the channel and queues uploads without blocking the watcher
    {
        let queue = upload_queue_clone.clone();
        let config = upload_config_clone.clone();
        let app = app_handle.clone();
        let generation = generation.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((file_path, base_path)) = watcher_rx.recv().await {
                // Watcher events can race in around a stop or a newer start
                // (the watcher briefly runs before the commit check below, and
                // channel events may still be in flight when it is dropped).
                // Once this watch is no longer the newest request, drop them
                // instead of queueing uploads for a folder the user left.
                if generation.load(Ordering::SeqCst) != expected_generation {
                    break;
                }
                add_to_upload_queue_sync(file_path, base_path, &queue, &config, &app);
            }
        });
    }

    // Create file watcher — callback only emits the event and sends to the channel,
    // never blocks on queue/config locks
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let event = match res {
            Ok(event) => event,
            Err(e) => {
                log::error!("File watcher error: {e}");
                return;
            }
        };

        let event_type = match event.kind {
            notify::EventKind::Create(_) => EVENT_TYPE_CREATED,
            notify::EventKind::Modify(_) => EVENT_TYPE_MODIFIED,
            notify::EventKind::Remove(_) => EVENT_TYPE_DELETED,
            _ => EVENT_TYPE_OTHER,
        };

        for path in event.paths {
            let file_change = FileChangeEvent {
                path: path.to_string_lossy().to_string(),
                event_type: event_type.to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            };

            // Send to frontend immediately — never blocked by queue locks
            record_and_emit_file_change(&app_handle_clone, &file_change);

            // Queue for upload via channel (non-blocking send)
            if event_type == EVENT_TYPE_CREATED || event_type == EVENT_TYPE_MODIFIED {
                let file_path = path.to_string_lossy().to_string();
                let _ = watcher_tx.send((file_path, folder_path_clone.clone()));
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    // Start watching the folder
    watcher
        .watch(Path::new(&folder_path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch folder: {e}"))?;

    // Install the watcher, record the watched folder in memory, and persist it
    // so watching resumes automatically on the next launch (e.g. autostart
    // after a reboot). All three happen under the watcher lock, after checking
    // that no newer start/stop request arrived while the initial scan ran —
    // otherwise a slow scan would silently undo the user's later action.
    {
        let mut watcher_guard = watcher_state.lock();
        if is_superseded() {
            log::info!("Watch start for {folder_path} was superseded before it finished; discarding");
            return Ok(WatchStartOutcome::Superseded);
        }
        *watcher_guard = Some(watcher);
        *watched_folder.lock() = Some(folder_path.clone());
        let _ = app_handle.emit(WATCHED_FOLDER_CHANGED_EVENT, Some(&folder_path));
        if let Ok(store) = app_handle.store(SETTINGS_STORE_FILENAME) {
            store.set(WATCHED_FOLDER_STORE_KEY, serde_json::json!(folder_path));
        }
    }

    // The watch is committed; now queue the scanned files for upload. A stop
    // or newer start arriving mid-enqueue aborts the remainder, the same way
    // it would have aborted the scan.
    enqueue_scanned_files(
        files,
        &folder_path,
        upload_queue,
        upload_config,
        app_handle,
        &is_superseded,
    );

    Ok(WatchStartOutcome::Started)
}

/// Walk the folder depth-first, emitting `file_change` events for the UI, and
/// collect the files found — without queueing anything for upload yet, so an
/// aborted start has no upload side effects. Returns `Ok(None)` if a newer
/// start/stop request arrived mid-walk (checked per entry, so a stop during a
/// large scan takes effect almost immediately).
#[doc(hidden)]
pub fn scan_folder_contents<R: tauri::Runtime>(
    folder_path: &str,
    app_handle: &AppHandle<R>,
    is_superseded: &impl Fn() -> bool,
) -> Result<Option<Vec<String>>, String> {
    let mut files = Vec::new();
    let mut dirs_to_visit = vec![PathBuf::from(folder_path)];

    while let Some(dir) = dirs_to_visit.pop() {
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Failed to read directory {dir:?}: {e}"))?;

        for entry in entries.flatten() {
            if is_superseded() {
                return Ok(None);
            }
            let path = entry.path();
            let file_change = FileChangeEvent {
                path: path.to_string_lossy().to_string(),
                event_type: EVENT_TYPE_INITIAL.to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            };
            record_and_emit_file_change(app_handle, &file_change);

            if path.is_dir() {
                let relative_path = upload::get_relative_path(&path.to_string_lossy(), folder_path);
                upload::emit_file_upload_status(&relative_path, upload::STATUS_DIRECTORY, None, app_handle);
                dirs_to_visit.push(path);
            } else {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }

    Ok(Some(files))
}

/// Queue the files collected by the initial scan, aborting the remainder if a
/// newer start/stop request arrives mid-way.
#[doc(hidden)]
pub fn enqueue_scanned_files<R: tauri::Runtime>(
    files: Vec<String>,
    folder_path: &str,
    upload_queue: &UploadQueue,
    upload_config: &UploadConfigState,
    app_handle: &AppHandle<R>,
    is_superseded: &impl Fn() -> bool,
) {
    let total = files.len();
    for (queued, file) in files.into_iter().enumerate() {
        if is_superseded() {
            log::info!(
                "Watch of {folder_path} superseded; skipped queueing {} of {total} scanned files",
                total - queued
            );
            return;
        }
        add_to_upload_queue_with_event_type(
            file,
            folder_path.to_string(),
            upload_queue,
            upload_config,
            EVENT_TYPE_INITIAL,
            app_handle,
        );
    }
}

#[tauri::command]
async fn stop_watching(
    watcher_state: tauri::State<'_, WatcherState>,
    watched_folder: tauri::State<'_, WatchedFolderState>,
    generation: tauri::State<'_, WatchGeneration>,
    app_handle: AppHandle,
) -> Result<String, String> {
    // Invalidate any in-flight start before clearing, so a start that is still
    // scanning cannot re-install itself after this stop completes
    generation.fetch_add(1, Ordering::SeqCst);
    {
        let mut watcher = watcher_state.lock();
        *watcher = None;
    }
    *watched_folder.lock() = None;
    let _ = app_handle.emit(WATCHED_FOLDER_CHANGED_EVENT, None::<String>);

    // Match the frontend, which clears its file list on stop
    if let Some(log) = app_handle.try_state::<FileChangeLog>() {
        log.lock().clear();
    }

    // The user explicitly stopped watching, so don't resume on next launch
    if let Ok(store) = app_handle.store(SETTINGS_STORE_FILENAME) {
        let _ = store.delete(WATCHED_FOLDER_STORE_KEY);
    }

    Ok("Stopped watching".to_string())
}

#[tauri::command]
fn get_watched_folder(
    watched_folder: tauri::State<'_, WatchedFolderState>,
) -> Result<Option<String>, String> {
    Ok(watched_folder.lock().clone())
}

#[tauri::command]
fn get_file_change_backlog(
    log: tauri::State<'_, FileChangeLog>,
) -> Result<Vec<FileChangeEvent>, String> {
    // Newest first, matching the frontend's display order
    Ok(log.lock().iter().rev().cloned().collect())
}

fn get_device_id_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app directory: {e}"))?;
    }

    Ok(app_data_dir.join(DEVICE_ID_FILENAME))
}

fn get_device_id(app_handle: &AppHandle) -> Result<String, String> {
    let id_file_path = get_device_id_path(app_handle)?;

    if id_file_path.exists() {
        fs::read_to_string(&id_file_path).map_err(|e| format!("Failed to read device ID file: {e}"))
    } else {
        let new_id = Uuid::new_v4().to_string();
        fs::write(&id_file_path, &new_id)
            .map_err(|e| format!("Failed to write device ID file: {e}"))?;
        Ok(new_id)
    }
}

fn get_device_fingerprint() -> Result<String, String> {
    let machine_id = machine_uid::get().map_err(|e| format!("Failed to get machine ID: {e}"))?;

    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    let result = hasher.finalize();

    Ok(format!("{result:x}"))
}

#[tauri::command]
fn get_device_info(app_handle: AppHandle) -> Result<DeviceInfo, String> {
    let mut sys = System::new();
    sys.refresh_cpu_list(CpuRefreshKind::default());
    sys.refresh_memory();

    let device_id = get_device_id(&app_handle)?;
    let device_fingerprint = get_device_fingerprint()?;

    let hostname = System::host_name().unwrap_or_else(|| "Unknown".to_string());

    let platform = if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "Unknown"
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        std::env::consts::ARCH
    };

    let release = System::os_version().unwrap_or_else(|| "Unknown".to_string());

    Ok(DeviceInfo {
        hostname,
        platform: platform.to_string(),
        release,
        arch: arch.to_string(),
        cpus: sys.cpus().len(),
        total_memory: sys.total_memory() / BYTES_TO_GB_DIVISOR, // Convert to GB
        os_type: platform.to_string(),
        device_id,
        device_fingerprint,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_heartbeat_service(
    url: String,
    token: String,
    app_handle: AppHandle,
    http_client: tauri::State<'_, SharedHttpClient>,
    heartbeat_state: tauri::State<'_, HeartbeatState>,
    heartbeat_status_state: tauri::State<'_, HeartbeatStatusState>,
    heartbeat_task_state: tauri::State<'_, HeartbeatTaskState>,
    upload_config: tauri::State<'_, UploadConfigState>,
) -> Result<String, String> {
    // Get device info to build heartbeat config
    let device_info = get_device_info(app_handle.clone())?;
    let app_version = app_handle.package_info().version.to_string();

    // Get server URL from upload config
    let server_url = {
        let config = upload_config.lock();
        config.server_url.clone()
    };

    let full_url = format!("{server_url}{url}");

    let config = HeartbeatConfig {
        url: full_url,
        token,
        device_fingerprint: device_info.device_fingerprint,
        app_version,
    };

    start_heartbeat(
        config,
        http_client.inner().clone(),
        heartbeat_state.inner().clone(),
        heartbeat_status_state.inner().clone(),
        heartbeat_task_state.inner().clone(),
        app_handle,
    )
    .await?;

    Ok("Heartbeat started".to_string())
}

#[tauri::command]
async fn stop_heartbeat_service(
    heartbeat_state: tauri::State<'_, HeartbeatState>,
    heartbeat_status_state: tauri::State<'_, HeartbeatStatusState>,
    heartbeat_task_state: tauri::State<'_, HeartbeatTaskState>,
) -> Result<String, String> {
    stop_heartbeat(
        heartbeat_state.inner().clone(),
        heartbeat_status_state.inner().clone(),
        heartbeat_task_state.inner().clone(),
    )
    .await?;

    Ok("Heartbeat stopped".to_string())
}

#[tauri::command]
async fn get_heartbeat_status_command(
    heartbeat_status_state: tauri::State<'_, HeartbeatStatusState>,
) -> Result<HeartbeatStatus, String> {
    Ok(get_heartbeat_status(heartbeat_status_state.inner().clone()).await)
}

#[tauri::command]
async fn update_heartbeat_token(
    new_token: String,
    http_client: tauri::State<'_, SharedHttpClient>,
    heartbeat_state: tauri::State<'_, HeartbeatState>,
    heartbeat_status_state: tauri::State<'_, HeartbeatStatusState>,
    heartbeat_task_state: tauri::State<'_, HeartbeatTaskState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let current_config = {
        let state = heartbeat_state.inner().lock().await;
        state.clone()
    };

    if let Some(mut config) = current_config {
        config.token = new_token;
        update_heartbeat_config(
            config,
            http_client.inner().clone(),
            heartbeat_state.inner().clone(),
            heartbeat_status_state.inner().clone(),
            heartbeat_task_state.inner().clone(),
            app_handle,
        )
        .await?;
        Ok("Heartbeat token updated".to_string())
    } else {
        Err("No active heartbeat to update".to_string())
    }
}

struct QuitFlag(AtomicBool);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let watcher_state: WatcherState = Arc::new(Mutex::new(None));
    let watched_folder_state: WatchedFolderState = Arc::new(Mutex::new(None));
    let watch_generation: WatchGeneration = Arc::new(AtomicU64::new(0));
    let file_change_log: FileChangeLog = Arc::new(Mutex::new(VecDeque::new()));
    let upload_status_log: UploadStatusLog = Arc::new(Mutex::new(Vec::new()));
    let upload_queue: UploadQueue = Arc::new(Mutex::new(VecDeque::new()));
    let upload_queue_generation = UploadQueueGeneration::default();
    let upload_config: UploadConfigState = Arc::new(Mutex::new(UploadConfig::default()));
    let upload_progress: UploadProgressState = Arc::new(Mutex::new(UploadProgress {
        total_queued: 0,
        total_uploaded: 0,
        total_failed: 0,
        in_flight: 0,
        current_uploading: None,
    }));
    let session_context: SessionContextState = Arc::new(Mutex::new(SessionContext::default()));
    let http_client = create_shared_client();
    let heartbeat_state: HeartbeatState = Arc::new(tokio::sync::Mutex::new(None));
    let heartbeat_status_state: HeartbeatStatusState =
        Arc::new(tokio::sync::Mutex::new(HeartbeatStatus {
            status: None,
            is_loading: false,
            error: None,
        }));
    let heartbeat_task_state: HeartbeatTaskState = Arc::new(tokio::sync::Mutex::new(None));

    let builder = tauri::Builder::default();

    // A second launch (e.g. clicking the shortcut while the autostarted
    // instance is running) focuses the existing window instead of spawning a
    // duplicate watcher/uploader. Release-only so `pnpm tauri dev` can still
    // run alongside the installed app.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            show_main_window(&window);
        }
    }));

    let app = builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(QuitFlag(AtomicBool::new(false)))
        .manage(watcher_state.clone())
        .manage(watched_folder_state.clone())
        .manage(watch_generation.clone())
        .manage(file_change_log.clone())
        .manage(upload_status_log.clone())
        .manage(http_client.clone())
        .manage(upload_queue.clone())
        .manage(upload_queue_generation.clone())
        .manage(upload_config.clone())
        .manage(upload_progress.clone())
        .manage(session_context.clone())
        .manage(heartbeat_state.clone())
        .manage(heartbeat_status_state.clone())
        .manage(heartbeat_task_state.clone())
        .invoke_handler(tauri::generate_handler![
            start_watching,
            stop_watching,
            get_watched_folder,
            get_file_change_backlog,
            get_upload_status_backlog,
            get_device_info,
            get_upload_config,
            set_upload_config,
            get_upload_progress,
            clear_upload_queue,
            get_queue_size,
            trigger_manual_upload,
            start_heartbeat_service,
            stop_heartbeat_service,
            get_heartbeat_status_command,
            update_heartbeat_token,
            get_session_context,
            set_session_context,
            clear_session_context,
            get_org_members,
            run_network_diagnostics
        ])
        .setup(move |app| {
            // Restore session context from store
            let restored_ctx = restore_session_context(app.handle());
            *session_context.lock() = restored_ctx;

            // Restore persisted upload config (ignored patterns, delays, etc.)
            // so headless resume below runs with the user's saved settings
            if let Some(cfg) = restore_upload_config(app.handle()) {
                *upload_config.lock() = cfg;
            }

            // Start the upload processor in the background
            let upload_queue_clone = upload_queue.clone();
            let upload_queue_generation = upload_queue_generation.clone();
            let upload_config_clone = upload_config.clone();
            let upload_progress_clone = upload_progress.clone();
            let session_context_clone = session_context.clone();
            let http_client_clone = http_client.clone();
            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                process_upload_queue(
                    upload_queue_clone,
                    upload_queue_generation,
                    upload_config_clone,
                    upload_progress_clone,
                    session_context_clone,
                    http_client_clone,
                    app_handle,
                )
                .await;
            });

            // Resume watching the folder that was being watched when the app
            // last ran (e.g. autostart after a reboot), so sync continues
            // without user interaction. The initial scan re-checks every file
            // against the server, which also picks up changes made while the
            // app was not running.
            let persisted_folder = app
                .handle()
                .store(SETTINGS_STORE_FILENAME)
                .ok()
                .and_then(|s| s.get(WATCHED_FOLDER_STORE_KEY))
                .and_then(|v| v.as_str().map(String::from));

            if let Some(folder) = persisted_folder {
                if Path::new(&folder).is_dir() {
                    // Publish the folder before the scan finishes so the
                    // frontend sees it as watched as soon as the webview loads
                    *watched_folder_state.lock() = Some(folder.clone());

                    let app_handle = app.handle().clone();
                    let watcher_state = watcher_state.clone();
                    let watched_folder_state = watched_folder_state.clone();
                    let upload_queue = upload_queue.clone();
                    let upload_config = upload_config.clone();
                    let generation = watch_generation.clone();
                    let expected_generation =
                        watch_generation.fetch_add(1, Ordering::SeqCst) + 1;
                    tauri::async_runtime::spawn_blocking(move || {
                        match start_watching_impl(
                            folder.clone(),
                            &app_handle,
                            &watcher_state,
                            &upload_queue,
                            &upload_config,
                            &watched_folder_state,
                            &generation,
                            expected_generation,
                        ) {
                            Ok(WatchStartOutcome::Started) => {
                                log::info!("Resumed watching {folder} after restart");
                                let _ = app_handle.emit("watch_resumed", &folder);
                            }
                            Ok(WatchStartOutcome::Superseded) => {
                                log::info!(
                                    "Resume of {folder} superseded by a user start/stop request"
                                );
                            }
                            Err(e) => {
                                log::error!("Failed to resume watching {folder}: {e}");
                                // Only roll back if no newer start/stop request
                                // owns the watch state by now
                                if generation.load(Ordering::SeqCst) == expected_generation {
                                    *watched_folder_state.lock() = None;
                                    let _ = app_handle.emit("watch_resume_failed", &folder);
                                }
                            }
                        }
                    });
                } else {
                    // Keep the stored path so a temporarily unavailable folder
                    // (e.g. an unmounted drive) is retried on the next launch
                    log::warn!("Not resuming watch: folder does not exist: {folder}");
                }
            }

            // Build system tray
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("default window icon must be set in tauri.conf.json").clone())
                .tooltip("Labric Sync")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                    "quit" => {
                        if let Some(flag) = app.try_state::<QuitFlag>() {
                            flag.0.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                })
                .build(app)?;

            let _ = tray.set_tooltip(Some("Labric Sync"));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| match &event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if let Some(flag) = _app_handle.try_state::<QuitFlag>() {
                if flag.0.load(Ordering::SeqCst) {
                    return;
                }
            }
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = _app_handle.get_webview_window("main") {
                show_main_window(&window);
            }
        }
        _ => {}
    });
}
