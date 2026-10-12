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
//! - 会話履歴 (`history`) があるときは、その最後の発言にもブレークポイントを置く (#1471)。
//!   ブレークポイントは system 固定部分 + 履歴末尾の最大 2 個で、API の上限 (4 個) に収まる。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::models::{AiEffort, AiModel};

pub const API_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const ANTHROPIC_BETA: &str = "server-side-fallback-2026-07-01";
/// ストリーミング要求の既定 `max_tokens` (接続テストは別に小さい値を使う)。
pub const DEFAULT_MAX_TOKENS: u32 = 64_000;

/// キャッシュ可否の判定で使うトークン見積もりの単位。1 トークン = `WEIGHT_PER_TOKEN` 単位。
/// ASCII 1 文字 = 1 単位 (英文は 1 トークン約 4 文字)、非 ASCII 1 文字 = 1 トークン
/// (日本語など CJK は 1 文字ほぼ 1 トークン以上)。以前は UTF-8 バイト数 / 4 で見積もって
/// いたため、日本語 (3 バイト/文字) を約 3/4 に過小評価し、最小長を満たしても
/// `cache_control` が付かなかった (#1533)。
const WEIGHT_PER_TOKEN: usize = 4;

/// `text` のトークン見積もり (`WEIGHT_PER_TOKEN` 単位)。
fn estimate_weight(text: &str) -> usize {
    text.chars()
        .map(|c| if c.is_ascii() { 1 } else { WEIGHT_PER_TOKEN })
        .sum()
}

/// 会話履歴の発言者。IPC では `"user"` / `"assistant"` だけを受け付ける。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiChatRole {
    User,
    Assistant,
}

/// 会話履歴の 1 発言 (#1471)。`role` は `user` / `assistant`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiChatMessage {
    pub role: AiChatRole,
    pub content: String,
}

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
    /// 今回の `prompt` より前の会話 (user / assistant 交互、user 始まり assistant 終わり)。
    /// 空なら従来どおり単発。最後の発言にプロンプトキャッシュのブレークポイントを置く (#1471)。
    pub history: Vec<AiChatMessage>,
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
/// `cache_control: ephemeral` を付ける。`text` を持つブロックを直接受ける。
fn mark_cacheable(block: &mut Value, model: AiModel) {
    mark_cacheable_after(block, model, 0);
}

/// `mark_cacheable` の、ブロックより前の内容 (`preceding_weight`) も数える版。API の最小長は
/// 先頭からブレークポイントまでの累積トークン数で判定されるので、履歴末尾のブレークポイントは
/// system と履歴全体の合計で判定する (#1471)。
fn mark_cacheable_after(block: &mut Value, model: AiModel, preceding_weight: usize) {
    let long_enough = block["text"].as_str().is_some_and(|t| {
        preceding_weight + estimate_weight(t) >= model.cache_min_tokens() * WEIGHT_PER_TOKEN
    });
    if long_enough {
        block["cache_control"] = json!({ "type": "ephemeral" });
    }
}

/// `messages` 配列を作る。履歴の最後の発言だけブロック形式にして `cache_control` を試みる
/// (直前までの会話をキャッシュ対象にし、今回の `prompt` は毎回変わるので付けない)。
fn build_messages(spec: &AiRequestSpec) -> Value {
    let last = spec.history.len().checked_sub(1);
    // 履歴末尾のブレークポイントまでの累積見積もり (`estimate_weight` 単位) (system 固定部分 + 可変部分 + 履歴の手前)。
    let mut preceding: usize = [&spec.system_cached, &spec.system]
        .into_iter()
        .flatten()
        .filter(|t| !t.trim().is_empty())
        .map(|t| estimate_weight(t))
        .sum();
    let mut messages: Vec<Value> = Vec::with_capacity(spec.history.len() + 1);
    for (i, m) in spec.history.iter().enumerate() {
        if Some(i) == last {
            let mut block = json!({ "type": "text", "text": m.content });
            mark_cacheable_after(&mut block, spec.model, preceding);
            messages.push(json!({ "role": m.role, "content": [block] }));
        } else {
            preceding += estimate_weight(&m.content);
            messages.push(json!({ "role": m.role, "content": m.content }));
        }
    }
    messages.push(json!({ "role": "user", "content": spec.prompt }));
    Value::Array(messages)
}

pub fn build_body(spec: &AiRequestSpec) -> Value {
    let mut body = json!({
        "model": spec.model.id(),
        "max_tokens": spec.max_tokens,
        "stream": spec.stream,
        "messages": build_messages(spec),
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
            history: Vec::new(),
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

    /// キャッシュ最小長 (トークン) ちょうどになる ASCII 文字数 (Opus 5.5 = 512 トークン x 4 = 2048 文字)。
    const MIN_CACHE_ASCII_CHARS: usize = 512 * WEIGHT_PER_TOKEN;

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
    fn cached_part_threshold_is_weight_based() {
        let below = build_body(&cached_spec("a".repeat(MIN_CACHE_ASCII_CHARS - 1)));
        assert!(below["system"][0].get("cache_control").is_none());
        let at = build_body(&cached_spec("a".repeat(MIN_CACHE_ASCII_CHARS)));
        assert_eq!(at["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn japanese_text_counts_about_one_token_per_char() {
        // 「あ」は 1 文字 = 1 トークン換算。511 文字 (未満) / 512 文字 (ちょうど) の境界。
        let below = build_body(&cached_spec("あ".repeat(511)));
        assert!(below["system"][0].get("cache_control").is_none());
        let at = build_body(&cached_spec("あ".repeat(512)));
        assert_eq!(at["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn six_hundred_japanese_chars_are_cached() {
        // 600 文字 (1800 バイト) は旧見積もり (バイト / 4 = 450) では未満だったが、実際は約 600 トークン。
        let b = build_body(&cached_spec("あ".repeat(600)));
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn mixed_ascii_and_japanese_boundary() {
        // 日本語 100 文字 = 100 トークン、ASCII 1648 文字 = 412 トークン → ちょうど 512。
        let text = format!("{}{}", "あ".repeat(100), "a".repeat(1648));
        let at = build_body(&cached_spec(text));
        assert_eq!(at["system"][0]["cache_control"]["type"], "ephemeral");
        let text = format!("{}{}", "あ".repeat(100), "a".repeat(1647));
        let below = build_body(&cached_spec(text));
        assert!(below["system"][0].get("cache_control").is_none());
    }

    #[test]
    fn japanese_history_cumulative_boundary() {
        // system なし。履歴 = 日本語 300 文字 (300 トークン) + 末尾 212 / 211 文字 → 累積 512 / 511 トークン。
        let build = |tail: usize| {
            let mut s = spec();
            s.system = None;
            s.history = vec![
                msg("user", &"あ".repeat(300)),
                msg("assistant", &"い".repeat(tail)),
            ];
            build_body(&s)
        };
        assert_eq!(
            build(212)["messages"][1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert!(build(211)["messages"][1]["content"][0]
            .get("cache_control")
            .is_none());
    }

    #[test]
    fn variable_system_alone_is_never_cached() {
        let mut s = spec();
        s.system = Some("a".repeat(MIN_CACHE_ASCII_CHARS * 10));
        let b = build_body(&s);
        assert!(b["system"][0].get("cache_control").is_none());
    }

    #[test]
    fn cached_part_comes_first_and_variable_part_is_not_cached() {
        let mut s = cached_spec("a".repeat(MIN_CACHE_ASCII_CHARS));
        s.system = Some("今回だけの指示".into());
        let b = build_body(&s);
        let blocks = b["system"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "a".repeat(MIN_CACHE_ASCII_CHARS));
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[1]["text"], "今回だけの指示");
        assert!(blocks[1].get("cache_control").is_none());
    }

    #[test]
    fn cached_part_without_variable_part_is_single_block() {
        let b = build_body(&cached_spec("a".repeat(MIN_CACHE_ASCII_CHARS)));
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

    fn msg(role: &str, content: &str) -> AiChatMessage {
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
    fn single_shot_messages_have_only_the_prompt() {
        let b = build_body(&spec());
        let m = b["messages"].as_array().unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["content"], "hello");
    }

    #[test]
    fn history_comes_before_the_prompt_in_order() {
        let mut s = spec();
        s.history = vec![msg("user", "q1"), msg("assistant", "a1")];
        s.prompt = "q2".into();
        let b = build_body(&s);
        let m = b["messages"].as_array().unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["role"], "user");
        assert_eq!(m[0]["content"], "q1");
        assert_eq!(m[1]["role"], "assistant");
        assert_eq!(m[2]["role"], "user");
        assert_eq!(m[2]["content"], "q2");
    }

    #[test]
    fn short_history_gets_no_breakpoint() {
        let mut s = spec();
        s.history = vec![msg("user", "q1"), msg("assistant", "a1")];
        let b = build_body(&s);
        assert!(b["messages"][1]["content"][0]
            .get("cache_control")
            .is_none());
        assert_eq!(b["messages"][1]["content"][0]["text"], "a1");
    }

    #[test]
    fn breakpoint_length_is_judged_on_cumulative_bytes() {
        // 末尾の発言 1 件は最小長未満でも、system と履歴の累積が最小長以上なら印が付く。
        let mut s = spec();
        s.system = None;
        s.system_cached = Some("c".repeat(MIN_CACHE_ASCII_CHARS - 10));
        s.history = vec![msg("user", "q"), msg("assistant", &"a".repeat(10))];
        let b = build_body(&s);
        assert_eq!(
            b["messages"][1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        // 累積が 1 バイト足りなければ付かない (q の 1 バイト + a の 10 バイトで境界)。
        s.history = vec![msg("user", "q"), msg("assistant", &"a".repeat(8))];
        let b = build_body(&s);
        assert!(b["messages"][1]["content"][0]
            .get("cache_control")
            .is_none());
    }

    #[test]
    fn role_serializes_lowercase_and_rejects_unknown() {
        let m: AiChatMessage =
            serde_json::from_value(json!({ "role": "assistant", "content": "x" })).unwrap();
        assert_eq!(m.role, AiChatRole::Assistant);
        assert!(serde_json::from_value::<AiChatMessage>(
            json!({ "role": "system", "content": "x" })
        )
        .is_err());
        assert_eq!(
            build_body(&{
                let mut s = spec();
                s.history = vec![msg("user", "q"), msg("assistant", "a")];
                s
            })["messages"][0]["role"],
            "user"
        );
    }

    #[test]
    fn long_history_marks_only_the_last_history_message() {
        let mut s = spec();
        s.history = vec![
            msg("user", &"q".repeat(MIN_CACHE_ASCII_CHARS)),
            msg("assistant", &"a".repeat(MIN_CACHE_ASCII_CHARS)),
        ];
        s.system = None;
        s.system_cached = Some("c".repeat(MIN_CACHE_ASCII_CHARS));
        let b = build_body(&s);
        // 先頭の発言と今回のプロンプトは文字列のままで、ブレークポイントを持たない。
        assert!(b["messages"][0]["content"].is_string());
        assert!(b["messages"][2]["content"].is_string());
        assert_eq!(
            b["messages"][1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        // system 固定部分 + 履歴末尾 = 2 個。API の上限 (4 個) を超えない。
        let count = b.to_string().matches("cache_control").count();
        assert_eq!(count, 2);
        assert!(count <= 4);
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
