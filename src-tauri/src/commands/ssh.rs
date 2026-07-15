//! IPC commands for managing the SSH known_hosts file (#682).
//!
//! TOFU host-key verification records each server's fingerprint on first
//! connect (`ssh/handler.rs`). Before these commands the only way to recover
//! from a legitimate host-key rotation was to hand-edit the file; now the app
//! can list trusted hosts and forget a stale entry so the next connection
//! re-trusts the new key. The read/write logic lives in `ssh::known_hosts` and
//! is shared with the handler so both operate on the same file and format.

use crate::error::Result;
use crate::ssh::known_hosts::{self, KnownHost};

/// List every trusted host recorded in known_hosts (`host:port` + fingerprint).
/// A missing file yields an empty list. Used by the Settings known_hosts panel.
#[tauri::command]
pub async fn list_known_hosts() -> Result<Vec<KnownHost>> {
    // File I/O is cheap and one-shot; run it on a blocking thread so the async
    // worker isn't held even briefly on a slow disk.
    tokio::task::spawn_blocking(known_hosts::list_known_hosts)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("list_known_hosts task failed: {e}")))?
}

/// Forget the known_hosts entry for `host:port`, returning `true` when an entry
/// was removed. After a host-key mismatch, the re-trust flow calls this and then
/// reconnects, letting TOFU record the server's new key.
#[tauri::command]
pub async fn forget_host_key(host: String, port: u16) -> Result<bool> {
    tokio::task::spawn_blocking(move || known_hosts::forget_host_key(&host, port))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("forget_host_key task failed: {e}")))?
}
