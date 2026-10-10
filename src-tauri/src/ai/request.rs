//! Messages API のリクエスト組み立て (#690)。
//!
//! 現行モデル共通の要件をここで吸収し、呼び出し側が意識しなくて済むようにする:
//! - `thinking` は送らない (常時オン)。
//! - `temperature` / `top_p` / `top_k` は送らない。
//! - `tool_choice` の `any` / `tool` は使わない (ツールはこの層では扱わない)。
//! - `output_config.effort` をタスク種別ごとに指定する。
//! - `max_tokens` の既定は 64000 (ストリーミング)。
//! - フォールバックを使うため `anthropic-beta` ヘッダと `"fallbacks": "default"` を付ける。
//!   ただし Haiku 5.5 にはサーバー側フォールバックが無いので `fallbacks` は送らない。
//! - system はブロック配列で送り、繰り返し同じになる固定部分 (スキーマなど) に
//!   `cache_control` を付けてプロンプトキャッシュに載せる (#1473)。

use serde_json::{json, Value};

use super::models::{AiEffort, AiModel};

pub const API_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const ANTHROPIC_BETA: &str = "server-side-fallback-2026-07-01";
/// ストリーミング要求の既定 `max_tokens` (接続テストは別に小さい値を使う)。
pub const DEFAULT_MAX_TOKENS: u32 = 64_000;

/// キャッシュ可否の判定で 1 トークンを何バイトとみなすか。
/// 英文は 1 トークン約 4 バイト。日本語 (UTF-8 で 3 バイト/文字) は 1 文字 1 トークン以上
/// なので、バイト数で見積もれば実トークン数を多く見積もりすぎず、キャッシュが効かない
/// 短さを誤って「十分長い」と判定しにくい。
const BYTES_PER_TOKEN: usize = 4;

/// 1 回の要求の仕様。モデルは `models::resolve_model` で解決済みのもの。
#[derive(Debug, Clone)]
pub struct AiRequestSpec {
    pub model: AiModel,
    pub effort: AiEffort,
    /// 毎回変わる system の部分 (キャッシュ対象にしない)。
    pub system: Option<String>,
    /// 繰り返し同じになる system の固定部分 (スキーマなど)。`system` より前に置かれ、
    /// 十分長いときだけ `cache_control` が付く。キャッシュは**これを渡したときだけ**
    /// (オプトイン)。毎回変わる値を含みうる `system` 単独には付けない (書き込み割増の無駄払い防止)。
    pub system_cached: Option<String>,
    pub prompt: String,
    pub max_tokens: u32,
    pub stream: bool,
    /// 構造化出力 (`output_config.format`)。`{ "type": "json_schema", "schema": {...} }` の形。
    pub format: Option<Value>,
}

/// 必須ヘッダ (API キー以外)。キーは `x-api-key` として呼び出し側が別に付ける。
pub fn static_headers() -> [(&'static str, &'static str); 3] {
    [
        ("anthropic-version", ANTHROPIC_VERSION),
        ("anthropic-beta", ANTHROPIC_BETA),
        ("content-type", "application/json"),
    ]
}

/// system をブロック配列にする。`system_cached` (固定部分) を先頭に置き、`system`
/// (可変部分) を後ろに続ける。`cache_control` は固定部分にだけ、モデルの最小キャッシュ長
/// 以上のときに付く。キャッシュは先頭からの一致なので固定部分が前でなければならない。
fn build_system_blocks(spec: &AiRequestSpec) -> Option<Value> {
    let non_blank = |s: &Option<String>| s.clone().filter(|s| !s.trim().is_empty());
    let text_block = |text: String| json!({ "type": "text", "text": text });
    let mut blocks: Vec<Value> = Vec::new();
    if let Some(cached) = non_blank(&spec.system_cached) {
        let mut block = text_block(cached);
        mark_cacheable(&mut block, spec.model);
        blocks.push(block);
    }
    blocks.extend(non_blank(&spec.system).map(text_block));
    (!blocks.is_empty()).then_some(Value::Array(blocks))
}

/// ブロックの `text` がモデルの最小キャッシュ長 (UTF-8 バイト数で見積もり) 以上なら
/// `cache_control: ephemeral` を付ける。system 以外のブロック (#1471 で直前の user ターンに
/// ブレークポイントを置くとき) からも使えるよう、`text` を持つブロックを直接受ける。
fn mark_cacheable(block: &mut Value, model: AiModel) {
    let long_enough = block["text"]
        .as_str()
        .is_some_and(|t| t.len() >= model.cache_min_tokens() * BYTES_PER_TOKEN);
    if long_enough {
        block["cache_control"] = json!({ "type": "ephemeral" });
    }
}

pub fn build_body(spec: &AiRequestSpec) -> Value {
    let mut body = json!({
        "model": spec.model.id(),
        "max_tokens": spec.max_tokens,
        "stream": spec.stream,
        "messages": [{ "role": "user", "content": spec.prompt }],
        "output_config": { "effort": spec.effort.as_str() },
    });
    if let Some(format) = &spec.format {
        body["output_config"]["format"] = format.clone();
    }
    if spec.model != AiModel::Haiku55 {
        body["fallbacks"] = json!("default");
    }
    if let Some(system) = build_system_blocks(spec) {
        body["system"] = system;
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> AiRequestSpec {
        AiRequestSpec {
            model: AiModel::Opus55,
            effort: AiEffort::Medium,
            system: Some("sys".into()),
            system_cached: None,
            prompt: "hello".into(),
            max_tokens: DEFAULT_MAX_TOKENS,
            stream: true,
            format: None,
        }
    }

    #[test]
    fn body_has_required_fields() {
        let b = build_body(&spec());
        assert_eq!(b["model"], "claude-opus-5-5");
        assert_eq!(b["max_tokens"], 64000);
        assert_eq!(b["stream"], true);
        assert_eq!(b["system"][0]["type"], "text");
        assert_eq!(b["system"][0]["text"], "sys");
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["messages"][0]["content"], "hello");
        assert_eq!(b["output_config"]["effort"], "medium");
        assert_eq!(b["fallbacks"], "default");
    }

    #[test]
    fn haiku_has_no_fallbacks_field() {
        let mut s = spec();
        s.model = AiModel::Haiku55;
        assert!(build_body(&s).get("fallbacks").is_none());
        s.model = AiModel::Sonnet55;
        assert_eq!(build_body(&s)["fallbacks"], "default");
    }

    #[test]
    fn body_never_contains_sampling_or_thinking_or_tool_choice() {
        let b = build_body(&spec());
        let obj = b.as_object().unwrap();
        for k in ["thinking", "temperature", "top_p", "top_k", "tool_choice"] {
            assert!(!obj.contains_key(k), "{k} は送らない");
        }
    }

    #[test]
    fn empty_system_is_omitted() {
        let mut s = spec();
        s.system = Some("  ".into());
        assert!(build_body(&s).get("system").is_none());
        s.system = None;
        assert!(build_body(&s).get("system").is_none());
    }

    /// 最小キャッシュ長ちょうどのバイト数 (Opus 5.5 = 512 トークン x 4 = 2048 バイト)。
    const MIN_BYTES: usize = 512 * BYTES_PER_TOKEN;

    fn cached_spec(text: String) -> AiRequestSpec {
        let mut s = spec();
        s.system = None;
        s.system_cached = Some(text);
        s
    }

    #[test]
    fn model_min_tokens_is_512_for_all_models() {
        for m in AiModel::ALL {
            assert_eq!(m.cache_min_tokens(), 512);
        }
    }

    #[test]
    fn cached_part_threshold_is_byte_based() {
        let below = build_body(&cached_spec("a".repeat(MIN_BYTES - 1)));
        assert!(below["system"][0].get("cache_control").is_none());
        let at = build_body(&cached_spec("a".repeat(MIN_BYTES)));
        assert_eq!(at["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn multibyte_text_is_judged_by_bytes_not_chars() {
        // 「あ」は 3 バイト。682 文字 = 2046 バイト (未満)、683 文字 = 2049 バイト (以上)。
        let below = build_body(&cached_spec("あ".repeat(682)));
        assert!(below["system"][0].get("cache_control").is_none());
        let above = build_body(&cached_spec("あ".repeat(683)));
        assert_eq!(above["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn variable_system_alone_is_never_cached() {
        let mut s = spec();
        s.system = Some("a".repeat(MIN_BYTES * 10));
        let b = build_body(&s);
        assert!(b["system"][0].get("cache_control").is_none());
    }

    #[test]
    fn cached_part_comes_first_and_variable_part_is_not_cached() {
        let mut s = cached_spec("a".repeat(MIN_BYTES));
        s.system = Some("今回だけの指示".into());
        let b = build_body(&s);
        let blocks = b["system"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "a".repeat(MIN_BYTES));
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[1]["text"], "今回だけの指示");
        assert!(blocks[1].get("cache_control").is_none());
    }

    #[test]
    fn cached_part_without_variable_part_is_single_block() {
        let b = build_body(&cached_spec("a".repeat(MIN_BYTES)));
        assert_eq!(b["system"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn blank_cached_part_is_omitted() {
        let mut s = spec();
        s.system_cached = Some("  ".into());
        let b = build_body(&s);
        assert_eq!(b["system"].as_array().map(Vec::len), Some(1));
        assert_eq!(b["system"][0]["text"], "sys");
    }

    #[test]
    fn format_is_added_to_output_config_only_when_given() {
        let mut s = spec();
        assert!(build_body(&s)["output_config"].get("format").is_none());
        s.format = Some(json!({ "type": "json_schema", "schema": { "type": "object" } }));
        let b = build_body(&s);
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert_eq!(b["output_config"]["format"]["schema"]["type"], "object");
        assert_eq!(b["output_config"]["effort"], "medium");
    }

    #[test]
    fn non_streaming_flag_is_propagated() {
        let mut s = spec();
        s.stream = false;
        assert_eq!(build_body(&s)["stream"], false);
    }

    #[test]
    fn headers_include_version_and_beta() {
        let h = static_headers();
        assert!(h.contains(&("anthropic-version", "2023-06-01")));
        assert!(h.contains(&("anthropic-beta", "server-side-fallback-2026-07-01")));
        assert!(h.contains(&("content-type", "application/json")));
    }
}
