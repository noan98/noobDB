//! SSE のパースと Anthropic ストリームイベントの変換 (#690)。HTTP には依存しない純ロジック。

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};

/// 1 件の SSE イベント (`event:` 名と、複数行を `\n` で連結した `data:`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// チャンク境界が任意の位置に来てもよい増分 SSE パーサ。バイト列のまま `\n` で行を
/// 切るので、チャンク境界でマルチバイト文字が分断されても壊れない。
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            self.process_line(&line, &mut out);
        }
        out
    }

    /// ストリーム終端。空行で閉じられなかった最後のイベントがあれば吐き出す。
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let line = String::from_utf8_lossy(&rest).into_owned();
            self.process_line(line.trim_end_matches('\r'), &mut out);
        }
        self.dispatch(&mut out);
        out
    }

    fn process_line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.dispatch(out);
        } else if line.starts_with(':') {
            // コメント行 (keep-alive)。
        } else {
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => self.event = value.to_string(),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
    }

    fn dispatch(&mut self, out: &mut Vec<SseEvent>) {
        if self.data.is_empty() {
            self.event.clear();
            return;
        }
        out.push(SseEvent {
            event: std::mem::take(&mut self.event),
            data: self.data.join("\n"),
        });
        self.data.clear();
    }
}

/// トークン使用量。`done` イベントで返す。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

impl AiUsage {
    /// `usage` オブジェクトに含まれるフィールドだけで上書きする (ストリームでは
    /// `message_delta` が output_tokens だけを持つため、無いフィールドは保つ)。
    pub fn merge(&mut self, usage: &Value) {
        let get = |k: &str| usage.get(k).and_then(Value::as_u64);
        if let Some(v) = get("input_tokens") {
            self.input_tokens = v;
        }
        if let Some(v) = get("output_tokens") {
            self.output_tokens = v;
        }
        if let Some(v) = get("cache_read_input_tokens") {
            self.cache_read_input_tokens = v;
        }
        if let Some(v) = get("cache_creation_input_tokens") {
            self.cache_creation_input_tokens = v;
        }
    }
}

/// API のエラー種別 → `AppError`。認証系だけ `AiAuth` に分ける。
pub fn api_error(error_type: &str, message: &str) -> AppError {
    match error_type {
        "authentication_error" | "permission_error" => {
            AppError::AiAuth(format!("{error_type}: {message}"))
        }
        _ => AppError::AiApi(format!("{error_type}: {message}")),
    }
}

/// 1 イベントを処理した結果。
#[derive(Debug, PartialEq, Eq)]
pub enum StreamStep {
    /// 状態更新のみ (ping・thinking・ブロック境界など)。
    Nothing,
    /// 本文テキストの差分。
    Delta(String),
    /// `message_stop`。
    Stop,
}

/// Anthropic のストリームイベント列を畳み込む状態。
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    pub usage: AiUsage,
    pub text: String,
}

impl StreamAccumulator {
    pub fn handle(&mut self, ev: &SseEvent) -> Result<StreamStep> {
        let json: Value = serde_json::from_str(&ev.data)
            .map_err(|e| AppError::AiApi(format!("invalid stream event: {e}")))?;
        // `event:` 行が無い実装に備え、data 内の `type` も見る。
        let kind = if ev.event.is_empty() {
            json.get("type").and_then(Value::as_str).unwrap_or("")
        } else {
            ev.event.as_str()
        };
        match kind {
            "message_start" => {
                let msg = &json["message"];
                if let Some(m) = msg.get("model").and_then(Value::as_str) {
                    self.model = Some(m.to_string());
                }
                if let Some(u) = msg.get("usage") {
                    self.usage.merge(u);
                }
                Ok(StreamStep::Nothing)
            }
            "content_block_delta" => {
                let delta = &json["delta"];
                // thinking_delta / input_json_delta などは本文ではないので無視する。
                if delta.get("type").and_then(Value::as_str) == Some("text_delta") {
                    if let Some(t) = delta.get("text").and_then(Value::as_str) {
                        self.text.push_str(t);
                        return Ok(StreamStep::Delta(t.to_string()));
                    }
                }
                Ok(StreamStep::Nothing)
            }
            "message_delta" => {
                if let Some(r) = json["delta"].get("stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(r.to_string());
                }
                if let Some(u) = json.get("usage") {
                    self.usage.merge(u);
                }
                Ok(StreamStep::Nothing)
            }
            "message_stop" => Ok(StreamStep::Stop),
            "error" => {
                let err = &json["error"];
                Err(api_error(
                    err.get("type").and_then(Value::as_str).unwrap_or("error"),
                    err.get("message").and_then(Value::as_str).unwrap_or(""),
                ))
            }
            _ => Ok(StreamStep::Nothing),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: event.into(),
            data: data.into(),
        }
    }

    #[test]
    fn parses_events_split_at_arbitrary_boundaries() {
        let raw = "event: a\ndata: {\"x\":1}\n\nevent: b\r\ndata: l1\r\ndata: l2\r\n\r\n";
        // 1 バイトずつ流しても同じ結果になる。
        let mut p = SseParser::new();
        let mut got = Vec::new();
        for b in raw.as_bytes() {
            got.extend(p.feed(&[*b]));
        }
        assert_eq!(got, vec![ev("a", "{\"x\":1}"), ev("b", "l1\nl2")]);
    }

    #[test]
    fn multibyte_split_across_chunks_is_preserved() {
        let raw = "data: こんにちは\n\n".as_bytes();
        let mut p = SseParser::new();
        let mut got = p.feed(&raw[..8]);
        got.extend(p.feed(&raw[8..]));
        assert_eq!(got, vec![ev("", "こんにちは")]);
    }

    #[test]
    fn comments_and_unknown_fields_are_ignored_and_finish_flushes() {
        let mut p = SseParser::new();
        assert!(p.feed(b": ping\nid: 7\nevent: z\ndata: tail").is_empty());
        assert_eq!(p.finish(), vec![ev("z", "tail")]);
    }

    fn run(events: &[(&str, &str)]) -> (StreamAccumulator, Vec<Result<StreamStep>>) {
        let mut acc = StreamAccumulator::default();
        let steps = events.iter().map(|(e, d)| acc.handle(&ev(e, d))).collect();
        (acc, steps)
    }

    #[test]
    fn accumulates_text_model_usage_and_stop_reason() {
        let (acc, steps) = run(&[
            (
                "message_start",
                r#"{"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}"#,
            ),
            ("ping", r#"{"type":"ping"}"#),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ]);
        let steps: Vec<StreamStep> = steps.into_iter().map(|s| s.unwrap()).collect();
        assert_eq!(steps[2], StreamStep::Nothing, "thinking は本文ではない");
        assert_eq!(steps[3], StreamStep::Delta("Hel".into()));
        assert_eq!(steps[4], StreamStep::Delta("lo".into()));
        assert_eq!(steps[6], StreamStep::Stop);
        assert_eq!(acc.text, "Hello");
        assert_eq!(acc.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(acc.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(
            acc.usage,
            AiUsage {
                input_tokens: 25,
                output_tokens: 15,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 4,
            }
        );
    }

    #[test]
    fn error_event_maps_auth_and_other() {
        let (_, steps) = run(&[(
            "error",
            r#"{"type":"error","error":{"type":"authentication_error","message":"bad key"}}"#,
        )]);
        assert_eq!(steps[0].as_ref().unwrap_err().kind(), "aiAuth");
        let (_, steps) = run(&[(
            "error",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
        )]);
        assert_eq!(steps[0].as_ref().unwrap_err().kind(), "aiApi");
    }

    #[test]
    fn event_name_falls_back_to_type_in_data() {
        let (acc, _) = run(&[(
            "",
            r#"{"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":2}}"#,
        )]);
        assert_eq!(acc.stop_reason.as_deref(), Some("refusal"));
    }

    #[test]
    fn invalid_json_is_an_api_error() {
        let (_, steps) = run(&[("message_start", "not json")]);
        assert_eq!(steps[0].as_ref().unwrap_err().kind(), "aiApi");
    }
}
