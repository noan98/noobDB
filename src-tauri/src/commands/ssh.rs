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
use crate::ssh::known_hosts_history::{self, KnownHostAction, KnownHostEvent};
use crate::ssh::known_hosts_import::{self, ImportScan};

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

/// 履歴の記録は付随処理なので、失敗しても本体の操作は成功のまま警告ログだけ残す (#1630)。
/// 記録するのはホスト名・ポート・指紋のみ。
fn record_history(
    action: KnownHostAction,
    host: &str,
    port: u16,
    fingerprint: &str,
    previous: Option<String>,
) {
    if let Err(e) = known_hosts_history::record(action, host, port, fingerprint, previous) {
        tracing::warn!("failed to record known_hosts history: {e}");
    }
}

/// 現在の known_hosts にある `host:port` の指紋 (大小無視)。
fn current_fingerprint(host: &str, port: u16) -> Option<String> {
    known_hosts::list_known_hosts()
        .ok()?
        .into_iter()
        .find(|k| k.port == port && k.host.eq_ignore_ascii_case(host.trim()))
        .map(|k| k.fingerprint)
}

/// Forget the known_hosts entry for `host:port`, returning `true` when an entry
/// was removed. Used by the Settings known_hosts panel to drop a stale entry.
/// 削除した指紋は履歴に残す (#1630)。
#[tauri::command]
pub async fn forget_host_key(host: String, port: u16) -> Result<bool> {
    tokio::task::spawn_blocking(move || {
        let previous = current_fingerprint(&host, port);
        let removed = known_hosts::forget_host_key(&host, port)?;
        if removed {
            if let Some(fp) = previous {
                record_history(KnownHostAction::Forget, &host, port, &fp, None);
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| crate::error::AppError::Other(format!("forget_host_key task failed: {e}")))?
}

/// Pin `host:port` to exactly `fingerprint`, replacing any existing entry. The
/// host-key mismatch recovery flow calls this with the fingerprint the user
/// approved in the dialog, then reconnects: the reconnect verifies the server
/// against that pinned key, so a *different* key (an active MITM during the
/// re-trust window) mismatches again and is rejected rather than TOFU-accepted
/// (#682 review follow-up). 置き換えた旧指紋とともに履歴へ残す (#1630)。
#[tauri::command]
pub async fn trust_host_key(host: String, port: u16, fingerprint: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let previous = current_fingerprint(&host, port);
        known_hosts::set_host_key(&host, port, &fingerprint)?;
        record_history(
            KnownHostAction::Trust,
            &host,
            port,
            fingerprint.trim(),
            previous.filter(|p| p != fingerprint.trim()),
        );
        Ok(())
    })
    .await
    .map_err(|e| crate::error::AppError::Other(format!("trust_host_key task failed: {e}")))?
}

/// 信頼・削除・取り込みの履歴 (新しい順)。ホスト名・ポート・指紋のみ (#1630)。
#[tauri::command]
pub async fn list_known_hosts_history() -> Result<Vec<KnownHostEvent>> {
    tokio::task::spawn_blocking(known_hosts_history::list_events)
        .await
        .map_err(|e| {
            crate::error::AppError::Other(format!("list_known_hosts_history task failed: {e}"))
        })?
}

/// 取り込み 1 件 (フロントが一覧から選んだもの)。
#[derive(Debug, serde::Deserialize)]
pub struct ImportKnownHostEntry {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

/// `~/.ssh/known_hosts` を読み、取り込み候補を返す (読み取り専用, #1630)。ハッシュ化
/// エントリは照合できないため件数だけ返す。ファイルが無ければ `found = false`。
#[tauri::command]
pub async fn scan_openssh_known_hosts() -> Result<ImportScan> {
    tokio::task::spawn_blocking(|| {
        let Some(dir) = ssh_user_config_path().and_then(|p| p.parent().map(PathBuf::from)) else {
            return Ok(ImportScan::default());
        };
        let path = dir.join("known_hosts");
        if !path.exists() {
            return Ok(ImportScan::default());
        }
        let content = std::fs::read_to_string(&path)?;
        let existing = known_hosts::list_known_hosts()?;
        Ok(known_hosts_import::scan_content(&content, &existing))
    })
    .await
    .map_err(|e| {
        crate::error::AppError::Other(format!("scan_openssh_known_hosts task failed: {e}"))
    })?
}

/// 選択された候補を noobDB の known_hosts へ書き込み、取り込んだ件数を返す (#1630)。
/// 既存エントリがある場合は置き換え、旧指紋を履歴に残す。指紋が同じものは何もしない。
#[tauri::command]
pub async fn import_known_hosts(entries: Vec<ImportKnownHostEntry>) -> Result<usize> {
    tokio::task::spawn_blocking(move || {
        let mut n = 0;
        for e in entries {
            if !e.fingerprint.starts_with("SHA256:") {
                return Err(crate::error::AppError::InvalidInput(
                    "invalid host key fingerprint".into(),
                ));
            }
            let previous = current_fingerprint(&e.host, e.port);
            // 既に同じ指紋で登録済みなら何も変わらない: 書き込まず履歴にも残さない。
            if previous.as_deref() == Some(e.fingerprint.as_str()) {
                continue;
            }
            known_hosts::set_host_key(&e.host, e.port, &e.fingerprint)?;
            record_history(
                KnownHostAction::Import,
                &e.host,
                e.port,
                &e.fingerprint,
                previous.filter(|p| p != &e.fingerprint),
            );
            n += 1;
        }
        Ok(n)
    })
    .await
    .map_err(|e| crate::error::AppError::Other(format!("import_known_hosts task failed: {e}")))?
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
        // `Include` は ~/.ssh を基準に展開し、`Host *` の共通値も適用する (#1630)。
        let base = path.parent().map(PathBuf::from).unwrap_or_default();
        Ok(
            config_parser::resolve_host_with_includes(&content, &alias, &base)
                .map(to_resolved_alias),
        )
    })
    .await
    .map_err(|e| {
        crate::error::AppError::Other(format!("resolve_ssh_config_host task failed: {e}"))
    })?
}
