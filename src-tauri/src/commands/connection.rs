use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::{is_session_init_sql, Connection, DbConnectOptions, DriverKind, SslMode};
use crate::error::{AppError, Result};
use crate::profiles::{secrets, SshAuthMethod};
use crate::ssh::{SshConfig, SshPhase, SshTunnel};
use crate::state::{new_session_id, AppState, Session, SessionId};

/// Default overall deadline (seconds) for a whole connection attempt when the
/// caller doesn't specify one. Covers the SSH tunnel connect + auth and the DB
/// connect together, so an unreachable host / stuck firewall no longer hangs on
/// the OS TCP timeout (tens of seconds to minutes). #684.
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 30;
/// Clamp bounds for a caller-supplied connect timeout, mirroring the query
/// timeout setting's guardrails: too small aborts healthy-but-slow connects,
/// too large defeats the purpose.
const MIN_CONNECT_TIMEOUT_SECS: u64 = 5;
const MAX_CONNECT_TIMEOUT_SECS: u64 = 300;

/// Resolve the effective connect timeout: the caller's value clamped to
/// `[MIN, MAX]`, or the default when unset / zero.
fn clamp_connect_timeout(secs: Option<u64>) -> u64 {
    match secs {
        Some(s) if s > 0 => s.clamp(MIN_CONNECT_TIMEOUT_SECS, MAX_CONNECT_TIMEOUT_SECS),
        _ => DEFAULT_CONNECT_TIMEOUT_SECS,
    }
}

/// A phase of the connection attempt, reported to the frontend via
/// `connect-progress:phase` so a spinner can say *where* a slow connect is stuck
/// (#684). Also recorded so a timeout can name the phase it hung in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectPhase {
    Preparing,
    TunnelConnecting,
    TunnelAuthenticating,
    DbConnecting,
}

impl ConnectPhase {
    /// Stable, machine-readable label sent to the frontend and embedded in a
    /// timeout error. The frontend maps these to localized phase text.
    fn label(self) -> &'static str {
        match self {
            ConnectPhase::Preparing => "preparing",
            ConnectPhase::TunnelConnecting => "tunnel_connecting",
            ConnectPhase::TunnelAuthenticating => "tunnel_authenticating",
            ConnectPhase::DbConnecting => "db_connecting",
        }
    }
}

#[derive(Debug, Serialize, Clone)]
struct ConnectPhaseEvent {
    #[serde(rename = "attemptId")]
    attempt_id: String,
    phase: &'static str,
}

const EV_CONNECT_PHASE: &str = "connect-progress:phase";

/// Emits `connect-progress:phase` events and tracks the current phase so a
/// timeout can report where it hung. Threaded through the open path so the SSH
/// tunnel and DB connect can each announce their phase (#684).
struct ConnectProgress {
    app: AppHandle,
    attempt_id: String,
    current: Arc<Mutex<ConnectPhase>>,
}

impl ConnectProgress {
    fn new(app: AppHandle, attempt_id: String) -> Self {
        Self {
            app,
            attempt_id,
            current: Arc::new(Mutex::new(ConnectPhase::Preparing)),
        }
    }

    /// Record `phase` as current and emit it to the frontend. Emit failures are
    /// best-effort (a dropped progress event must not fail the connect).
    fn report(&self, phase: ConnectPhase) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = phase;
        let _ = self.app.emit(
            EV_CONNECT_PHASE,
            ConnectPhaseEvent {
                attempt_id: self.attempt_id.clone(),
                phase: phase.label(),
            },
        );
    }

    fn current_label(&self) -> &'static str {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .label()
    }
}

#[derive(Debug, Deserialize)]
pub struct ConnectRequest {
    /// Optional: if present, secrets will be looked up from keyring for this profile.
    pub profile_id: Option<String>,
    pub driver: DriverKind,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// If empty and profile_id is set, the password is loaded from keyring.
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshRequest>,
    /// Required for file-backed drivers (SQLite); ignored otherwise.
    #[serde(default)]
    pub file_path: Option<String>,
    /// TLS requirement level. `None` keeps the driver default. Ignored by SQLite.
    #[serde(default)]
    pub ssl_mode: Option<SslMode>,
    /// CA (root) certificate path used to verify the server certificate.
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    /// Client certificate path for mutual TLS (mTLS).
    #[serde(default)]
    pub ssl_client_cert: Option<String>,
    /// Client private key path for mutual TLS (mTLS).
    #[serde(default)]
    pub ssl_client_key: Option<String>,
    /// Session-initialization SQL run right after each connection is established.
    /// Validated with `is_session_init_sql` (SET / PRAGMA / read-only only).
    #[serde(default)]
    pub init_sql: Option<String>,
    /// When true the resulting session refuses to execute non-read-only SQL.
    #[serde(default)]
    pub read_only: bool,
    /// When true, statements run on the resulting session are not recorded
    /// in the query history.
    #[serde(default)]
    pub skip_history: bool,
}

#[derive(Debug, Deserialize)]
pub struct SshRequest {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub private_key_path: std::path::PathBuf,
    /// If empty and profile_id is set, the passphrase is loaded from keyring.
    #[serde(default)]
    pub passphrase: String,
    /// Password for `auth_method == Password`. If empty and profile_id is set,
    /// it is loaded from the keyring.
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct ConnectResponse {
    pub session_id: SessionId,
}

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    req: ConnectRequest,
    attempt_id: Option<String>,
    timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<String> {
    log_attempt(&req, "test_connection");
    let secs = clamp_connect_timeout(timeout_secs);
    // A test connection is cancelable too, so a probe against an unreachable
    // host can be abandoned from the form (#684). Fall back to a fresh id when
    // the caller doesn't supply one (older callers / tests).
    let attempt_id = attempt_id.unwrap_or_else(new_session_id);
    let progress = ConnectProgress::new(app.clone(), attempt_id.clone());

    let fut = async move {
        let (tunnel, _opts, conn) = open_connection(&req, &progress, secs).await?;
        conn.execute("SELECT 1", None).await?;
        conn.close().await;
        drop(tunnel);
        Ok::<(), AppError>(())
    };
    let result = run_cancelable(&state, &attempt_id, fut).await;

    match &result {
        Ok(()) => tracing::info!("test_connection succeeded"),
        Err(e) => tracing::error!(error = %e, "test_connection failed"),
    }
    result.map(|()| "ok".into())
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    req: ConnectRequest,
    attempt_id: Option<String>,
    timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<ConnectResponse> {
    log_attempt(&req, "connect");
    let secs = clamp_connect_timeout(timeout_secs);
    let attempt_id = attempt_id.unwrap_or_else(new_session_id);
    let profile_id = req.profile_id.clone();
    let read_only = req.read_only;
    let skip_history = req.skip_history;
    let driver = req.driver;
    // Capture the non-secret SSH parameters before `req` is moved into the
    // connect future, so the session can rebuild its tunnel on reconnect (#712).
    let reconnect_ssh = reconnect_ssh_from(&req);
    let progress = ConnectProgress::new(app.clone(), attempt_id.clone());

    let fut = async move { open_connection(&req, &progress, secs).await };
    let (tunnel, opts, conn) = match run_cancelable(&state, &attempt_id, fut).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(driver = driver.as_str(), error = %e, "connect failed");
            return Err(e);
        }
    };

    let session = Session {
        id: new_session_id(),
        profile_id,
        conn,
        read_only,
        skip_history,
        connect_options: opts,
        reconnect_ssh,
        _tunnel: tunnel,
    };
    let id = state.insert(session).await;
    tracing::info!(
        session_id = %id,
        driver = driver.as_str(),
        read_only,
        "connection established"
    );
    Ok(ConnectResponse { session_id: id })
}

/// Cancel an in-flight `connect` / `test_connection` attempt by its `attempt_id`.
/// Returns `true` when an attempt was found and aborted. The aborted attempt's
/// command rejects with a "cancelled" error, and its tunnel/connection drop
/// cleanly (#684).
#[tauri::command]
pub async fn cancel_connect(attempt_id: String, state: State<'_, AppState>) -> Result<bool> {
    Ok(state.cancel_connect(&attempt_id).await)
}

/// Run a connection future as a cancelable task.
///
/// The work is `spawn`ed so its `AbortHandle` can be registered for
/// `cancel_connect`; a cancel aborts the task, dropping its future and tearing
/// down any half-open tunnel/connection. The deadline itself lives inside the
/// future (`open_connection`), which owns the progress reporter and so can name
/// the phase it hung in — this wrapper only adds cancelability.
async fn run_cancelable<T: Send + 'static>(
    state: &AppState,
    attempt_id: &str,
    fut: impl std::future::Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    let handle = tokio::spawn(fut);
    let token = state
        .register_connect(attempt_id.to_string(), handle.abort_handle())
        .await;
    let joined = handle.await;
    // Pass the token back so we only clear our own registration — never a newer
    // attempt that reused this id and superseded us.
    state.forget_connect(attempt_id, token).await;
    match joined {
        Ok(res) => res,
        // Task was aborted by cancel_connect.
        Err(e) if e.is_cancelled() => Err(AppError::Other("connection attempt cancelled".into())),
        Err(e) => Err(AppError::Other(format!("connect task failed: {e}"))),
    }
}

/// Connection health check. Returns `true` when the session's connection
/// answers a lightweight `SELECT 1`, `false` when it is dead (sleep / dropped
/// tunnel), and `Err` only when the session id is unknown. The frontend polls
/// this (e.g. on window focus) and reconnects when it reports `false`.
#[tauri::command]
pub async fn ping_session(session_id: String, state: State<'_, AppState>) -> Result<bool> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let alive = session.conn.health_check().await.is_ok();
    if !alive {
        tracing::info!(session_id = %session_id, "health check failed; connection appears dead");
    }
    Ok(alive)
}

#[tauri::command]
pub async fn disconnect(session_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(sess) = state.remove(&session_id).await {
        sess.conn.close().await;
        // Session (and its tunnel) drops with the last Arc reference.
        tracing::info!(session_id = %session_id, "disconnected");
    } else {
        tracing::debug!(session_id = %session_id, "disconnect: no such session");
    }
    Ok(())
}

/// Re-establish a dropped session's connection *in place*, keeping the same
/// `SessionId` (#712). Rebuilds the SSH tunnel (when the session was tunneled),
/// opens a fresh `db::Connection` from the session's stored `connect_options`,
/// and only then swaps the live session for the new one — so on any failure the
/// old session is left untouched and the caller can retry. Because the id is
/// unchanged, the frontend's open tabs and grid state (keyed by session id) stay
/// alive without a disconnect/restore round-trip.
///
/// Secrets follow the same rules as `connect`: the DB password is reused from
/// the already-held `connect_options`, and SSH passphrase / password are
/// re-resolved from the keyring by `profile_id` — no new plaintext is retained.
/// Session flags (`read_only` / `skip_history`) are preserved.
#[tauri::command]
pub async fn reconnect(session_id: String, state: State<'_, AppState>) -> Result<()> {
    reconnect_inner(&state, &session_id).await
}

/// Core of [`reconnect`], split out so integration tests can drive the
/// session-swap path without a Tauri runtime (exposed via `__test_api`).
pub async fn reconnect_inner(state: &AppState, session_id: &str) -> Result<()> {
    let old = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;

    // Build the fresh transport under an overall deadline so a reconnect against
    // a now-unreachable host can't hang indefinitely (mirrors `connect`'s
    // guardrail). The old session is not disturbed while this runs.
    let secs = DEFAULT_CONNECT_TIMEOUT_SECS;
    let (tunnel, opts, conn) =
        match tokio::time::timeout(Duration::from_secs(secs), reopen_transport(&old)).await {
            Ok(res) => res?,
            Err(_) => {
                return Err(AppError::ConnectTimeout {
                    phase: ConnectPhase::DbConnecting.label().to_string(),
                    secs,
                })
            }
        };

    let new_session = Session {
        id: old.id.clone(),
        profile_id: old.profile_id.clone(),
        conn,
        connect_options: opts,
        read_only: old.read_only,
        skip_history: old.skip_history,
        reconnect_ssh: old.reconnect_ssh.clone(),
        _tunnel: tunnel,
    };

    // Swap the live session for the new one, then close the old connection. The
    // old tunnel (if any) is dropped when the last Arc to the previous session
    // goes away, per the existing lifetime design.
    if let Some(prev) = state.replace(new_session).await {
        prev.conn.close().await;
    }
    tracing::info!(session_id = %session_id, "reconnected");
    Ok(())
}

/// Open a fresh tunnel (if the session was tunneled) and DB connection for a
/// reconnect. Returns the new tunnel guard, the options actually used (with the
/// tunnel's fresh local port patched in), and the live connection. Does not
/// touch `AppState`.
async fn reopen_transport(
    old: &Session,
) -> Result<(Option<SshTunnel>, DbConnectOptions, Connection)> {
    let mut opts = old.connect_options.clone();
    let tunnel = if let Some(ssh) = &old.reconnect_ssh {
        // Re-resolve SSH secrets from the keyring (no new plaintext retention).
        let mut cfg = ssh.clone();
        if let Some(pid) = &old.profile_id {
            if cfg.passphrase.is_empty() {
                if let Some(p) = secrets::get_ssh_passphrase(pid)? {
                    cfg.passphrase = p;
                }
            }
            if cfg.password.is_empty() {
                if let Some(p) = secrets::get_ssh_password(pid)? {
                    cfg.password = p;
                }
            }
        }
        let t = SshTunnel::open(&cfg).await?;
        // The stored options point at the old (now-dead) tunnel's local port;
        // redirect them at the freshly-bound one.
        opts.host = "127.0.0.1".to_string();
        opts.port = t.local_port;
        Some(t)
    } else {
        None
    };
    let conn = Connection::connect(&opts).await?;
    Ok((tunnel, opts, conn))
}

/// Build the non-secret [`SshConfig`] to stash on the session for reconnect,
/// from a connect request. Returns `None` when the request isn't tunneled. The
/// passphrase / password are deliberately left empty — reconnect re-resolves
/// them from the keyring so no extra plaintext lingers in memory (#712).
fn reconnect_ssh_from(req: &ConnectRequest) -> Option<SshConfig> {
    req.ssh.as_ref().map(|ssh| SshConfig {
        host: ssh.host.clone(),
        port: ssh.port,
        user: ssh.user.clone(),
        auth_method: ssh.auth_method,
        private_key_path: ssh.private_key_path.clone(),
        passphrase: String::new(),
        password: String::new(),
        remote_host: req.host.clone(),
        remote_port: req.port,
    })
}

/// Emits a single structured line describing a connection attempt. Logs only
/// the non-secret endpoint metadata (never the password or passphrase).
fn log_attempt(req: &ConnectRequest, op: &str) {
    tracing::info!(
        op,
        driver = req.driver.as_str(),
        host = %req.host,
        port = req.port,
        user = %req.user,
        via_ssh = req.ssh.is_some(),
        ssh_auth = ?req.ssh.as_ref().map(|s| s.auth_method),
        "attempting connection"
    );
}

/// Opens the SSH tunnel (when requested) and the DB connection under an overall
/// deadline (#684). Reports each phase through `progress`; on timeout returns a
/// `ConnectTimeout` naming the phase it was stuck in (tunnel connect / auth / DB
/// connect) so the UI can say where it hung rather than just "timed out".
async fn open_connection(
    req: &ConnectRequest,
    progress: &ConnectProgress,
    timeout_secs: u64,
) -> Result<(Option<SshTunnel>, DbConnectOptions, Connection)> {
    let work = async {
        let (tunnel, opts) = build_options(req, progress).await?;
        progress.report(ConnectPhase::DbConnecting);
        let conn = Connection::connect(&opts).await?;
        Ok::<_, AppError>((tunnel, opts, conn))
    };
    match tokio::time::timeout(Duration::from_secs(timeout_secs), work).await {
        Ok(res) => res,
        Err(_) => Err(AppError::ConnectTimeout {
            phase: progress.current_label().to_string(),
            secs: timeout_secs,
        }),
    }
}

/// Build DB options and (if requested) open an SSH tunnel, reporting SSH phases
/// through `progress`. Returns the optional tunnel guard that must outlive the
/// DB connection.
async fn build_options(
    req: &ConnectRequest,
    progress: &ConnectProgress,
) -> Result<(Option<SshTunnel>, DbConnectOptions)> {
    // Reject session-init SQL that isn't a non-mutating session setting before we
    // open anything, so the failure is a clear validation error rather than a
    // surprise on the first pooled connection. Applies to all drivers.
    let init_sql = req
        .init_sql
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(sql) = &init_sql {
        if !is_session_init_sql(sql) {
            return Err(AppError::InvalidInput(
                "session-init SQL may only contain SET / PRAGMA or read-only statements".into(),
            ));
        }
    }

    // File-backed drivers don't have a host/port/user/password and can't
    // be tunneled, so short-circuit before touching credentials or SSH.
    if matches!(req.driver, DriverKind::Sqlite) {
        let file_path = req
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("SQLite file path is required".into()))?;
        let opts = DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: req.driver,
            file_path: Some(file_path.to_string()),
            // File-backed drivers don't negotiate TLS.
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql,
        };
        return Ok((None, opts));
    }

    let password = resolve_password(req)?;

    let (tunnel, host, port) = if let Some(ssh) = &req.ssh {
        let passphrase = resolve_passphrase(req, ssh)?;
        let ssh_password = resolve_ssh_password(req, ssh)?;
        let cfg = SshConfig {
            host: ssh.host.clone(),
            port: ssh.port,
            user: ssh.user.clone(),
            auth_method: ssh.auth_method,
            private_key_path: ssh.private_key_path.clone(),
            passphrase,
            password: ssh_password,
            remote_host: req.host.clone(),
            remote_port: req.port,
        };
        // Map the tunnel's connect/auth phases onto our connect phases so the UI
        // can tell "stuck on the tunnel" apart from "stuck on SSH auth" (#684).
        let t = SshTunnel::open_with_progress(&cfg, |phase| {
            progress.report(match phase {
                SshPhase::Connecting => ConnectPhase::TunnelConnecting,
                SshPhase::Authenticating => ConnectPhase::TunnelAuthenticating,
            });
        })
        .await?;
        let port = t.local_port;
        (Some(t), "127.0.0.1".to_string(), port)
    } else {
        (None, req.host.clone(), req.port)
    };

    let opts = DbConnectOptions {
        host,
        port,
        user: req.user.clone(),
        password,
        database: req.database.clone(),
        driver: req.driver,
        file_path: None,
        ssl_mode: req.ssl_mode,
        ssl_root_cert: req.ssl_root_cert.clone(),
        ssl_client_cert: req.ssl_client_cert.clone(),
        ssl_client_key: req.ssl_client_key.clone(),
        init_sql,
    };
    Ok((tunnel, opts))
}

fn resolve_password(req: &ConnectRequest) -> Result<String> {
    if !req.password.is_empty() {
        return Ok(req.password.clone());
    }
    if let Some(id) = &req.profile_id {
        if let Some(p) = secrets::get_db_password(id)? {
            return Ok(p);
        }
    }
    Ok(String::new())
}

fn resolve_passphrase(req: &ConnectRequest, ssh: &SshRequest) -> Result<String> {
    if !ssh.passphrase.is_empty() {
        return Ok(ssh.passphrase.clone());
    }
    if let Some(id) = &req.profile_id {
        if let Some(p) = secrets::get_ssh_passphrase(id)? {
            return Ok(p);
        }
    }
    Ok(String::new())
}

fn resolve_ssh_password(req: &ConnectRequest, ssh: &SshRequest) -> Result<String> {
    if !ssh.password.is_empty() {
        return Ok(ssh.password.clone());
    }
    if let Some(id) = &req.profile_id {
        if let Some(p) = secrets::get_ssh_password(id)? {
            return Ok(p);
        }
    }
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_connect_timeout_uses_default_when_unset_or_zero() {
        assert_eq!(clamp_connect_timeout(None), DEFAULT_CONNECT_TIMEOUT_SECS);
        assert_eq!(clamp_connect_timeout(Some(0)), DEFAULT_CONNECT_TIMEOUT_SECS);
    }

    #[test]
    fn clamp_connect_timeout_clamps_to_bounds() {
        assert_eq!(clamp_connect_timeout(Some(1)), MIN_CONNECT_TIMEOUT_SECS);
        assert_eq!(
            clamp_connect_timeout(Some(10_000)),
            MAX_CONNECT_TIMEOUT_SECS
        );
        // In-range values pass through unchanged.
        assert_eq!(clamp_connect_timeout(Some(45)), 45);
    }

    #[test]
    fn connect_phase_labels_are_stable() {
        // The frontend maps these exact strings to localized phase text (#684);
        // changing them would silently break the progress display.
        assert_eq!(ConnectPhase::Preparing.label(), "preparing");
        assert_eq!(ConnectPhase::TunnelConnecting.label(), "tunnel_connecting");
        assert_eq!(
            ConnectPhase::TunnelAuthenticating.label(),
            "tunnel_authenticating"
        );
        assert_eq!(ConnectPhase::DbConnecting.label(), "db_connecting");
    }

    #[test]
    fn connect_timeout_error_names_its_phase_and_kind() {
        let e = AppError::ConnectTimeout {
            phase: "tunnel_authenticating".into(),
            secs: 30,
        };
        assert_eq!(e.kind(), "connectTimeout");
        assert!(e.to_string().contains("tunnel_authenticating"));
        assert!(e.to_string().contains("30s"));
    }

    /// Minimal connect request builder for the reconnect-spec tests below.
    fn req_with_ssh(ssh: Option<SshRequest>) -> ConnectRequest {
        ConnectRequest {
            profile_id: Some("prof".into()),
            driver: DriverKind::Mysql,
            host: "db.internal".into(),
            port: 3306,
            user: "app".into(),
            password: "secret".into(),
            database: None,
            ssh,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            read_only: false,
            skip_history: false,
        }
    }

    #[test]
    fn reconnect_ssh_from_is_none_without_ssh() {
        // A direct (non-tunneled) session has nothing to rebuild.
        assert!(reconnect_ssh_from(&req_with_ssh(None)).is_none());
    }

    #[test]
    fn reconnect_ssh_from_captures_endpoint_and_blanks_secrets() {
        let ssh = SshRequest {
            host: "bastion".into(),
            port: 2222,
            user: "tunnel".into(),
            auth_method: SshAuthMethod::Password,
            private_key_path: std::path::PathBuf::from("/keys/id"),
            passphrase: "phrase".into(),
            password: "pw".into(),
        };
        let cfg = reconnect_ssh_from(&req_with_ssh(Some(ssh))).expect("tunneled -> Some");
        // Non-secret SSH parameters are captured verbatim...
        assert_eq!(cfg.host, "bastion");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.user, "tunnel");
        assert_eq!(cfg.auth_method, SshAuthMethod::Password);
        assert_eq!(cfg.private_key_path, std::path::PathBuf::from("/keys/id"));
        // ...the remote endpoint comes from the DB host/port (what the tunnel
        // forwards to), not the SSH host...
        assert_eq!(cfg.remote_host, "db.internal");
        assert_eq!(cfg.remote_port, 3306);
        // ...and secrets are deliberately dropped (re-resolved from keyring at
        // reconnect time), so nothing sensitive lingers on the session (#712).
        assert!(cfg.passphrase.is_empty());
        assert!(cfg.password.is_empty());
    }
}
