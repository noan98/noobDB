//! バックエンド共通の SQL 整形ユーティリティ (#546)。
//!
//! フロントエンド (`src/components/QueryEditor.tsx`) はエディタ上の整形に
//! `sql-formatter` を使い、その既定 (キーワードのケースは "preserve"、インデントは
//! 2 スペース) で整形する。バックエンド側にも同じ方針の整形を用意し、ダンプ DDL
//! (`commands/dump.rs`) や将来の履歴/結果エクスポートの可読性をフロントと揃える。
//!
//! 実装は `sqlformat` クレートの薄いラッパ。方針:
//! - インデントは 2 スペース (`sql-formatter` の既定 `tabWidth: 2` と一致)。
//! - キーワードの大文字化はせず元のケースを保持する (`sql-formatter` の既定
//!   `keywordCase: "preserve"` と一致)。
//! - 方言差は最小限とし、当面は汎用 (Generic) 整形を全ドライバ共通で用いる。
//!   フロントは方言別の language を渡すが、見た目の差は小さく、本ユーティリティの
//!   対象 (ダンプ/履歴の可読性) では汎用整形で十分とする。
//!
//! 入力が不完全/非標準でも `sqlformat` はパニックせず最善努力で文字列を返すため、
//! 呼び出し側は常に `String` を得られる。

use sqlformat::{FormatOptions, Indent, QueryParams};

/// `sql` をフロントの `sql-formatter` 既定方針 (2 スペースインデント / キーワードの
/// ケースは保持) に揃えて整形する。複数文 (`;` 区切り) もまとめて整形できる。
pub fn format_sql(sql: &str) -> String {
    let options = FormatOptions {
        indent: Indent::Spaces(2),
        // None = キーワードのケースを保持 (sql-formatter の keywordCase: "preserve" 相当)。
        uppercase: None,
        ..Default::default()
    };
    sqlformat::format(sql, &QueryParams::None, &options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_simple_select_with_two_space_indent() {
        let out = format_sql("select id, name from users where id = 1");
        // 2 スペースインデントで列・句が改行・字下げされること。
        assert!(out.contains("\n  id,"), "got: {out}");
        assert!(out.contains("\n  name"), "got: {out}");
        assert!(out.contains("\nwhere"), "got: {out}");
    }

    #[test]
    fn preserves_keyword_case() {
        // 大文字化しない方針 (preserve)。小文字キーワードは小文字のまま、大文字は大文字のまま。
        let lower = format_sql("select 1");
        assert!(lower.contains("select"), "got: {lower}");
        assert!(!lower.contains("SELECT"), "got: {lower}");
        let upper = format_sql("SELECT 1");
        assert!(upper.contains("SELECT"), "got: {upper}");
    }

    #[test]
    fn formats_cte() {
        let out = format_sql(
            "with recent as (select id from logs order by ts desc limit 10) select * from recent",
        );
        assert!(out.to_lowercase().contains("with"), "got: {out}");
        assert!(out.to_lowercase().contains("recent as"), "got: {out}");
        // CTE 本体と外側 SELECT がそれぞれ整形されること。
        assert!(
            out.to_lowercase().matches("select").count() >= 2,
            "got: {out}"
        );
    }

    #[test]
    fn formats_subquery() {
        let out = format_sql(
            "select * from (select id, count(*) c from t group by id) sub where sub.c > 1",
        );
        assert!(out.to_lowercase().contains("group by"), "got: {out}");
        assert!(out.contains('('), "got: {out}");
    }

    #[test]
    fn preserves_comments() {
        let out = format_sql("select 1 -- trailing note\nfrom dual");
        // 行コメントの本文が保持されること。
        assert!(out.contains("trailing note"), "got: {out}");
    }

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(format_sql(""), "");
    }
}
