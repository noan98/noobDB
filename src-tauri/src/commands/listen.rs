//! PostgreSQL の `LISTEN` / `NOTIFY` リアルタイム監視 (#2019、Epic #2011)。
//!
//! セッションの接続設定 (SSH / SSM 経由ならトンネルのローカルポート) から**専用接続を 1 本**
//! 開き、sqlx の `PgListener` で `LISTEN` する。受信した通知 (チャンネル / payload / 送信 PID /
//! 時刻) は、フロントが `invoke` 前に作って渡す Tauri Channel (`PgListenMessage`) へ流す。
//!
//! - 読み取りのみ: `LISTEN` はサーバの状態を変えず書き込みでもないので、`read_only`
//!   セッションでも使える。`NOTIFY` の送信機能は持たない。
//! - チャンネルの追加・削除は `pg_listen_add_channel` / `pg_listen_remove_channel` (稼働中の
//!   タスクへ制御メッセージを送る)。停止は共通の `cancel_stream(stream_id)`。
//! - タスクは `cancel_stream`・セッション切断 (`AppState::remove`)・画面側 Channel の閉鎖の
//!   いずれかで終わり、専用接続も一緒に閉じるので、リスナがサーバに残らない。
//! - PostgreSQL 以外のドライバは `unsupported` (理由コード `unsupported_driver`) で縮退する。
//! - 接続オプション (パスワードを含む) はログに出さない。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};

use crate::db::pg_listen::{truncate_payload, validate_channel, MAX_CHANNELS};
use crate::db::{postgres, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{AppState, PgListenControl, PgListenerEntry, StreamHandle, StreamKind};

/// チャンネルの追加・削除の応答を待つ上限。
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

/// `start_pg_listen` が Channel へ送るメッセージ。`kind` タグ付きで、フロントの
/// `listenPgListenStream` が受ける。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PgListenMessage {
    /// 専用接続を確立し、初期チャンネルの購読を始めた。
    Started { channels: Vec<String> },
    /// 通知 1 件。`payload` は表示用に切り詰め済みで、切り詰めたら `payload_truncated`。
    Notification {
        channel: String,
        payload: String,
        payload_truncated: bool,
        /// 通知を送ったバックエンドプロセスの PID。
        pid: u32,
        /// 受信時刻 (UNIX エポックからのミリ秒)。
        received_at_ms: u64,
    },
    /// 専用接続が切れて張り直した。切断中の通知は届かない (NOTIFY は永続化されない)。
    Reconnected {},
    /// 非対応ドライバ (PostgreSQL 以外)。`reason` は理由コード (`unsupported_driver`)。
    Unsupported { reason: String },
    /// 接続できない / 再接続に失敗したなどで監視を終えた。
    Error {
        error: String,
        connection_lost: bool,
    },
    /// `cancel_stream` / セッション切断で止めた。`delivered_rows` は流した通知の件数。
    Cancelled { delivered_rows: u64 },
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn check_channel(name: &str) -> Result<()> {
    validate_channel(name)
        .map(|_| ())
        .map_err(|m| AppError::InvalidInput(m.to_string()))
}

/// 専用接続を開いて `LISTEN` を始める。通知は `on_event` へ流れ続け、停止は
/// `cancel_stream(stream_id)`。非対応ドライバには `unsupported` を 1 通送って終わる。
#[tauri::command]
pub async fn start_pg_listen(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    channels: Vec<String>,
    on_event: Channel<PgListenMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    if session.conn.driver_kind() != DriverKind::Postgres {
        let _ = on_event.send(PgListenMessage::Unsupported {
            reason: "unsupported_driver".into(),
        });
        return Ok(());
    }
    if channels.len() > MAX_CHANNELS {
        return Err(AppError::InvalidInput(format!(
            "too many channels (max {MAX_CHANNELS})"
        )));
    }
    let mut initial: Vec<String> = Vec::new();
    for ch in channels {
        check_channel(&ch)?;
        if !initial.contains(&ch) {
            initial.push(ch);
        }
    }

    let delivered = Arc::new(AtomicU64::new(0));
    let (control_tx, control_rx) = mpsc::unbounded_channel::<PgListenControl>();
    let cancel_channel = on_event.clone();
    let task_stream_id = stream_id.clone();
    let task_delivered = delivered.clone();
    // register_stream をタスク本体より前に完了させるためのゲート (`run_query_stream` と同じ)。
    let (ready_tx, ready_rx) = oneshot::channel::<u64>();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        run_listener(
            &session.connect_options,
            &session.id,
            initial,
            // 受け手 (画面) が居なくなったら送信が失敗する。`false` を返してリスナを終える。
            move |message| on_event.send(message).is_ok(),
            control_rx,
            task_delivered,
        )
        .await;
        if let Some(state) = app.try_state::<AppState>() {
            state.forget_pg_listener(&task_stream_id, token);
            state.forget_stream(&task_stream_id, token).await;
        }
    });
    let token = state
        .register_stream(
            stream_id.clone(),
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: delivered,
                kind: StreamKind::Listen,
                on_cancel: Some(Box::new(move |delivered_rows| {
                    let _ = cancel_channel.send(PgListenMessage::Cancelled { delivered_rows });
                })),
            },
        )
        .await;
    state.register_pg_listener(
        stream_id,
        PgListenerEntry {
            token,
            session_id,
            control: control_tx,
        },
    );
    let _ = ready_tx.send(token);
    Ok(())
}

/// 監視タスク本体。終了理由は終端メッセージ (`error`) か、外からの abort。
/// `send` は 1 通ずつ届ける関数で、受け手が居なくなったら `false` を返す (実運用では Tauri の
/// Channel、統合テストではただのキュー)。
pub async fn run_listener(
    opts: &crate::db::DbConnectOptions,
    session_id: &str,
    initial: Vec<String>,
    send: impl Fn(PgListenMessage) -> bool,
    mut control: mpsc::UnboundedReceiver<PgListenControl>,
    delivered: Arc<AtomicU64>,
) {
    let fail = |e: AppError| {
        tracing::warn!(session_id = %session_id, kind = e.kind(), "pg listen ended with an error");
        let _ = send(PgListenMessage::Error {
            connection_lost: e.is_connection_lost(),
            error: e.to_string(),
        });
    };
    let mut listener = match postgres::open_listener(opts).await {
        Ok(l) => l,
        Err(e) => return fail(e),
    };
    let mut channels: Vec<String> = Vec::new();
    for ch in &initial {
        if let Err(e) = listener.listen(ch).await {
            return fail(e.into());
        }
        channels.push(ch.clone());
    }
    if !send(PgListenMessage::Started {
        channels: channels.clone(),
    }) {
        return;
    }
    loop {
        tokio::select! {
            ctl = control.recv() => {
                let Some(ctl) = ctl else { return };
                match ctl {
                    PgListenControl::Add { channel, reply } => {
                        let result = if channels.contains(&channel) {
                            Ok(())
                        } else if channels.len() >= MAX_CHANNELS {
                            Err(AppError::InvalidInput(format!("too many channels (max {MAX_CHANNELS})")))
                        } else {
                            listener.listen(&channel).await.map_err(AppError::from)
                        };
                        if result.is_ok() && !channels.contains(&channel) {
                            channels.push(channel);
                        }
                        let _ = reply.send(result);
                    }
                    PgListenControl::Remove { channel, reply } => {
                        let result = listener.unlisten(&channel).await.map_err(AppError::from);
                        if result.is_ok() {
                            channels.retain(|c| c != &channel);
                        }
                        let _ = reply.send(result);
                    }
                }
            }
            received = listener.try_recv() => {
                match received {
                    Ok(Some(n)) => {
                        let (payload, payload_truncated) = truncate_payload(n.payload());
                        delivered.fetch_add(1, Ordering::SeqCst);
                        let sent = send(PgListenMessage::Notification {
                            channel: n.channel().to_string(),
                            payload,
                            payload_truncated,
                            pid: n.process_id(),
                            received_at_ms: now_ms(),
                        });
                        if !sent {
                            // 受け手 (画面) が居なくなった。リスナを残さず終える。
                            return;
                        }
                    }
                    Ok(None) => {
                        if !send(PgListenMessage::Reconnected {}) {
                            return;
                        }
                    }
                    Err(e) => return fail(e.into()),
                }
            }
        }
    }
}

async fn send_control(
    state: &AppState,
    stream_id: &str,
    make: impl FnOnce(oneshot::Sender<Result<()>>) -> PgListenControl,
) -> Result<()> {
    let control = state
        .pg_listener_control(stream_id)
        .ok_or_else(|| AppError::InvalidInput("the listener is not running".into()))?;
    let (reply_tx, reply_rx) = oneshot::channel();
    control
        .send(make(reply_tx))
        .map_err(|_| AppError::InvalidInput("the listener is not running".into()))?;
    match tokio::time::timeout(CONTROL_TIMEOUT, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(AppError::InvalidInput("the listener is not running".into())),
        Err(_) => Err(AppError::Timeout(CONTROL_TIMEOUT.as_secs())),
    }
}

/// 稼働中の監視にチャンネルを追加して `LISTEN` する。既に購読中なら何もしない。
#[tauri::command]
pub async fn pg_listen_add_channel(
    stream_id: String,
    channel: String,
    state: State<'_, AppState>,
) -> Result<()> {
    check_channel(&channel)?;
    send_control(state.inner(), &stream_id, |reply| PgListenControl::Add {
        channel,
        reply,
    })
    .await
}

/// 稼働中の監視からチャンネルを外して `UNLISTEN` する。
#[tauri::command]
pub async fn pg_listen_remove_channel(
    stream_id: String,
    channel: String,
    state: State<'_, AppState>,
) -> Result<()> {
    check_channel(&channel)?;
    send_control(state.inner(), &stream_id, |reply| PgListenControl::Remove {
        channel,
        reply,
    })
    .await
}
