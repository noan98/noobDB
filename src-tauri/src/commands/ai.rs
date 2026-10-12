//! AI 基盤 (#690) の IPC コマンド。
//!
//! - `set_ai_api_key` / `has_ai_api_key`: API キーは OS keyring のみ (`ai/anthropic_api_key`)。
//!   値を返す IPC は無く、`has_ai_api_key` は bool だけ返す。
//! - `run_ai_request`: ストリーミング要求 (任意の `format` で構造化出力 JSON Schema を指定可)。結果は
//!   フロントが `invoke` 前に作って渡す Tauri Channel (`AiStreamMessage`) で届く (#1534。クエリ結果の
//!   #1096 と同じ方式)。`cancel_stream` で中断でき、その通知も同じ Channel の `cancelled` で届く。
//! - `test_ai_connection`: 短い非ストリーミング要求で疎通を確認する。
//!
//! モデル・エフォートは呼び出し側から直接受け取らず、「タスク種別 + 設定スナップショット」
//! から `ai::models` の純関数で解決する。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::ai::client::{
    run_once_with, run_streaming_with, AiCompletion, ReqwestTransport, RetryPolicy,
};
use crate::ai::models::{resolve_effort, resolve_model, AiSettingsSnapshot, AiTaskKind};
use crate::ai::request::{AiChatMessage, AiChatRole, AiRequestSpec, DEFAULT_MAX_TOKENS};
use crate::ai::sse::AiUsage;
use crate::ai::usage::{self, AiUsageRecord};
use crate::error::{AppError, Result};
use crate::profiles::secrets;
use crate::state::{AppState, StreamHandle, StreamKind};

/// ユーザプロンプト / system の上限 (バイト)。巨大なスキーマ丸ごと送信などの事故を防ぐ。
const MAX_PROMPT_BYTES: usize = 1024 * 1024;
/// 会話履歴の発言数の上限 (user / assistant 合わせて)。フロントは直近 5 往復 (10 件) に絞る
/// ので、それを超える入力は組み立て側の不具合として拒否する (#1471)。
const MAX_HISTORY_MESSAGES: usize = 20;
/// 接続テストの全体タイムアウト。
const TEST_TIMEOUT_SECS: u64 = 60;
/// 接続テストの `max_tokens`。thinking が常時オンなので小さすぎると本文が出ない。
const TEST_MAX_TOKENS: u32 = 1024;
const TEST_PROMPT: &str = "Reply with the single word: ok";

/// `run_ai_request` が Channel へ送るメッセージ (#1534)。`kind` タグ付きで、フロントの
/// `listenAiStream` が受ける。Channel は 1 回の要求に紐づくので `stream_id` は載せない
/// (グローバルイベントだった頃は、全リスナーに配られて各自が `streamId` で捨てていた)。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiStreamMessage {
    /// 本文の差分。
    Delta { text: String },
    /// 429 / 529 を受けて、`delay_ms` 待ってから再試行する (ストリーム開始前のみ)。
    Retrying {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
    },
    Done {
        /// 実際に応答したモデル。フォールバックが働くと `requested_model` と異なる。
        model: String,
        requested_model: String,
        fallback_used: bool,
        stop_reason: String,
        usage: AiUsage,
    },
    Error {
        error: String,
        /// `AppError::kind()` (例: `aiRefused` / `aiAuth` / `aiNetwork` / `aiApi` / `aiOverloaded`)。
        /// タグ名 `kind` と衝突するので `errorKind` として送る。
        error_kind: String,
    },
    /// `cancel_stream` による中断。`delivered_rows` は送信済みの本文差分の件数。
    Cancelled { delivered_rows: u64 },
}

/// 接続テストの結果の区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiConnectionStatus {
    Success,
    AuthError,
    NetworkError,
    ApiError,
    /// 混雑 (429 / 529)。一時的なので API エラーとは文言を分ける。
    Overloaded,
    Refused,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub status: AiConnectionStatus,
    /// 成功時は応答本文 (短縮)、失敗時はエラーメッセージ。API キーは含まない。
    pub message: String,
    /// 応答したモデル (成功時のみ)。
    pub model: Option<String>,
    pub elapsed_ms: u64,
}

/// 接続テストの結果へ分類する。認証 / ネットワーク / 成功 / その他を区別する。
pub fn classify_connection_test(
    result: std::result::Result<AiCompletion, AppError>,
    elapsed_ms: u64,
) -> Result<AiConnectionTestResult> {
    let (status, message, model) = match result {
        Ok(done) => {
            let text: String = done.text.trim().chars().take(200).collect();
            (AiConnectionStatus::Success, text, Some(done.model))
        }
        Err(e @ AppError::AiAuth(_)) => (AiConnectionStatus::AuthError, e.to_string(), None),
        Err(e @ AppError::AiNetwork(_)) => (AiConnectionStatus::NetworkError, e.to_string(), None),
        Err(e @ AppError::AiRefused(_)) => (AiConnectionStatus::Refused, e.to_string(), None),
        Err(e @ AppError::AiOverloaded(_)) => (AiConnectionStatus::Overloaded, e.to_string(), None),
        Err(e @ AppError::AiApi(_)) => (AiConnectionStatus::ApiError, e.to_string(), None),
        // keyring 障害など、AI 呼び出し以外の失敗は結果の区分にせず IPC エラーとして返す。
        Err(e) => return Err(e),
    };
    Ok(AiConnectionTestResult {
        status,
        message,
        model,
        elapsed_ms,
    })
}

fn require_enabled(settings: &AiSettingsSnapshot) -> Result<()> {
    if settings.enabled {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "AI features are disabled in settings".into(),
        ))
    }
}

fn require_api_key() -> Result<String> {
    secrets::get_ai_api_key()?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| AppError::AiAuth("no API key is configured".into()))
}

/// 構造化出力の指定 (`output_config.format`) を検証し、`type` / `schema` だけで組み直す。
/// `{ "type": "json_schema", "schema": {...} }` の形だけを通し、他のキーは API へ素通しさせない。
fn validate_format(format: &serde_json::Value) -> Result<serde_json::Value> {
    let schema = format
        .get("schema")
        .filter(|v| v.is_object())
        .filter(|_| format.get("type").and_then(|v| v.as_str()) == Some("json_schema"));
    match schema {
        Some(schema) => Ok(serde_json::json!({ "type": "json_schema", "schema": schema })),
        None => Err(AppError::InvalidInput(
            "format must be { \"type\": \"json_schema\", \"schema\": {...} }".into(),
        )),
    }
}

/// 会話履歴を検証する (#1471)。user 始まり・user / assistant 交互・assistant 終わり
/// (続けて今回の user プロンプトが付く) で、各発言が空でなく、件数が上限以内であること。
fn validate_history(history: &[AiChatMessage]) -> Result<()> {
    let invalid = |msg: &str| Err(AppError::InvalidInput(msg.into()));
    if history.len() > MAX_HISTORY_MESSAGES {
        return invalid("the conversation history is too long");
    }
    if history.len() % 2 != 0 {
        return invalid("the conversation history must end with an assistant message");
    }
    for (i, m) in history.iter().enumerate() {
        let expected = if i % 2 == 0 {
            AiChatRole::User
        } else {
            AiChatRole::Assistant
        };
        if m.role != expected {
            return invalid("the conversation history must alternate user and assistant");
        }
        if m.content.trim().is_empty() {
            return invalid("the conversation history has an empty message");
        }
    }
    Ok(())
}

/// system / prompt / 履歴を合算したバイト数が上限以内か。
fn within_prompt_limit(
    prompt: &str,
    system: Option<&str>,
    system_cached: Option<&str>,
    history: &[AiChatMessage],
) -> bool {
    let total = prompt.len()
        + system.map_or(0, str::len)
        + system_cached.map_or(0, str::len)
        + history.iter().map(|m| m.content.len()).sum::<usize>();
    total <= MAX_PROMPT_BYTES
}

// 要求仕様の各項目をそのまま受ける組み立て関数で、構造体に包むと呼び出し側が冗長になるため許容する。
#[allow(clippy::too_many_arguments)]
fn build_spec(
    task: AiTaskKind,
    settings: &AiSettingsSnapshot,
    system: Option<String>,
    system_cached: Option<String>,
    history: Vec<AiChatMessage>,
    prompt: String,
    max_tokens: u32,
    stream: bool,
    format: Option<serde_json::Value>,
) -> AiRequestSpec {
    AiRequestSpec {
        model: resolve_model(task, settings),
        effort: resolve_effort(task, settings),
        system,
        system_cached,
        history,
        prompt,
        max_tokens,
        stream,
        format,
    }
}

/// API キーを設定 / 削除する。`None` = 変更なし、`Some("")` = 削除、`Some(v)` = 設定。
/// 値はログにも戻り値にも出さない。
#[tauri::command]
pub async fn set_ai_api_key(key: Option<String>) -> Result<()> {
    match key {
        None => Ok(()),
        Some(k) if k.is_empty() => secrets::delete_ai_api_key(),
        Some(k) => {
            let trimmed = k.trim();
            if trimmed.is_empty() {
                return Err(AppError::InvalidInput("the API key is blank".into()));
            }
            secrets::set_ai_api_key(trimmed)
        }
    }
}

/// API キーが保存済みか (値は返さない)。
#[tauri::command]
pub async fn has_ai_api_key() -> Result<bool> {
    Ok(secrets::has_ai_api_key())
}

/// AI 使用量の台帳 (日 × タスク × モデルのトークン数、#1540) を返す。数値のみで、
/// API キーや送信内容は含まれない。概算コストはフロントが単価表で計算する。
#[tauri::command]
pub async fn get_ai_usage_history() -> Result<Vec<AiUsageRecord>> {
    usage::load_all()
}

/// AI 使用量の台帳を空にする。
#[tauri::command]
pub async fn clear_ai_usage_history() -> Result<()> {
    usage::clear()
}

/// AI へのストリーミング要求。結果は `ai-stream:*` イベントで届く。
// Tauri コマンドの引数は IPC の形そのもの (app/state は注入) で、まとめると呼び出し側の契約が変わるため許容する。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_ai_request(
    app: AppHandle,
    stream_id: String,
    task: AiTaskKind,
    system: Option<String>,
    prompt: String,
    settings: AiSettingsSnapshot,
    format: Option<serde_json::Value>,
    system_cached: Option<String>,
    history: Option<Vec<AiChatMessage>>,
    // フロントが `invoke` 前に生成して渡す Tauri Channel (#1534)。
    on_event: Channel<AiStreamMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    require_enabled(&settings)?;
    let history = history.unwrap_or_default();
    validate_history(&history)?;
    let format = format.as_ref().map(validate_format).transpose()?;
    if prompt.trim().is_empty() {
        return Err(AppError::InvalidInput("the prompt is empty".into()));
    }
    if !within_prompt_limit(
        &prompt,
        system.as_deref(),
        system_cached.as_deref(),
        &history,
    ) {
        return Err(AppError::InvalidInput("the prompt is too large".into()));
    }
    let api_key = require_api_key()?;
    let spec = build_spec(
        task,
        &settings,
        system,
        system_cached,
        history,
        prompt,
        DEFAULT_MAX_TOKENS,
        true,
        format,
    );
    let transport = ReqwestTransport::new()?;

    let delivered = Arc::new(AtomicU64::new(0));
    // register_stream をタスク本体より前に完了させるゲート (script.rs と同じ理由)。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let task_stream_id = stream_id.clone();
    let task_delivered = delivered.clone();
    let task_app = app.clone();
    // `Channel` は内部 `Arc` の clone なので軽い。タスク本体用と `cancel_stream` 用の 2 系統。
    let cancel_channel = on_event.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        let counter = task_delivered.clone();
        let delta_channel = on_event.clone();
        let retry_channel = on_event.clone();
        let result = run_streaming_with(
            &transport,
            &api_key,
            &spec,
            &RetryPolicy::DEFAULT,
            |notice| {
                let _ = retry_channel.send(AiStreamMessage::Retrying {
                    attempt: notice.attempt,
                    max_attempts: notice.max_attempts,
                    delay_ms: notice.delay.as_millis() as u64,
                });
            },
            |text| {
                counter.fetch_add(1, Ordering::SeqCst);
                if let Err(e) = delta_channel.send(AiStreamMessage::Delta {
                    text: text.to_string(),
                }) {
                    tracing::warn!(error = %e, "failed to send ai delta");
                }
            },
        )
        .await;
        let message = match result {
            Ok(done) => {
                // 使用量台帳 (#1540): 数値のみ。中断 / エラーは使用量が確定しないので記録しない。
                usage::record(task, &done.model, &done.usage);
                AiStreamMessage::Done {
                    model: done.model,
                    requested_model: done.requested_model,
                    fallback_used: done.fallback_used,
                    stop_reason: done.stop_reason,
                    usage: done.usage,
                }
            }
            Err(e) => {
                tracing::warn!(stream_id = %task_stream_id, kind = e.kind(), "ai request failed");
                AiStreamMessage::Error {
                    error: e.to_string(),
                    error_kind: e.kind().to_string(),
                }
            }
        };
        if let Err(e) = on_event.send(message) {
            tracing::warn!(stream_id = %task_stream_id, error = %e, "failed to send ai terminal message");
        }
        task_app
            .state::<AppState>()
            .forget_stream(&task_stream_id, token)
            .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: delivered,
                kind: StreamKind::Ai,
                on_cancel: Some(Box::new(move |delivered_rows| {
                    let _ = cancel_channel.send(AiStreamMessage::Cancelled { delivered_rows });
                })),
            },
        )
        .await;
    let _ = ready_tx.send(token);
    Ok(())
}

/// 短い非ストリーミング要求で疎通を確認する。認証エラー / ネットワークエラー / 成功を
/// 区別して返す (AI 呼び出し由来の失敗は `Err` ではなく `status` で返す)。
#[tauri::command]
pub async fn test_ai_connection(settings: AiSettingsSnapshot) -> Result<AiConnectionTestResult> {
    require_enabled(&settings)?;
    let started = Instant::now();
    let outcome = async {
        let api_key = require_api_key()?;
        let transport = ReqwestTransport::new()?;
        let spec = build_spec(
            AiTaskKind::ConnectionTest,
            &settings,
            None,
            None,
            Vec::new(),
            TEST_PROMPT.to_string(),
            TEST_MAX_TOKENS,
            false,
            None,
        );
        match tokio::time::timeout(
            Duration::from_secs(TEST_TIMEOUT_SECS),
            // 接続テストは待たせず、混雑 (429/529) も即座に結果として見せる。
            run_once_with(&transport, &api_key, &spec, &RetryPolicy::NONE),
        )
        .await
        {
            Ok(r) => {
                if let Ok(done) = &r {
                    usage::record(AiTaskKind::ConnectionTest, &done.model, &done.usage);
                }
                r
            }
            Err(_) => Err(AppError::AiNetwork(format!(
                "no response within {TEST_TIMEOUT_SECS}s"
            ))),
        }
    }
    .await;
    classify_connection_test(outcome, started.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(text: &str) -> AiCompletion {
        AiCompletion {
            text: text.into(),
            model: "claude-opus-5-5".into(),
            requested_model: "claude-opus-5-5".into(),
            fallback_used: false,
            stop_reason: "end_turn".into(),
            usage: AiUsage::default(),
        }
    }

    #[test]
    fn classifies_success_auth_network_api_refused() {
        let ok = classify_connection_test(Ok(done(" ok \n")), 12).unwrap();
        assert_eq!(ok.status, AiConnectionStatus::Success);
        assert_eq!(ok.message, "ok");
        assert_eq!(ok.model.as_deref(), Some("claude-opus-5-5"));

        let cases = [
            (AppError::AiAuth("x".into()), AiConnectionStatus::AuthError),
            (
                AppError::AiNetwork("x".into()),
                AiConnectionStatus::NetworkError,
            ),
            (AppError::AiApi("x".into()), AiConnectionStatus::ApiError),
            (
                AppError::AiOverloaded("x".into()),
                AiConnectionStatus::Overloaded,
            ),
            (AppError::AiRefused("x".into()), AiConnectionStatus::Refused),
        ];
        for (err, want) in cases {
            let r = classify_connection_test(Err(err), 1).unwrap();
            assert_eq!(r.status, want);
            assert!(r.model.is_none());
        }
    }

    #[test]
    fn stream_messages_serialize_with_kind_tag_and_camel_case() {
        let v = |m: AiStreamMessage| serde_json::to_value(m).unwrap();
        assert_eq!(
            v(AiStreamMessage::Delta { text: "a".into() }),
            serde_json::json!({ "kind": "delta", "text": "a" })
        );
        assert_eq!(
            v(AiStreamMessage::Retrying {
                attempt: 1,
                max_attempts: 3,
                delay_ms: 1000
            }),
            serde_json::json!({ "kind": "retrying", "attempt": 1, "maxAttempts": 3, "delayMs": 1000 })
        );
        assert_eq!(
            v(AiStreamMessage::Error {
                error: "e".into(),
                error_kind: "aiOverloaded".into()
            }),
            serde_json::json!({ "kind": "error", "error": "e", "errorKind": "aiOverloaded" })
        );
        assert_eq!(
            v(AiStreamMessage::Cancelled { delivered_rows: 2 }),
            serde_json::json!({ "kind": "cancelled", "deliveredRows": 2 })
        );
    }

    #[test]
    fn non_ai_errors_stay_ipc_errors() {
        assert!(classify_connection_test(Err(AppError::Keyring("x".into())), 1).is_err());
    }

    #[test]
    fn format_validation_accepts_only_json_schema() {
        let ok = serde_json::json!({ "type": "json_schema", "schema": { "type": "object" } });
        assert!(validate_format(&ok).is_ok());
        let extra = serde_json::json!({ "type": "json_schema", "schema": {}, "evil": 1 });
        let rebuilt = validate_format(&extra).unwrap();
        assert!(rebuilt.get("evil").is_none());
        assert_eq!(rebuilt["type"], "json_schema");
        for bad in [
            serde_json::json!({ "type": "text" }),
            serde_json::json!({ "type": "json_schema" }),
            serde_json::json!({ "type": "json_schema", "schema": "x" }),
            serde_json::json!("json_schema"),
        ] {
            assert!(validate_format(&bad).is_err(), "{bad}");
        }
    }

    fn m(role: &str, content: &str) -> AiChatMessage {
        AiChatMessage {
            role: if role == "user" {
                AiChatRole::User
            } else {
                AiChatRole::Assistant
            },
            content: content.into(),
        }
    }

    #[test]
    fn history_validation_accepts_alternating_pairs_and_empty() {
        assert!(validate_history(&[]).is_ok());
        assert!(validate_history(&[m("user", "q"), m("assistant", "a")]).is_ok());
        assert!(validate_history(&[
            m("user", "q1"),
            m("assistant", "a1"),
            m("user", "q2"),
            m("assistant", "a2"),
        ])
        .is_ok());
    }

    #[test]
    fn history_validation_rejects_bad_shapes() {
        // user で終わる / assistant 始まり / 同じ role の連続 / 空 / 長すぎる (不明な role は serde が拒否)。
        assert!(validate_history(&[m("user", "q")]).is_err());
        assert!(validate_history(&[m("assistant", "a"), m("user", "q")]).is_err());
        assert!(validate_history(&[m("user", "q"), m("user", "q2")]).is_err());
        assert!(validate_history(&[m("user", " "), m("assistant", "a")]).is_err());
        let long: Vec<AiChatMessage> = (0..=MAX_HISTORY_MESSAGES)
            .map(|i| m(if i % 2 == 0 { "user" } else { "assistant" }, "x"))
            .collect();
        assert!(validate_history(&long).is_err());
    }

    #[test]
    fn prompt_limit_includes_history() {
        let half = "a".repeat(MAX_PROMPT_BYTES / 2);
        assert!(within_prompt_limit(&half, None, None, &[]));
        let history = [m("user", &half), m("assistant", "ok")];
        assert!(!within_prompt_limit(&half, None, None, &history));
        assert!(!within_prompt_limit(
            "p",
            Some(&half),
            Some(&half),
            &history
        ));
        assert!(within_prompt_limit("p", None, None, &history));
    }

    #[test]
    fn disabled_settings_are_rejected() {
        let s: AiSettingsSnapshot = serde_json::from_value(serde_json::json!({
            "enabled": false, "defaultModel": "claude-opus-5-5"
        }))
        .unwrap();
        assert!(require_enabled(&s).is_err());
    }
}
