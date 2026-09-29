//! サーバ側メッセージ (PostgreSQL の NOTICE / WARNING など) の捕捉 (#1165)。
//!
//! sqlx (postgres) は `NoticeResponse` を受け取ると、ユーザ向けのコールバックを
//! 持たず、`sqlx::postgres::notice` ターゲットの `tracing` イベントとして流すだけ
//! で捨てる。接続へフックを差し込む公開 API が無いため、そのイベントを拾う
//! `tracing` の [`Layer`] ([`NoticeCaptureLayer`]) を登録し、**実行中の文に紐づく
//! tokio の task-local バッファ**へ書き込む。
//!
//! 紐づけ (どの文のメッセージか) は task-local で行う。sqlx がイベントを出すのは
//! 呼び出し側の future を poll している最中 (= [`capture`] のスコープ内) なので、
//! 並行して走る別セッション・別文のメッセージが混ざらない。プールのバックグラウンド
//! タスクなどスコープ外で出たイベントは黙って捨てる。
//!
//! 通知はサーバが「その文の応答の途中」で送るため、ある文の通知は基本的にその文の
//! 結果に載る。ただし通知が次の読み取りまで接続のバッファに残った場合は、その接続で
//! 次に走る文の結果に載ることがある (best-effort)。

use std::future::Future;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use super::types::{ServerMessage, ServerMessageSeverity};

/// sqlx-postgres が NOTICE を流す `tracing` のターゲット名。
pub const NOTICE_TARGET: &str = "sqlx::postgres::notice";

/// 1 回の実行で保持する最大件数。ループ内の `RAISE NOTICE` などで際限なく膨らんで
/// IPC ペイロードとメモリを圧迫しないための上限。
pub const MAX_SERVER_MESSAGES: usize = 200;

type Buffer = Arc<Mutex<Vec<ServerMessage>>>;

tokio::task_local! {
    static CAPTURE: Buffer;
}

/// `fut` を実行しながら、その間に届いた NOTICE を集めて出力とともに返す。
pub async fn capture<F: Future>(fut: F) -> (F::Output, Vec<ServerMessage>) {
    let buffer: Buffer = Arc::new(Mutex::new(Vec::new()));
    let output = CAPTURE.scope(buffer.clone(), fut).await;
    let messages = match buffer.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    };
    (output, messages)
}

/// `tracing` のレベルを正規化した重大度へ写す。sqlx は PostgreSQL の severity を
/// FATAL/PANIC/ERROR → ERROR、WARNING → WARN、NOTICE → INFO、それ以外 (DEBUG /
/// INFO / LOG) → DEBUG / TRACE のレベルで流す。
pub fn severity_from_level(level: &Level) -> ServerMessageSeverity {
    if *level == Level::ERROR {
        ServerMessageSeverity::Error
    } else if *level == Level::WARN {
        ServerMessageSeverity::Warning
    } else if *level == Level::INFO {
        ServerMessageSeverity::Notice
    } else {
        ServerMessageSeverity::Info
    }
}

/// sqlx の NOTICE イベントを現在の [`capture`] スコープのバッファへ積む Layer。
/// `lib.rs::run()` で、このターゲットだけを通す per-layer フィルタ付きで登録する
/// (ログ出力側の `sqlx=warn` フィルタとは独立に NOTICE を受け取るため)。
pub struct NoticeCaptureLayer;

#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" && self.message.is_none() {
            self.message = Some(format!("{value:?}"));
        }
    }
}

impl<S: Subscriber> Layer<S> for NoticeCaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        if meta.target() != NOTICE_TARGET {
            return;
        }
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let Some(text) = visitor.message else {
            return;
        };
        let severity = severity_from_level(meta.level());
        // スコープ外 (プールのバックグラウンドタスク等) では try_with が Err。
        let _ = CAPTURE.try_with(|buffer| {
            let mut guard = match buffer.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if guard.len() < MAX_SERVER_MESSAGES {
                guard.push(ServerMessage { severity, text });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::prelude::*;

    fn emit_in_scope(buffer: &Buffer) {
        let subscriber = tracing_subscriber::registry().with(NoticeCaptureLayer);
        tracing::subscriber::with_default(subscriber, || {
            CAPTURE.sync_scope(buffer.clone(), || {
                tracing::event!(target: "sqlx::postgres::notice", Level::INFO, message = "hello");
                tracing::event!(target: "sqlx::postgres::notice", Level::WARN, message = "careful");
                tracing::event!(target: "sqlx::postgres::notice", Level::TRACE, message = "fyi");
                tracing::event!(target: "sqlx::postgres::notice", Level::ERROR, message = "bad");
                // 別ターゲットは無視する。
                tracing::event!(target: "sqlx::query", Level::INFO, message = "other");
            });
        });
    }

    #[test]
    fn captures_notice_events_with_severity() {
        let buffer: Buffer = Arc::new(Mutex::new(Vec::new()));
        emit_in_scope(&buffer);
        let got = buffer.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(
            got,
            vec![
                ServerMessage {
                    severity: ServerMessageSeverity::Notice,
                    text: "hello".into()
                },
                ServerMessage {
                    severity: ServerMessageSeverity::Warning,
                    text: "careful".into()
                },
                ServerMessage {
                    severity: ServerMessageSeverity::Info,
                    text: "fyi".into()
                },
                ServerMessage {
                    severity: ServerMessageSeverity::Error,
                    text: "bad".into()
                },
            ]
        );
    }

    #[test]
    fn events_outside_a_scope_are_dropped() {
        let subscriber = tracing_subscriber::registry().with(NoticeCaptureLayer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::event!(target: "sqlx::postgres::notice", Level::INFO, message = "lost");
        });
    }

    #[test]
    fn buffer_is_capped() {
        let buffer: Buffer = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(NoticeCaptureLayer);
        tracing::subscriber::with_default(subscriber, || {
            CAPTURE.sync_scope(buffer.clone(), || {
                for _ in 0..(MAX_SERVER_MESSAGES + 50) {
                    tracing::event!(target: "sqlx::postgres::notice", Level::INFO, message = "n");
                }
            });
        });
        let len = buffer.lock().map(|g| g.len()).unwrap_or(0);
        assert_eq!(len, MAX_SERVER_MESSAGES);
    }

    #[tokio::test]
    async fn capture_returns_output_and_empty_messages_by_default() {
        let (out, msgs) = capture(async { 7 }).await;
        assert_eq!(out, 7);
        assert!(msgs.is_empty());
    }
}
