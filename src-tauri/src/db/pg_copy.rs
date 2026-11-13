//! PostgreSQL 取り込みの `COPY ... FROM STDIN` 経路 (#2270) の純関数。
//!
//! 数十万〜数百万行の取り込みで、リテラル埋め込みの `INSERT ... VALUES` は文のパースと計画の
//! コストが行数に比例する。素の INSERT かつ失敗時に中断するモードでは、`COPY` (テキスト形式)
//! へ流し込む。I/O (接続・トランザクション・進捗) は `postgres.rs` に残し、ここには
//! 「使うかどうかの判定」「テキスト形式のエスケープ」「文の組み立て」「COPY が使えなかった
//! ときの警告文」だけを置く (境界ケースを単体テストで固めるため)。
//!
//! テキスト形式の規則 (PostgreSQL `COPY` の既定):
//! - 列区切りは TAB、行区切りは LF。
//! - NULL は `\N`。空文字は何も書かない (NULL と区別される)。
//! - 値の中の `\` `TAB` `LF` `CR` はバックスラッシュでエスケープする。
//!   `\` を先に二重化するので、値が文字列 `\N` でも NULL とは読まれず、`\.` (終端行) も衝突しない。
//! - bytea は入力側が `\x<hex>` のテキストで届くので、バックスラッシュの二重化により
//!   `\\x<hex>` となり、COPY が復号した後に bytea の hex 入力形式として解釈される。
//! - 64bit 整数・日時などは既にテキストなので特別扱いなし (サーバが列型へ変換する)。
//!
//! MySQL は sqlx が `LOAD DATA LOCAL INFILE` に対応せず、サーバ側の `local_infile` も要るため、
//! SQLite はプロセス内で往復コストが小さいため、それぞれ従来の INSERT のままにする。

use super::upsert::{ConflictMode, ImportConflict};

/// COPY 経路を使ってよい取り込みか。素の INSERT (UPSERT でない) のときだけ真。
///
/// `import_rows` は「1 トランザクション・失敗で全体ロールバック」の中断モード専用の経路で、
/// skip / 耐障害モード (`try_insert_chunk`) は別経路なのでここには来ない。UPSERT は
/// `ON CONFLICT` が COPY に無いので従来の INSERT に任せる。
pub(crate) fn use_copy(conflict: &ImportConflict) -> bool {
    conflict.mode == ConflictMode::Insert
}

/// 1 セルをテキスト形式でエスケープして `out` に追記する。`None` は `\N`。
pub(crate) fn push_copy_cell(out: &mut Vec<u8>, cell: Option<&str>) {
    let Some(s) = cell else {
        out.extend_from_slice(b"\\N");
        return;
    };
    for &b in s.as_bytes() {
        match b {
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            // UTF-8 のマルチバイトは 0x80 以上なので、上のバイトと衝突しない。
            _ => out.push(b),
        }
    }
}

/// 1 行を `cell\tcell\t...\n` として追記する。`ncols` に満たない行は残りを NULL で埋める
/// (INSERT 経路が `row.get(ci)` 欠落を NULL にするのと同じ)。
pub(crate) fn push_copy_row(out: &mut Vec<u8>, row: &[Option<String>], ncols: usize) {
    for ci in 0..ncols {
        if ci > 0 {
            out.push(b'\t');
        }
        push_copy_cell(out, row.get(ci).and_then(|c| c.as_deref()));
    }
    out.push(b'\n');
}

/// 複数行を 1 つのバッファにまとめる。
pub(crate) fn encode_copy_rows(rows: &[Vec<Option<String>>], ncols: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows.len().saturating_mul(ncols.max(1)).saturating_mul(8));
    for row in rows {
        push_copy_row(&mut out, row, ncols);
    }
    out
}

/// `COPY t (cols) FROM STDIN (FORMAT text)`。識別子は呼び出し側で引用符付けにして渡す。
pub(crate) fn copy_statement(table_ident: &str, column_idents: &[String]) -> String {
    format!(
        "COPY {} ({}) FROM STDIN (FORMAT text)",
        table_ident,
        column_idents.join(", ")
    )
}

/// INSERT へ切り替えてよい COPY 拒否の SQLSTATE: `0A000` (機能未対応)、`42501` (権限不足)、
/// `42809` (ビューなど COPY できない対象。データ受信後の finish 時に返る)。クラス 22 / 23 などの
/// データエラーは INSERT でも同じく失敗するので含めない。
const FALLBACK_SQLSTATES: [&str; 3] = ["0A000", "42501", "42809"];

/// COPY のエラーが INSERT への切り替え対象なら、ログに出す理由 (SQLSTATE かプロトコルエラーの
/// 旨だけ。メッセージ本文には行の値が入りうるので載せない) を返す。`protocol` はプーラなどによる
/// プロトコル違反 (`sqlx::Error::Protocol`)。
pub(crate) fn fallback_reason(sqlstate: Option<&str>, protocol: bool) -> Option<String> {
    match sqlstate {
        Some(code) if FALLBACK_SQLSTATES.contains(&code) => Some(format!("SQLSTATE {code}")),
        Some(_) => None,
        None if protocol => Some("protocol error".to_string()),
        None => None,
    }
}

/// COPY で書いてよい対象か。通常表 (`r`) とパーティション親 (`p`) だけで、ルールを持つ表は
/// COPY がルールを発火しないので INSERT にする (ビュー `v`・マテビュー `m`・外部表 `f` も INSERT)。
/// 取り込む列に GENERATED ALWAYS identity 列 (`attidentity = 'a'`) があるときも INSERT にする:
/// INSERT は 428C9 で拒否するが COPY はこの検査を通らず値が入り、シーケンスが進まないため。
/// (BY DEFAULT identity と serial は COPY のままでよい。)
pub(crate) fn relation_supports_copy(
    relkind: &str,
    has_rules: bool,
    has_always_identity: bool,
) -> bool {
    matches!(relkind, "r" | "p") && !has_rules && !has_always_identity
}

/// COPY が使えず INSERT に切り替えるときのログ文言。`reason` は [`fallback_reason`] の値で、
/// 行の値を含まない。
pub(crate) fn fallback_warning(table: &str, reason: &str) -> String {
    format!(
        "COPY FROM STDIN が使えないため、INSERT 経路に切り替えて取り込みます (table={table}, {reason})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc(cell: Option<&str>) -> String {
        let mut v = Vec::new();
        push_copy_cell(&mut v, cell);
        String::from_utf8(v).unwrap_or_default()
    }

    fn some(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    #[test]
    fn null_and_empty_string_are_distinct() {
        assert_eq!(enc(None), "\\N");
        assert_eq!(enc(Some("")), "");
        let row = vec![None, some(""), some("x")];
        let mut v = Vec::new();
        push_copy_row(&mut v, &row, 3);
        assert_eq!(v, b"\\N\t\tx\n");
    }

    #[test]
    fn literal_backslash_n_is_not_null() {
        // 文字列 `\N` (2 文字) は `\\N` になり、NULL の `\N` と区別される。
        assert_eq!(enc(Some("\\N")), "\\\\N");
    }

    #[test]
    fn special_characters_are_escaped() {
        assert_eq!(enc(Some("a\tb")), "a\\tb");
        assert_eq!(enc(Some("a\nb")), "a\\nb");
        assert_eq!(enc(Some("a\rb")), "a\\rb");
        assert_eq!(enc(Some("a\r\nb")), "a\\r\\nb");
        assert_eq!(enc(Some("a\\b")), "a\\\\b");
        assert_eq!(enc(Some("\\\\")), "\\\\\\\\");
        // バックスラッシュ + 改行は、先に \ を二重化するので順序が崩れない。
        assert_eq!(enc(Some("\\\n")), "\\\\\\n");
    }

    #[test]
    fn end_of_data_marker_is_neutralised() {
        // 単独行の `\.` は COPY の終端と解釈されうるので `\\.` になる。
        assert_eq!(enc(Some("\\.")), "\\\\.");
    }

    #[test]
    fn bytea_hex_text_gets_double_backslash() {
        assert_eq!(enc(Some("\\xdeadbeef")), "\\\\xdeadbeef");
        assert_eq!(enc(Some("\\x")), "\\\\x");
    }

    #[test]
    fn sixty_four_bit_integers_and_datetimes_pass_through() {
        assert_eq!(enc(Some("9223372036854775807")), "9223372036854775807");
        assert_eq!(enc(Some("-9223372036854775808")), "-9223372036854775808");
        assert_eq!(enc(Some("18446744073709551615")), "18446744073709551615");
        assert_eq!(
            enc(Some("2024-02-29 23:59:59.123456+09")),
            "2024-02-29 23:59:59.123456+09"
        );
        assert_eq!(enc(Some("infinity")), "infinity");
    }

    #[test]
    fn multibyte_utf8_is_preserved() {
        assert_eq!(enc(Some("日本語\tテキスト")), "日本語\\tテキスト");
        assert_eq!(enc(Some("😀")), "😀");
        // 全角バックスラッシュ相当 (U+FF3C) はエスケープ対象外。
        assert_eq!(enc(Some("＼")), "＼");
    }

    #[test]
    fn quotes_and_spaces_are_untouched() {
        assert_eq!(enc(Some("it's \"q\" ")), "it's \"q\" ");
        assert_eq!(enc(Some(" ")), " ");
    }

    #[test]
    fn short_rows_are_padded_with_null() {
        let row = vec![some("a")];
        let mut v = Vec::new();
        push_copy_row(&mut v, &row, 3);
        assert_eq!(v, b"a\t\\N\t\\N\n");
    }

    #[test]
    fn extra_cells_are_ignored() {
        let row = vec![some("a"), some("b"), some("c")];
        let mut v = Vec::new();
        push_copy_row(&mut v, &row, 2);
        assert_eq!(v, b"a\tb\n");
    }

    #[test]
    fn rows_are_newline_terminated_and_concatenated() {
        let rows = vec![vec![some("1"), some("a\nb")], vec![None, some("")]];
        assert_eq!(encode_copy_rows(&rows, 2), b"1\ta\\nb\n\\N\t\n");
        assert!(encode_copy_rows(&[], 2).is_empty());
    }

    #[test]
    fn single_empty_string_column_row_is_not_blank_ambiguous() {
        // 1 列で空文字の行は空行になる (COPY text は空行を空文字の 1 列として読む)。
        let rows = vec![vec![some("")]];
        assert_eq!(encode_copy_rows(&rows, 1), b"\n");
    }

    #[test]
    fn statement_shape() {
        let s = copy_statement(
            "\"public\".\"t\"",
            &["\"id\"".to_string(), "\"na me\"".to_string()],
        );
        assert_eq!(
            s,
            "COPY \"public\".\"t\" (\"id\", \"na me\") FROM STDIN (FORMAT text)"
        );
    }

    #[test]
    fn copy_is_used_only_for_plain_insert() {
        assert!(use_copy(&ImportConflict::insert_only()));
        let skip = ImportConflict {
            mode: ConflictMode::Skip,
            key_columns: vec!["id".into()],
        };
        let update = ImportConflict {
            mode: ConflictMode::Update,
            key_columns: vec!["id".into()],
        };
        assert!(!use_copy(&skip));
        assert!(!use_copy(&update));
    }

    #[test]
    fn fallback_warning_mentions_table_and_reason() {
        let w = fallback_warning("t", "SQLSTATE 42501");
        assert!(w.contains("table=t") && w.contains("SQLSTATE 42501") && w.contains("INSERT"));
    }

    #[test]
    fn fallback_only_for_allow_listed_sqlstates() {
        for code in ["0A000", "42501", "42809"] {
            assert_eq!(
                fallback_reason(Some(code), false),
                Some(format!("SQLSTATE {code}"))
            );
        }
        // データエラー (クラス 22 / 23) や存在しない表は切り替えない。
        for code in [
            "22P02", "22003", "23505", "23502", "42P01", "57014", "08006",
        ] {
            assert_eq!(fallback_reason(Some(code), false), None, "{code}");
        }
        assert_eq!(
            fallback_reason(None, true),
            Some("protocol error".to_string())
        );
        assert_eq!(fallback_reason(None, false), None);
        // コード付きなら protocol 扱いにしない。
        assert_eq!(fallback_reason(Some("22P02"), true), None);
    }

    #[test]
    fn fallback_reason_never_carries_message_text() {
        let r = fallback_reason(Some("42809"), false).unwrap_or_default();
        assert_eq!(r, "SQLSTATE 42809");
    }

    #[test]
    fn only_plain_tables_without_rules_use_copy() {
        assert!(relation_supports_copy("r", false, false));
        assert!(relation_supports_copy("p", false, false));
        assert!(!relation_supports_copy("r", true, false));
        for k in ["v", "m", "f", "S", "i"] {
            assert!(!relation_supports_copy(k, false, false), "{k}");
        }
    }

    #[test]
    fn always_identity_column_disables_copy() {
        assert!(!relation_supports_copy("r", false, true));
        assert!(!relation_supports_copy("p", false, true));
    }
}
