//! PostgreSQL の `LISTEN` / `NOTIFY` 監視 (#2019) の純ロジック。副作用なし。
//!
//! ## チャンネル名の扱い (インジェクション対策)
//!
//! `LISTEN` はバインドパラメータを取れないので、チャンネル名は識別子として SQL に埋め込む。
//! 埋め込みは sqlx の `PgListener::listen` / `unlisten` が `"..."` で囲み、名前の中の `"` を
//! `""` に重ねて行う (大文字小文字も保たれる)。ここでは文字列結合で SQL を組み立てず、
//! 長さ・NUL・空文字だけを事前に弾く ([`validate_channel`])。`"; DROP TABLE x; --` のような
//! 名前も、ただの (変な) チャンネル名として扱われることを統合テストで固定している。

/// PostgreSQL の識別子長の上限 (NAMEDATALEN - 1)。超えると PG が黙って切り詰めるため、
/// 画面上のチャンネル名と実際に購読した名前がズレないよう受け付けない。
pub const MAX_CHANNEL_BYTES: usize = 63;

/// 1 回の監視で同時に購読できるチャンネル数の上限。
pub const MAX_CHANNELS: usize = 50;

/// 通知 1 件の payload を UI へ送る最大文字数。NOTIFY の payload は最大 8000 バイトだが、
/// 一覧表示とバッファの肥大を避けるため、超えた分は切り詰めて `payload_truncated` で示す。
pub const PAYLOAD_DISPLAY_MAX_CHARS: usize = 2000;

/// チャンネル名の検証。通れば購読に使う名前をそのまま返す (空白を勝手に削らない —
/// 識別子には空白も使えるので、前後の整形は UI の責務)。
pub fn validate_channel(name: &str) -> Result<&str, &'static str> {
    if name.is_empty() {
        return Err("the channel name is empty");
    }
    if name.contains('\0') {
        return Err("the channel name contains a NUL character");
    }
    if name.len() > MAX_CHANNEL_BYTES {
        return Err("the channel name is longer than 63 bytes");
    }
    Ok(name)
}

/// payload を `PAYLOAD_DISPLAY_MAX_CHARS` 文字までに切り詰める。戻り値の `bool` は切り詰めたか。
/// 文字境界で切るので、マルチバイト文字を壊さない。
pub fn truncate_payload(payload: &str) -> (String, bool) {
    match payload.char_indices().nth(PAYLOAD_DISPLAY_MAX_CHARS) {
        Some((byte_idx, _)) => (payload[..byte_idx].to_string(), true),
        None => (payload.to_string(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_nul_and_overlong_channel_names() {
        assert!(validate_channel("").is_err());
        assert!(validate_channel("a\0b").is_err());
        assert!(validate_channel(&"x".repeat(64)).is_err());
        assert_eq!(validate_channel(&"x".repeat(63)).map(str::len), Ok(63));
    }

    #[test]
    fn accepts_names_that_need_quoting() {
        // 引用で安全に扱える名前は拒否しない (大文字・空白・引用符・SQL 断片)。
        for name in [
            "Orders",
            "my channel",
            "a\"b",
            "x\"; DROP TABLE t; --",
            "日本語",
        ] {
            assert_eq!(validate_channel(name), Ok(name));
        }
    }

    #[test]
    fn length_limit_counts_bytes_not_chars() {
        // 日本語 1 文字 = 3 バイトなので 21 文字 = 63 バイトは通り、22 文字は通らない。
        assert!(validate_channel(&"あ".repeat(21)).is_ok());
        assert!(validate_channel(&"あ".repeat(22)).is_err());
    }

    #[test]
    fn short_payload_is_kept_whole() {
        assert_eq!(truncate_payload(""), (String::new(), false));
        let exact = "a".repeat(PAYLOAD_DISPLAY_MAX_CHARS);
        assert_eq!(truncate_payload(&exact), (exact.clone(), false));
    }

    #[test]
    fn long_payload_is_cut_on_a_char_boundary() {
        let long = "あ".repeat(PAYLOAD_DISPLAY_MAX_CHARS + 5);
        let (cut, truncated) = truncate_payload(&long);
        assert!(truncated);
        assert_eq!(cut.chars().count(), PAYLOAD_DISPLAY_MAX_CHARS);
        assert!(long.starts_with(&cut));
    }
}
