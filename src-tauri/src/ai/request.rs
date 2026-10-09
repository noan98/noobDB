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

use serde_json::{json, Value};

use super::models::{AiEffort, AiModel};

pub const API_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const ANTHROPIC_BETA: &str = "server-side-fallback-2026-07-01";
/// ストリーミング要求の既定 `max_tokens` (接続テストは別に小さい値を使う)。
pub const DEFAULT_MAX_TOKENS: u32 = 64_000;

/// 1 回の要求の仕様。モデルは `models::resolve_model` で解決済みのもの。
#[derive(Debug, Clone)]
pub struct AiRequestSpec {
    pub model: AiModel,
    pub effort: AiEffort,
    pub system: Option<String>,
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
    if let Some(system) = spec.system.as_deref().filter(|s| !s.trim().is_empty()) {
        body["system"] = Value::String(system.to_string());
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
        assert_eq!(b["system"], "sys");
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
