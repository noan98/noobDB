//! IPC commands for managing the SSH known_hosts file (#682).
//!
//! TOFU host-key verification records each server's fingerprint on first
//! connect (`ssh/handler.rs`). Before these commands the only way to recover
//! from a legitimate host-key rotation was to hand-edit the file; now the app
//! can list trusted hosts and forget a stale entry so the next connection
//! re-trusts the new key. The read/write logic lives in `ssh::known_hosts` and
//! is shared with the handler so both operate on the same file and format.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::Result;
use crate::ssh::config_parser::{self, ResolvedSshHost};
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
/// was removed. Used by the Settings known_hosts panel to drop a stale entry.
#[tauri::command]
pub async fn forget_host_key(host: String, port: u16) -> Result<bool> {
    tokio::task::spawn_blocking(move || known_hosts::forget_host_key(&host, port))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("forget_host_key task failed: {e}")))?
}

/// Pin `host:port` to exactly `fingerprint`, replacing any existing entry. The
/// host-key mismatch recovery flow calls this with the fingerprint the user
/// approved in the dialog, then reconnects: the reconnect verifies the server
/// against that pinned key, so a *different* key (an active MITM during the
/// re-trust window) mismatches again and is rejected rather than TOFU-accepted
/// (#682 review follow-up).
#[tauri::command]
pub async fn trust_host_key(host: String, port: u16, fingerprint: String) -> Result<()> {
    tokio::task::spawn_blocking(move || known_hosts::set_host_key(&host, port, &fingerprint))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("trust_host_key task failed: {e}")))?
}

/// What the connection form can prefill from a `~/.ssh/config` `Host` alias
/// (#708). Distinct from [`ResolvedSshHost`] because `ProxyJump` is split into
/// discrete `jump_*` fields here — the frontend fills the bastion section of
/// the form directly rather than re-parsing the raw directive value itself.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedSshAlias {
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
}

fn to_resolved_alias(resolved: ResolvedSshHost) -> ResolvedSshAlias {
    let jump = resolved
        .proxy_jump
        .as_deref()
        .and_then(config_parser::parse_proxy_jump);
    ResolvedSshAlias {
        host_name: resolved.host_name,
        port: resolved.port,
        user: resolved.user,
        identity_file: resolved.identity_file,
        jump_host: jump.as_ref().map(|j| j.host.clone()),
        jump_port: jump.as_ref().and_then(|j| j.port),
        jump_user: jump.as_ref().and_then(|j| j.user.clone()),
    }
}

/// The user's `~/.ssh/config` path (`%USERPROFILE%\.ssh\config` on Windows).
/// `None` when the home directory can't be resolved.
fn ssh_user_config_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".ssh").join("config"))
}

/// Resolve `HostName` / `Port` / `User` / `IdentityFile` / `ProxyJump` for
/// `alias` from the user's `~/.ssh/config`, for the connection form's
/// "load from SSH config" action (#708). Read-only and best-effort: a missing
/// config file, an unresolvable home directory, or an alias with no matching
/// `Host` block all return `Ok(None)` rather than an error — there's nothing
/// actionable for the UI to show beyond "nothing to prefill". The parsed
/// values are only ever copied into the form; the file is not consulted again
/// at connect time.
#[tauri::command]
pub async fn resolve_ssh_config_host(alias: String) -> Result<Option<ResolvedSshAlias>> {
    let alias = alias.trim().to_string();
    if alias.is_empty() {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        let Some(path) = ssh_user_config_path() else {
            return Ok(None);
        };
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)?;
        Ok(config_parser::resolve_host(&content, &alias).map(to_resolved_alias))
    })
    .await
    .map_err(|e| {
        crate::error::AppError::Other(format!("resolve_ssh_config_host task failed: {e}"))
    })?
}
