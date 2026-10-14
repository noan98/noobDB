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
    /// `Retry-After` ヘッダ (秒指定のみ解釈する)。無い・解釈できなければ `None`。
    pub retry_after: Option<Duration>,
}

/// 429 / 529 を受けたときの再試行の方針 (#1534)。再試行するのは**応答の本文を読み始める前**
/// (HTTP エラーが返った時点) だけで、ストリームの途中では再送しない (本文の二重配信を避ける)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 初回に加えて再試行する最大回数。
    pub max_retries: u32,
    /// `Retry-After` が無いときの待ち時間の基準。試行ごとに倍にする (指数バックオフ)。
    pub base_delay: Duration,
    /// 1 回の待ち時間の上限。`Retry-After` がこれを超えるときは待たずに諦める。
    pub max_delay: Duration,
}

impl RetryPolicy {
    pub const DEFAULT: RetryPolicy = RetryPolicy {
        max_retries: 3,
        base_delay: Duration::from_secs(1),
        max_delay: Duration::from_secs(20),
    };

    /// 再試行しない方針 (接続テスト・テスト用)。
    pub const NONE: RetryPolicy = RetryPolicy {
        max_retries: 0,
        base_delay: Duration::ZERO,
        max_delay: Duration::ZERO,
    };
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// 再試行を始める直前の通知 (UI の「混雑のため再試行中」表示用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiRetryNotice {
    /// 何回目の再試行か (1 始まり)。
    pub attempt: u32,
    pub max_attempts: u32,
    pub delay: Duration,
}

/// 再試行すべきステータスか (429 = レート制限、529 = 過負荷)。
fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 529)
}

/// `attempt` (0 始まり = これまでの再試行回数) 回目の再試行前に待つ時間。`None` なら諦める。
/// `Retry-After` があればそれに従い (上限超過なら諦める)、無ければ指数バックオフ。
fn retry_delay(
    policy: &RetryPolicy,
    attempt: u32,
    retry_after: Option<Duration>,
) -> Option<Duration> {
    if attempt >= policy.max_retries {
        return None;
    }
    match retry_after {
        Some(d) if d > policy.max_delay => None,
        Some(d) => Some(d),
        None => Some(
            policy
                .base_delay
                .saturating_mul(1u32.checked_shl(attempt).unwrap_or(u32::MAX))
                .min(policy.max_delay),
        ),
    }
}

/// `post` を送り、429 / 529 なら方針に従って待って送り直す。再試行を使い切った・待てない
/// 応答はそのまま返す (呼び出し側が `error_from_status` で分類する)。
async fn post_with_retry<T: AiTransport, R: FnMut(AiRetryNotice)>(
    transport: &T,
    api_key: &str,
    body: &Value,
    policy: &RetryPolicy,
    on_retry: &mut R,
) -> Result<AiHttpResponse<T::Body>> {
    let mut attempt: u32 = 0;
    loop {
        let resp = transport.post(api_key, body).await?;
        if !is_retryable_status(resp.status) {
            return Ok(resp);
        }
        let Some(delay) = retry_delay(policy, attempt, resp.retry_after) else {
            return Ok(resp);
        };
        attempt += 1;
        on_retry(AiRetryNotice {
            attempt,
            max_attempts: policy.max_retries,
            delay,
        });
        tokio::time::sleep(delay).await;
    }
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
        // レート制限・過負荷は本文の種別に関わらず「一時的な混雑」(#1534)。
        429 | 529 => AppError::AiOverloaded(format!(
            "HTTP {status}: {etype}{}",
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        )),
        401 | 403 => AppError::AiAuth(format!(
            "API request was not authorized (HTTP {status}, {etype}){}",
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
            AppError::AiOverloaded(m) => AppError::AiOverloaded(format!("HTTP {status}: {m}")),
            other => other,
        },
    }
}

/// ストリーミング要求。本文の差分ごとに `on_delta` を呼び、完了時に `AiCompletion` を返す
/// (既定の再試行方針、通知なし。本番は `run_streaming_with`)。
#[cfg(test)]
pub async fn run_streaming<T: AiTransport, F: FnMut(&str)>(
    transport: &T,
    api_key: &str,
    spec: &AiRequestSpec,
    on_delta: F,
) -> Result<AiCompletion> {
    run_streaming_with(
        transport,
        api_key,
        spec,
        &RetryPolicy::DEFAULT,
        |_| {},
        on_delta,
    )
    .await
}

/// `run_streaming` の完全版。429 / 529 はストリーム開始前に限り `policy` に従って再試行し、
/// 待つ直前に `on_retry` で知らせる (#1534)。
pub async fn run_streaming_with<T: AiTransport, F: FnMut(&str), R: FnMut(AiRetryNotice)>(
    transport: &T,
    api_key: &str,
    spec: &AiRequestSpec,
    policy: &RetryPolicy,
    mut on_retry: R,
    mut on_delta: F,
) -> Result<AiCompletion> {
    let resp =
        post_with_retry(transport, api_key, &build_body(spec), policy, &mut on_retry).await?;
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

/// 既定の再試行方針での非ストリーミング要求 (テスト用)。接続テスト本体は
/// `run_once_with(.., &RetryPolicy::NONE)` を使う。`spec.stream` は false であること。
#[cfg(test)]
pub async fn run_once<T: AiTransport>(
    transport: &T,
    api_key: &str,
    spec: &AiRequestSpec,
) -> Result<AiCompletion> {
    run_once_with(transport, api_key, spec, &RetryPolicy::DEFAULT).await
}

/// `run_once` の完全版。接続テストのように再試行したくない呼び出しが `policy` を選ぶ。
pub async fn run_once_with<T: AiTransport>(
    transport: &T,
    api_key: &str,
    spec: &AiRequestSpec,
    policy: &RetryPolicy,
) -> Result<AiCompletion> {
    let resp = post_with_retry(transport, api_key, &build_body(spec), policy, &mut |_| {}).await?;
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

/// プロセス全体で共有する HTTP クライアント。要求のたびに作り直すと接続プールが
/// 効かず、毎回 TCP / TLS のハンドシェイクが走る (インライン補完は入力のたびに
/// 呼ばれるので待ちが積み上がる #1530)。`reqwest::Client` は内部が `Arc` なので
/// clone は安価で、同じプールを共有する。
static SHARED_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

impl ReqwestTransport {
    pub fn new() -> Result<Self> {
        if let Some(client) = SHARED_CLIENT.get() {
            return Ok(Self {
                client: client.clone(),
            });
        }
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
        // 同時に初期化が競合したら先に登録された方を使う (どちらも同じ設定)。
        let client = SHARED_CLIENT.get_or_init(|| client).clone();
        Ok(Self { client })
    }
}

/// `Retry-After` を秒数として読む (HTTP 日付形式は解釈せず `None`)。
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
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
                retry_after: parse_retry_after(resp.headers()),
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
        /// 先頭から順に消費する (ステータス, Retry-After 秒)。尽きたら `status` を返す。
        script: Mutex<std::collections::VecDeque<(u16, Option<u64>)>>,
    }
    impl Stub {
        fn new(status: u16, chunks: Vec<&str>) -> Self {
            Self {
                status,
                chunks: chunks.into_iter().map(|c| c.as_bytes().to_vec()).collect(),
                sent: Mutex::new(Vec::new()),
                network_error: false,
                script: Mutex::new(std::collections::VecDeque::new()),
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
            let (status, retry_after) = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or((self.status, None));
            Ok(AiHttpResponse {
                status,
                retry_after: retry_after.map(Duration::from_secs),
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
            history: Vec::new(),
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
        // 過負荷はストリームの途中で来ても「一時的な混雑」(#1534)。
        assert_eq!(err.kind(), "aiOverloaded");
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

    const FAST: RetryPolicy = RetryPolicy {
        max_retries: 3,
        base_delay: Duration::ZERO,
        max_delay: Duration::from_secs(20),
    };

    #[tokio::test]
    async fn http_429_529_are_overloaded_and_garbage_body_is_api_error() {
        let stub = Stub::new(
            429,
            vec![r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#],
        );
        let err = run_once_with(&stub, "k", &spec(false), &RetryPolicy::NONE)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiOverloaded");
        assert!(err.to_string().contains("429"));
        // 本文が壊れていても 529 は過負荷として扱う。
        let stub = Stub::new(529, vec!["<html>overloaded</html>"]);
        let err = run_once_with(&stub, "k", &spec(false), &RetryPolicy::NONE)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiOverloaded");
        assert!(err.to_string().contains("529"));
        let stub = Stub::new(502, vec!["<html>bad gateway</html>"]);
        let err = run_once(&stub, "k", &spec(false)).await.unwrap_err();
        assert_eq!(err.kind(), "aiApi");
        // 502 は再試行しない。
        assert_eq!(stub.sent.lock().unwrap().len(), 1);
    }

    fn ok_stream() -> Vec<String> {
        sse(&[
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
        ])
    }

    #[tokio::test]
    async fn overloaded_before_the_stream_is_retried_then_succeeds() {
        let events = ok_stream();
        let stub = Stub::new(200, events.iter().map(String::as_str).collect());
        // 1 回目 529、2 回目 429 (Retry-After 0 秒)、3 回目で成功。
        stub.script
            .lock()
            .unwrap()
            .extend([(529, None), (429, Some(0))]);
        let mut notices = Vec::new();
        let mut deltas = Vec::new();
        let done = run_streaming_with(
            &stub,
            "k",
            &spec(true),
            &FAST,
            |n| notices.push(n),
            |t| deltas.push(t.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(done.text, "ok");
        assert_eq!(deltas, vec!["ok"]);
        assert_eq!(stub.sent.lock().unwrap().len(), 3);
        assert_eq!(
            notices.iter().map(|n| n.attempt).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(notices.iter().all(|n| n.max_attempts == 3));
    }

    #[tokio::test]
    async fn retries_are_bounded_and_end_as_overloaded() {
        let stub = Stub::new(
            529,
            vec![r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#],
        );
        let mut count = 0;
        let err = run_streaming_with(&stub, "k", &spec(true), &FAST, |_| count += 1, |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiOverloaded");
        assert_eq!(count, 3);
        // 初回 + 3 回の再試行。
        assert_eq!(stub.sent.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn auth_errors_are_never_retried() {
        let stub = Stub::new(
            401,
            vec![r#"{"type":"error","error":{"type":"authentication_error","message":"bad"}}"#],
        );
        let err = run_streaming_with(&stub, "k", &spec(true), &FAST, |_| {}, |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "aiAuth");
        assert_eq!(stub.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn retry_delay_follows_retry_after_or_backs_off_exponentially() {
        let p = RetryPolicy::DEFAULT;
        let secs = Duration::from_secs;
        assert_eq!(retry_delay(&p, 0, None), Some(secs(1)));
        assert_eq!(retry_delay(&p, 1, None), Some(secs(2)));
        assert_eq!(retry_delay(&p, 2, None), Some(secs(4)));
        assert_eq!(retry_delay(&p, 3, None), None);
        assert_eq!(retry_delay(&p, 0, Some(secs(7))), Some(secs(7)));
        // 上限を超える Retry-After は待たずに諦める。
        assert_eq!(retry_delay(&p, 0, Some(secs(120))), None);
        assert_eq!(retry_delay(&RetryPolicy::NONE, 0, None), None);
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
