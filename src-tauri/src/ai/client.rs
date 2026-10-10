//! Anthropic Messages API クライアント (#690)。
//!
//! HTTP 層は `AiTransport` / `AiBody` でスタブ可能にしてあり、リクエスト・SSE・refusal・
//! エラー分類のロジックは実 API 無しで単体テストできる。本番の実装は `ReqwestTransport`。
//!
//! API キーは引数で受け取り、ログにもエラーメッセージにも載せない。

use std::time::Duration;

use serde_json::Value;

use super::request::{build_body, static_headers, AiRequestSpec, API_URL};
use super::sse::{api_error, AiUsage, SseParser, StreamAccumulator, StreamStep};
use crate::error::{AppError, Result};

/// エラー応答の本文として読む上限 (巨大な HTML エラーページなどを抱え込まない)。
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// 応答ボディをチャンク単位で読む抽象。
// 公開トレイトの `async fn` は auto trait (Send) を呼び出し側へ漏らせない旨の lint が出る
// が、利用側は具体型 (`ReqwestTransport` / テスト用スタブ) で呼ぶので問題ない。
#[allow(async_fn_in_trait)]
pub trait AiBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>>;
}

pub struct AiHttpResponse<B> {
    pub status: u16,
    pub body: B,
}

/// `POST /v1/messages` を 1 回送る抽象 (本番は reqwest、テストはスタブ)。
#[allow(async_fn_in_trait)]
pub trait AiTransport {
    type Body: AiBody;
    async fn post(&self, api_key: &str, body: &Value) -> Result<AiHttpResponse<Self::Body>>;
}

/// 完了した 1 回の応答。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiCompletion {
    pub text: String,
    /// 実際に応答したモデル (フォールバックが働くと要求と異なりうる)。
    pub model: String,
    pub requested_model: String,
    pub fallback_used: bool,
    pub stop_reason: String,
    pub usage: AiUsage,
}

/// 応答の終端情報。ストリーミング / 非ストリーミングで共通。
struct Finish {
    text: String,
    model: Option<String>,
    stop_reason: Option<String>,
    /// refusal の `stop_details.category` (取れなければ `None`)。
    stop_category: Option<String>,
    /// 出力の途中でフォールバックが起きたか (`content_block` の `fallback`)。
    fallback_seen: bool,
    usage: AiUsage,
}

fn finish(spec: &AiRequestSpec, f: Finish) -> Result<AiCompletion> {
    let Finish {
        text,
        model,
        stop_reason,
        stop_category,
        fallback_seen,
        usage,
    } = f;
    let requested_model = spec.model.id().to_string();
    let model = model.unwrap_or_else(|| requested_model.clone());
    let stop_reason = stop_reason.unwrap_or_default();
    // refusal は成功扱いにせず必ず分岐してユーザに分かるエラーにする。
    if stop_reason == "refusal" {
        return Err(AppError::AiRefused(match stop_category {
            Some(c) => format!("model {model} declined to respond to this request (category: {c})"),
            None => format!("model {model} declined to respond to this request"),
        }));
    }
    Ok(AiCompletion {
        fallback_used: fallback_seen || model != requested_model,
        text,
        model,
        requested_model,
        stop_reason,
        usage,
    })
}

async fn read_limited<B: AiBody>(mut body: B, limit: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = body.next_chunk().await? {
        out.extend_from_slice(&chunk);
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    Ok(out)
}

/// 2xx 以外の応答を `AppError` へ分類する。401/403 は認証、それ以外は API エラー。
fn error_from_status(status: u16, body: &[u8]) -> AppError {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let (etype, message) = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .map(|e| {
            (
                e.get("type").and_then(Value::as_str).unwrap_or("error"),
                e.get("message").and_then(Value::as_str).unwrap_or(""),
            )
        })
        .unwrap_or(("error", ""));
    match status {
        401 | 403 => AppError::AiAuth(format!(
            "API key was rejected (HTTP {status}, {etype}){}",
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        )),
        _ => match api_error(etype, message) {
            // 認証系の種別が 401/403 以外で返ってきても分類は保つ。
            e @ AppError::AiAuth(_) => e,
            AppError::AiApi(m) => AppError::AiApi(format!("HTTP {status}: {m}")),
            other => other,
        },
    }
}

/// ストリーミング要求。本文の差分ごとに `on_delta` を呼び、完了時に `AiCompletion` を返す。
pub async fn run_streaming<T: AiTransport, F: FnMut(&str)>(
    transport: &T,
    api_key: &str,
    spec: &AiRequestSpec,
    mut on_delta: F,
) -> Result<AiCompletion> {
    let resp = transport.post(api_key, &build_body(spec)).await?;
    if !(200..300).contains(&resp.status) {
        let body = read_limited(resp.body, MAX_ERROR_BODY_BYTES).await?;
        return Err(error_from_status(resp.status, &body));
    }
    let mut body = resp.body;
    let mut parser = SseParser::new();
    let mut acc = StreamAccumulator::default();
    let mut stopped = false;
    'outer: while let Some(chunk) = body.next_chunk().await? {
        for ev in parser.feed(&chunk) {
            match acc.handle(&ev)? {
                StreamStep::Delta(t) => on_delta(&t),
                StreamStep::Stop => {
                    stopped = true;
                    break 'outer;
                }
                StreamStep::Nothing => {}
            }
        }
    }
    if !stopped {
        for ev in parser.finish() {
            match acc.handle(&ev)? {
                StreamStep::Delta(t) => on_delta(&t),
                StreamStep::Stop => stopped = true,
                StreamStep::Nothing => {}
            }
        }
    }
    if !stopped {
        return Err(AppError::AiApi(
            "the response stream ended before the message completed".into(),
        ));
    }
    finish(
        spec,
        Finish {
            text: acc.text,
            model: acc.fallback_model.or(acc.model),
            stop_reason: acc.stop_reason,
            stop_category: acc.stop_category,
            fallback_seen: acc.fallback_seen,
            usage: acc.usage,
        },
    )
}

/// 非ストリーミング要求 (接続テスト用)。`spec.stream` は false であること。
pub async fn run_once<T: AiTransport>(
    transport: &T,
    api_key: &str,
    spec: &AiRequestSpec,
) -> Result<AiCompletion> {
    let resp = transport.post(api_key, &build_body(spec)).await?;
    let status = resp.status;
    let bytes = read_limited(resp.body, 4 * 1024 * 1024).await?;
    if !(200..300).contains(&status) {
        return Err(error_from_status(status, &bytes));
    }
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::AiApi(format!("invalid response body: {e}")))?;
    let text = json
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    let mut usage = AiUsage::default();
    if let Some(u) = json.get("usage") {
        usage.merge(u);
    }
    finish(
        spec,
        Finish {
            text,
            model: json.get("model").and_then(Value::as_str).map(String::from),
            stop_reason: json
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(String::from),
            stop_category: json["stop_details"]
                .get("category")
                .and_then(Value::as_str)
                .map(String::from),
            fallback_seen: false,
            usage,
        },
    )
}

// --- 本番の HTTP 実装 -------------------------------------------------------

pub struct ReqwestBody(reqwest::Response);

impl AiBody for ReqwestBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        match self.0.chunk().await {
            Ok(c) => Ok(c.map(|b| b.to_vec())),
            Err(e) => Err(AppError::AiNetwork(e.without_url().to_string())),
        }
    }
}

pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self> {
        // reqwest の `rustls-no-provider` 構成は、プロセス既定の暗号プロバイダが未登録だと
        // Client 構築時に panic する (sqlx は既定に登録せず、updater は更新チェック時にしか
        // 登録しない)。更新チェック前でも安全なよう、updater と同じ ring をここで登録する。
        // 冪等で、すでに登録済みなら Err が返るだけなので無視してよい。
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // ストリームの無音がこれ以上続いたら諦める (全体の長さは制限しない)。
            .read_timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::AiNetwork(e.without_url().to_string()))?;
        Ok(Self { client })
    }
}

impl AiTransport for ReqwestTransport {
    type Body = ReqwestBody;

    async fn post(&self, api_key: &str, body: &Value) -> Result<AiHttpResponse<ReqwestBody>> {
        // キーはヘッダ値として不正な文字 (改行など) を含みうる。値自体はメッセージに出さない。
        let mut key = reqwest::header::HeaderValue::from_str(api_key).map_err(|_| {
            AppError::AiAuth(
                "the API key contains characters that cannot be sent in a header".into(),
            )
        })?;
        // デバッグ出力などにキーが現れないようにする。
        key.set_sensitive(true);
        let mut req = self.client.post(API_URL).header("x-api-key", key);
        for (k, v) in static_headers() {
            req = req.header(k, v);
        }
        match req.json(body).send().await {
            Ok(resp) => Ok(AiHttpResponse {
                status: resp.status().as_u16(),
                body: ReqwestBody(resp),
            }),
            // ヘッダ値として不正な文字を含むキー (改行など)。キー自体はメッセージに出さない。
            Err(e) if e.is_builder() => Err(AppError::AiAuth(
                "the API key contains characters that cannot be sent in a header".into(),
            )),
            Err(e) => Err(AppError::AiNetwork(e.without_url().to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::models::{AiEffort, AiModel};
    use std::sync::Mutex;

    struct StubBody(std::vec::IntoIter<Vec<u8>>);
    impl AiBody for StubBody {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
            Ok(self.0.next())
        }
    }

    struct Stub {
        status: u16,
        chunks: Vec<Vec<u8>>,
        sent: Mutex<Vec<(String, Value)>>,
        network_error: bool,
    }
    impl Stub {
        fn new(status: u16, chunks: Vec<&str>) -> Self {
            Self {
                status,
                chunks: chunks.into_iter().map(|c| c.as_bytes().to_vec()).collect(),
                sent: Mutex::new(Vec::new()),
                network_error: false,
            }
        }
    }
    impl AiTransport for Stub {
        type Body = StubBody;
        async fn post(&self, api_key: &str, body: &Value) -> Result<AiHttpResponse<StubBody>> {
            self.sent
                .lock()
                .unwrap()
                .push((api_key.to_string(), body.clone()));
            if self.network_error {
                return Err(AppError::AiNetwork("dns".into()));
            }
            Ok(AiHttpResponse {
                status: self.status,
                body: StubBody(self.chunks.clone().into_iter()),
            })
        }
    }

    fn spec(stream: bool) -> AiRequestSpec {
        AiRequestSpec {
            model: AiModel::Opus55,
            effort: AiEffort::Low,
            system: None,
            system_cached: None,
            prompt: "hi".into(),
            max_tokens: 100,
            stream,
            format: None,
        }
    }

    fn sse(parts: &[(&str, &str)]) -> Vec<String> {
        parts
            .iter()
            .map(|(e, d)| format!("event: {e}\ndata: {d}\n\n"))
            .collect()
    }

    const START: &str = r#"{"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":1}}}"#;

    #[tokio::test]
    async fn streaming_emits_deltas_and_done_with_usage() {
        let events = sse(&[
            ("message_start", START),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let mut deltas = Vec::new();
        let done = run_streaming(&stub, "k", &spec(true), |t| deltas.push(t.to_string()))
            .await
            .unwrap();
        assert_eq!(deltas, vec!["ok"]);
        assert_eq!(done.text, "ok");
        assert_eq!(done.stop_reason, "end_turn");
        assert_eq!(done.usage.input_tokens, 10);
        assert_eq!(done.usage.output_tokens, 5);
        assert!(!done.fallback_used);
        let sent = stub.sent.lock().unwrap();
        assert_eq!(sent[0].0, "k");
        assert_eq!(sent[0].1["stream"], true);
    }

    #[tokio::test]
    async fn fallback_model_is_reported() {
        let start = START.replace("claude-opus-5-5", "claude-sonnet-5-5");
        let events = sse(&[
            ("message_start", &start),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let done = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap();
        assert_eq!(done.model, "claude-sonnet-5-5");
        assert_eq!(done.requested_model, "claude-opus-5-5");
        assert!(done.fallback_used);
    }

    /// 回帰テスト: `install_default` を外すと reqwest が `panic!("No provider set")` する。
    /// 前提として、この lib テストバイナリ内で他にプロセス既定の暗号プロバイダを登録する
    /// テストを置かないこと (sqlx は `builder_with_provider` で自前のものを渡すだけ)。
    /// 既定プロバイダはプロセスで 1 つなので、先に別のテストが登録すると本テストは
    /// install 行の有無に関わらず通ってしまい、回帰を検出できなくなる。
    #[test]
    fn transport_can_be_built_without_a_preinstalled_crypto_provider() {
        // 回帰防止: プロバイダ未登録だと reqwest が panic する。
        assert!(ReqwestTransport::new().is_ok());
    }

    #[tokio::test]
    async fn mid_stream_fallback_block_overrides_model() {
        let events = sse(&[
            ("message_start", START),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"claude-opus-5-5"},"to":{"model":"claude-haiku-5-5"}}}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let done = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap();
        assert_eq!(done.model, "claude-haiku-5-5");
        assert!(done.fallback_used);
    }

    #[tokio::test]
    async fn refusal_message_includes_category_when_present() {
        let events = sse(&[
            ("message_start", START),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}},"usage":{"output_tokens":1}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let err = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("cyber"));
        // null は正当な値 (カテゴリ無し)。
        let events = sse(&[
            ("message_start", START),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":null},"usage":{"output_tokens":1}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let err = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiRefused");
        assert!(!err.to_string().contains("category"));
    }

    #[tokio::test]
    async fn streaming_refusal_is_an_error() {
        let events = sse(&[
            ("message_start", START),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let err = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiRefused");
    }

    #[tokio::test]
    async fn truncated_stream_is_an_error() {
        let events = sse(&[("message_start", START)]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let err = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiApi");
    }

    #[tokio::test]
    async fn stream_error_event_is_propagated() {
        let events = sse(&[(
            "error",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
        )]);
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        let err = run_streaming(&stub, "k", &spec(true), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiApi");
    }

    #[tokio::test]
    async fn http_401_is_auth_and_never_leaks_the_key() {
        let stub = Stub::new(
            401,
            vec![
                r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
            ],
        );
        let err = run_streaming(&stub, "sk-secret", &spec(true), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiAuth");
        assert!(!err.to_string().contains("sk-secret"));
    }

    #[tokio::test]
    async fn http_429_and_garbage_body_are_api_errors() {
        let stub = Stub::new(
            429,
            vec![r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#],
        );
        let err = run_once(&stub, "k", &spec(false)).await.unwrap_err();
        assert_eq!(err.kind(), "aiApi");
        assert!(err.to_string().contains("429"));
        let stub = Stub::new(502, vec!["<html>bad gateway</html>"]);
        let err = run_once(&stub, "k", &spec(false)).await.unwrap_err();
        assert_eq!(err.kind(), "aiApi");
    }

    #[tokio::test]
    async fn network_errors_pass_through() {
        let mut stub = Stub::new(200, vec![]);
        stub.network_error = true;
        let err = run_once(&stub, "k", &spec(false)).await.unwrap_err();
        assert_eq!(err.kind(), "aiNetwork");
    }

    #[tokio::test]
    async fn non_streaming_parses_text_usage_and_refusal() {
        let ok = r#"{"model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"he"},{"type":"text","text":"llo"}],"usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":1,"cache_creation_input_tokens":2}}"#;
        let stub = Stub::new(200, vec![ok]);
        let done = run_once(&stub, "k", &spec(false)).await.unwrap();
        assert_eq!(done.text, "hello");
        assert_eq!(done.usage.cache_creation_input_tokens, 2);
        assert_eq!(stub.sent.lock().unwrap()[0].1["stream"], false);

        let refused = ok.replace("end_turn", "refusal");
        let stub = Stub::new(200, vec![&refused]);
        let err = run_once(&stub, "k", &spec(false)).await.unwrap_err();
        assert_eq!(err.kind(), "aiRefused");
    }
}
