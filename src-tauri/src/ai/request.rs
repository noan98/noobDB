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

/// プロンプトキャッシュを付ける最小の文字数 (目安)。
///
/// Claude API のキャッシュ可能な最小プロンプト長はモデルにより 1024〜4096 トークン
/// (Sonnet / Opus 4.8 系は 1024、Opus 4.5 / 4.6 と Haiku 4.5 は 4096。
/// https://docs.claude.com/en/docs/build-with-claude/prompt-caching の "Cache limitations")。
/// これ未満に `cache_control` を付けても API はエラーにせずキャッシュしないだけだが、
/// 無駄な印を送らないよう、最大の 4096 トークンを 1 トークン約 3 文字 (識別子が多い
/// スキーマ文字列は英文より粗い) で見積もった文字数を境にする。
pub const CACHE_MIN_CHARS: usize = 12_288;

/// 1 回の要求の仕様。モデルは `models::resolve_model` で解決済みのもの。
#[derive(Debug, Clone)]
pub struct AiRequestSpec {
    pub model: AiModel,
    pub effort: AiEffort,
    /// 毎回変わる system の部分 (キャッシュ対象にしない)。
    pub system: Option<String>,
    /// 繰り返し同じになる system の固定部分 (スキーマなど)。`system` より前に置かれ、
    /// 十分長いときだけ `cache_control` が付く。省略時は `system` 単独を対象にする。
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

/// system をブロック配列にする。キャッシュ対象 (固定部分、無ければ system 単独) が
/// `CACHE_MIN_CHARS` 以上のときだけ、そのブロックに `cache_control` を付ける。
/// 固定部分は先頭に置く (キャッシュは先頭からの一致なので、可変部分は後ろ)。
fn build_system_blocks(spec: &AiRequestSpec) -> Option<Value> {
    let non_blank = |s: &Option<String>| s.clone().filter(|s| !s.trim().is_empty());
    let cached = non_blank(&spec.system_cached);
    let variable = non_blank(&spec.system);
    let text_block = |text: String| json!({ "type": "text", "text": text });
    let mut blocks: Vec<Value> = Vec::new();
    match (cached, variable) {
        (None, None) => return None,
        (Some(c), v) => {
            let mut block = text_block(c);
            mark_cacheable(&mut block);
            blocks.push(block);
            blocks.extend(v.map(text_block));
        }
        (None, Some(v)) => {
            let mut block = text_block(v);
            mark_cacheable(&mut block);
            blocks.push(block);
        }
    }
    Some(Value::Array(blocks))
}

/// ブロックが十分長ければ `cache_control: ephemeral` を付ける。
fn mark_cacheable(block: &mut Value) {
    let long_enough = block["text"]
        .as_str()
        .is_some_and(|t| t.chars().count() >= CACHE_MIN_CHARS);
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

    fn long() -> String {
        "a".repeat(CACHE_MIN_CHARS)
    }

    #[test]
    fn short_system_has_no_cache_control() {
        let b = build_body(&spec());
        assert!(b["system"][0].get("cache_control").is_none());
        let mut s = spec();
        s.system = None;
        s.system_cached = Some("x".repeat(CACHE_MIN_CHARS - 1));
        assert!(build_body(&s)["system"][0].get("cache_control").is_none());
    }

    #[test]
    fn long_system_alone_gets_cache_control() {
        let mut s = spec();
        s.system = Some(long());
        let b = build_body(&s);
        assert_eq!(b["system"].as_array().map(Vec::len), Some(1));
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn cached_part_comes_first_and_variable_part_is_not_cached() {
        let mut s = spec();
        s.system_cached = Some(long());
        s.system = Some("今回だけの指示".into());
        let b = build_body(&s);
        let blocks = b["system"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], long());
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[1]["text"], "今回だけの指示");
        assert!(blocks[1].get("cache_control").is_none());
    }

    #[test]
    fn cached_part_without_variable_part_is_single_block() {
        let mut s = spec();
        s.system = None;
        s.system_cached = Some(long());
        let b = build_body(&s);
        assert_eq!(b["system"].as_array().map(Vec::len), Some(1));
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
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
