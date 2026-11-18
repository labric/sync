//! Tests for signing the device out when the server rejects its Sync token.

use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{Listener, Manager};
use tauri_plugin_store::StoreExt;

use labric_sync_lib::{
    sign_out_rejected_token, store_rotated_token, HeartbeatConfig, HeartbeatState,
    TOKEN_REJECTED_STORE_KEY,
};

const FAR_FUTURE: u64 = 4_000_000_000;

fn token(org_id: &str, exp: u64) -> String {
    let claims = json!({ "iss": "labric-sync", "org_id": org_id, "exp": exp });
    format!("header.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string()))
}

fn mock_app(stored_token: &str) -> tauri::App<MockRuntime> {
    let heartbeat: HeartbeatState = Arc::new(tokio::sync::Mutex::new(Some(HeartbeatConfig {
        url: "http://localhost/api/sync/heartbeat".to_string(),
        token: stored_token.to_string(),
        device_fingerprint: "fingerprint".to_string(),
        app_version: "0.0.0".to_string(),
    })));
    let app = mock_builder()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(heartbeat)
        .build(mock_context(noop_assets()))
        .expect("failed to build mock app");
    app.store("settings.json")
        .unwrap()
        .set("token", stored_token.to_string());
    app
}

fn stored(app: &tauri::App<MockRuntime>, key: &str) -> Option<Value> {
    app.store("settings.json").unwrap().get(key)
}

async fn heartbeat_running(app: &tauri::App<MockRuntime>) -> bool {
    app.state::<HeartbeatState>().lock().await.is_some()
}

#[tokio::test]
async fn rejection_clears_the_token_stops_the_heartbeat_and_keeps_the_org() {
    let rejected = token("org_a", FAR_FUTURE);
    let app = mock_app(&rejected);

    sign_out_rejected_token(&rejected, app.handle()).await;

    assert_eq!(stored(&app, "token"), None);
    assert_eq!(
        stored(&app, TOKEN_REJECTED_STORE_KEY),
        Some(json!({ "org_id": "org_a" }))
    );
    assert!(!heartbeat_running(&app).await);
}

#[tokio::test]
async fn a_second_rejection_of_the_same_token_does_nothing() {
    let rejected = token("org_a", FAR_FUTURE);
    let app = mock_app(&rejected);
    let transitions = Arc::new(AtomicUsize::new(0));
    let counter = transitions.clone();
    app.listen_any("token_rejected", move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });

    sign_out_rejected_token(&rejected, app.handle()).await;
    sign_out_rejected_token(&rejected, app.handle()).await;

    assert_eq!(transitions.load(Ordering::SeqCst), 1);
    assert_eq!(stored(&app, "token"), None);
    assert_eq!(
        stored(&app, TOKEN_REJECTED_STORE_KEY),
        Some(json!({ "org_id": "org_a" }))
    );
}

#[tokio::test]
async fn a_late_rejection_of_an_older_token_keeps_the_new_pairing() {
    let new_token = token("org_b", FAR_FUTURE);
    let app = mock_app(&new_token);

    sign_out_rejected_token(&token("org_a", FAR_FUTURE), app.handle()).await;

    assert_eq!(stored(&app, "token"), Some(json!(new_token)));
    assert_eq!(stored(&app, TOKEN_REJECTED_STORE_KEY), None);
    assert!(heartbeat_running(&app).await);
}

#[tokio::test]
async fn an_expired_token_is_left_to_the_existing_expiry_check() {
    let expired = token("org_a", 1);
    let app = mock_app(&expired);

    sign_out_rejected_token(&expired, app.handle()).await;

    assert_eq!(stored(&app, "token"), Some(json!(expired)));
    assert_eq!(stored(&app, TOKEN_REJECTED_STORE_KEY), None);
    assert!(heartbeat_running(&app).await);
}

#[tokio::test]
async fn a_rotated_token_replaces_the_token_it_was_sent_with() {
    let sent = token("org_a", FAR_FUTURE);
    let rotated = token("org_a", FAR_FUTURE + 1);
    let app = mock_app(&sent);

    assert!(store_rotated_token(app.handle(), &sent, &rotated));

    assert_eq!(stored(&app, "token"), Some(json!(rotated)));
}

// A heartbeat in flight while the device is signed out must not restore a token.
#[tokio::test]
async fn a_rotated_token_is_not_written_after_the_sign_out() {
    let sent = token("org_a", FAR_FUTURE);
    let app = mock_app(&sent);
    sign_out_rejected_token(&sent, app.handle()).await;

    assert!(!store_rotated_token(
        app.handle(),
        &sent,
        &token("org_a", FAR_FUTURE + 1)
    ));

    assert_eq!(stored(&app, "token"), None);
}
