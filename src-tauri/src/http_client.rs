use reqwest::{Client, Response, StatusCode};
use std::sync::Arc;
use tauri::AppHandle;

use crate::sync_token::{is_token_rejection, sign_out_rejected_token};

/// Shared HTTP client for connection pooling across all modules.
pub type SharedHttpClient = Arc<Client>;

pub fn create_shared_client() -> SharedHttpClient {
    Arc::new(Client::new())
}

/// Check an HTTP response status and return a descriptive error if it failed.
/// On success, returns the response unchanged for further processing.
pub async fn check_response(response: Response, context: &str) -> Result<Response, String> {
    let (status, body) = match split_failure(response).await {
        Ok(response) => return Ok(response),
        Err(failure) => failure,
    };
    Err(format!("{context} failed with status {status}: {body}"))
}

/// `check_response` for a request sent with the device's Sync token. When the
/// server rejected that token, the device is signed out before the error returns.
pub async fn check_sync_response(
    response: Response,
    context: &str,
    token: Option<&str>,
    app_handle: &AppHandle,
) -> Result<Response, String> {
    let (status, body) = match split_failure(response).await {
        Ok(response) => return Ok(response),
        Err(failure) => failure,
    };
    if let Some(token) = token.filter(|_| is_token_rejection(status, &body)) {
        sign_out_rejected_token(token, app_handle).await;
    }
    Err(format!("{context} failed with status {status}: {body}"))
}

async fn split_failure(response: Response) -> Result<Response, (StatusCode, String)> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "Unable to read response".to_string());
    Err((status, body))
}
