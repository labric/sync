use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_store::{Store, StoreExt};

use crate::heartbeat::HeartbeatState;
use crate::upload::SETTINGS_STORE_FILENAME;

const TOKEN_STORE_KEY: &str = "token";
/// Present while the device waits to be paired again after the server
/// rejected its token. Holds that token's organization, which decides whether
/// the next pairing keeps the watched folder.
pub const TOKEN_REJECTED_STORE_KEY: &str = "token_rejected";
pub const TOKEN_REJECTED_EVENT: &str = "token_rejected";

/// What the server sends when its Sync token check fails
/// (`RowLevelSecurityMiddleware` in the web repo's backend/core/middleware.py).
const REJECTED_TOKEN_BODY: &str = "Failed to authenticate request";
/// What the heartbeat route sends when the token belongs to another device,
/// for example a cloned machine image.
const WRONG_DEVICE_DETAIL: &str = "The heartbeat names a different device than its token";

/// Whether a failed response is the server rejecting this device's Sync
/// token. Any other 403, such as one from a proxy or firewall, is not.
pub fn is_token_rejection(status: StatusCode, body: &str) -> bool {
    let body = body.trim();
    status == StatusCode::FORBIDDEN
        && (body == REJECTED_TOKEN_BODY
            || serde_json::from_str::<Value>(body)
                .is_ok_and(|json| json["detail"] == WRONG_DEVICE_DETAIL))
}

/// The token's claims, read without checking its signature.
fn claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?.trim_end_matches('=');
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

pub fn is_expired(token: &str, now_secs: u64) -> bool {
    claims(token)
        .and_then(|claims| claims["exp"].as_u64())
        .is_some_and(|exp| exp <= now_secs)
}

/// Clears the stored token, stops the heartbeat and tells the frontend to
/// show the pairing screen. It acts only while `token` is still the stored
/// token, so a second rejection, or one that arrives after the device was
/// paired again, changes nothing. A token past its own expiry is left to the
/// frontend's expiry check, as before.
#[doc(hidden)]
pub async fn sign_out_rejected_token<R: Runtime>(token: &str, app_handle: &AppHandle<R>) {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    if is_expired(token, now_secs) {
        return;
    }
    let Some(store) = store_holding(app_handle, token) else {
        return;
    };

    log::warn!("The server rejected this device's Sync token; asking the user to pair again");
    store.delete(TOKEN_STORE_KEY);
    let org_id = claims(token).and_then(|claims| claims.get("org_id").cloned());
    store.set(TOKEN_REJECTED_STORE_KEY, json!({ "org_id": org_id }));
    // The heartbeat loop ends at its next beat once its config is gone.
    if let Some(heartbeat) = app_handle.try_state::<HeartbeatState>() {
        *heartbeat.lock().await = None;
    }
    let _ = app_handle.emit(TOKEN_REJECTED_EVENT, ());
}

/// Stores a token the heartbeat got by rotation, unless the token it was sent
/// with is no longer the stored one, as after a sign-out while it was in flight.
#[doc(hidden)]
pub fn store_rotated_token<R: Runtime>(app_handle: &AppHandle<R>, sent: &str, rotated: &str) -> bool {
    let Some(store) = store_holding(app_handle, sent) else {
        return false;
    };
    store.set(TOKEN_STORE_KEY, rotated);
    true
}

/// The settings store, if `token` is the token stored in it.
fn store_holding<R: Runtime>(
    app_handle: &AppHandle<R>,
    token: &str,
) -> Option<Arc<Store<R>>> {
    let store = app_handle.store(SETTINGS_STORE_FILENAME).ok()?;
    let stored = store.get(TOKEN_STORE_KEY);
    (stored.as_ref().and_then(Value::as_str) == Some(token)).then_some(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_with(claims: Value) -> String {
        format!("header.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    #[test]
    fn the_servers_answers_are_rejections() {
        for body in [
            "Failed to authenticate request",
            r#"{"detail": "The heartbeat names a different device than its token"}"#,
        ] {
            assert!(is_token_rejection(StatusCode::FORBIDDEN, body), "{body}");
        }
    }

    #[test]
    fn other_responses_are_not_rejections() {
        for (status, body) in [
            (StatusCode::FORBIDDEN, "<html>Access denied by your network administrator</html>"),
            (StatusCode::FORBIDDEN, r#"{"detail": "Forbidden"}"#),
            (StatusCode::FORBIDDEN, "Failed to authenticate request, blocked by proxy"),
            (StatusCode::UNAUTHORIZED, "Failed to authenticate request"),
            (StatusCode::BAD_GATEWAY, "Failed to authenticate request"),
        ] {
            assert!(!is_token_rejection(status, body), "{status} {body}");
        }
    }

    #[test]
    fn a_token_is_expired_from_its_exp_claim() {
        let token = token_with(json!({ "exp": 1_000 }));
        assert!(!is_expired(&token, 999));
        assert!(is_expired(&token, 1_000));
        assert!(is_expired(&token, 1_001));
    }

    #[test]
    fn a_token_without_a_readable_exp_is_not_expired() {
        assert!(!is_expired(&token_with(json!({ "org_id": "org" })), 1_000));
        assert!(!is_expired("not-a-jwt", 1_000));
    }
}
