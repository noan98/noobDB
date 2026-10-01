//! スキーマ横断のグローバルオブジェクト検索 (#1261) の索引とスコアリング。
//!
//! 以前はフロント (`objectSearch.ts`) が全 DB の `schema_overview` を JS に集め、
//! キー入力のたびに全エントリで `toLowerCase` + `new RegExp` を回していた。ここでは
//! 索引を Rust 側 (`SchemaCache`) に 1 度だけ構築し (小文字化済みの名前を保持)、
//! 検索はスコア計算 + 部分ソートで上位 N 件だけを返す。
//!
//! ## 順位の規則 (旧 `objectSearch.ts` と同一。共有ゴールデン
//! `src/__tests__/fixtures/objectSearchVectors.json` で固定)
//!
//! - 対象文字列はテーブルエントリならテーブル名、カラムエントリならカラム名の
//!   小文字化。クエリは trim + 小文字化。空クエリは結果なし。
//! - 基礎点: 完全一致 100 > 前方一致 75 > 単語境界 (`_` / 空白 / `.` / `-` の直後で
//!   一致) 50 > 部分一致 25。一致しなければ除外。テーブルエントリは +1 (同点ならテーブル優先)。
//! - 同点の二次キーは DB → テーブル → カラムの辞書順。JS の文字列比較 (UTF-16
//!   コードユニット順) に合わせる。

use std::cmp::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::types::TableSchema;

/// 検索ヒット 1 件。テーブルそのものか、テーブル内のカラムか。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectHit {
    /// `"table"` または `"column"`。
    pub kind: String,
    pub database: String,
    pub table: String,
    /// `kind == "column"` のときだけ設定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
}

#[derive(Debug)]
struct IndexEntry {
    is_column: bool,
    database: Arc<str>,
    table: Arc<str>,
    /// カラムエントリのときだけ。
    column: Option<String>,
    /// 照合対象 (テーブル名またはカラム名) の小文字化。索引構築時に 1 度だけ作る。
    lower: String,
}

/// 検索対象エントリの平坦な配列。`SchemaCache` が `Arc` で共有する。
#[derive(Debug, Default)]
pub struct ObjectIndex {
    entries: Vec<IndexEntry>,
}

impl ObjectIndex {
    /// DB 名 → そのテーブル一覧 (列名つき) から索引を作る。
    pub fn build<'a>(schemas: impl IntoIterator<Item = (&'a str, &'a [TableSchema])>) -> Self {
        let mut entries = Vec::new();
        for (database, tables) in schemas {
            let database: Arc<str> = Arc::from(database);
            for tbl in tables {
                let table: Arc<str> = Arc::from(tbl.name.as_str());
                if !tbl.name.is_empty() {
                    entries.push(IndexEntry {
                        is_column: false,
                        database: database.clone(),
                        table: table.clone(),
                        column: None,
                        lower: tbl.name.to_lowercase(),
                    });
                }
                for col in &tbl.columns {
                    if col.is_empty() {
                        continue;
                    }
                    entries.push(IndexEntry {
                        is_column: true,
                        database: database.clone(),
                        table: table.clone(),
                        column: Some(col.clone()),
                        lower: col.to_lowercase(),
                    });
                }
            }
        }
        Self { entries }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `query` を大小無視・部分一致で検索し、スコア降順 (同点はテーブル優先) に
    /// 並べた上位 `limit` 件を返す。空クエリは空配列。
    pub fn search(&self, query: &str, limit: usize) -> Vec<ObjectHit> {
        let q = js_trim(query).to_lowercase();
        if q.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut scored: Vec<(u32, &IndexEntry)> = Vec::new();
        for entry in &self.entries {
            let base = base_score(&entry.lower, &q);
            if base > 0 {
                scored.push((base + u32::from(!entry.is_column), entry));
            }
        }
        let cmp = |a: &(u32, &IndexEntry), b: &(u32, &IndexEntry)| -> Ordering {
            b.0.cmp(&a.0)
                .then_with(|| cmp_utf16(&a.1.database, &b.1.database))
                .then_with(|| cmp_utf16(&a.1.table, &b.1.table))
                .then_with(|| {
                    cmp_utf16(
                        a.1.column.as_deref().unwrap_or(""),
                        b.1.column.as_deref().unwrap_or(""),
                    )
                })
        };
        // 上位 `limit` 件だけを部分ソートで取り出し、その範囲だけを整列する。
        if scored.len() > limit {
            scored.select_nth_unstable_by(limit - 1, cmp);
            scored.truncate(limit);
        }
        scored.sort_by(cmp);
        scored
            .into_iter()
            .map(|(_, e)| ObjectHit {
                kind: if e.is_column { "column" } else { "table" }.to_string(),
                database: e.database.to_string(),
                table: e.table.to_string(),
                column: e.column.clone(),
            })
            .collect()
    }
}

/// 基礎点。一致しなければ 0。`target` / `q` はともに小文字化済み。
fn base_score(target: &str, q: &str) -> u32 {
    if target == q {
        100
    } else if target.starts_with(q) {
        75
    } else if has_word_boundary_match(target, q) {
        50
    } else if target.contains(q) {
        25
    } else {
        0
    }
}

/// JS の `/[_\s.-]<q>/.test(target)` と同じ: 区切り文字の直後で `q` が始まる位置があるか。
fn has_word_boundary_match(target: &str, q: &str) -> bool {
    target.char_indices().any(|(i, c)| {
        (c == '_' || c == '.' || c == '-' || is_js_space(c))
            && target[i + c.len_utf8()..].starts_with(q)
    })
}

/// JS の `\s` / `String.prototype.trim` が空白とみなす文字 (WhiteSpace + LineTerminator)。
/// Rust の `char::is_whitespace` とは NEL (U+0085) と BOM (U+FEFF) が異なる。
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{A}'
            | '\u{B}'
            | '\u{C}'
            | '\u{D}'
            | '\u{20}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JS の `String.prototype.trim` 相当。
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JS の `<` / `>` による文字列比較 (UTF-16 コードユニット順) と同じ順序。
/// UTF-8 のバイト順 (= コードポイント順) とは、サロゲート領域より上の BMP 文字と
/// 補助平面の文字の間でだけ食い違う。
pub(crate) fn cmp_utf16(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        a.cmp(b)
    } else {
        a.encode_utf16().cmp(b.encode_utf16())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(name: &str, cols: &[&str]) -> TableSchema {
        TableSchema {
            name: name.to_string(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn sample() -> ObjectIndex {
        let shop = vec![
            schema("users", &["id", "user_name", "email"]),
            schema("orders", &["id", "user_id", "total"]),
        ];
        let analytics = vec![schema("events", &["id", "user_id", "ts"])];
        ObjectIndex::build([
            ("shop", shop.as_slice()),
            ("analytics", analytics.as_slice()),
        ])
    }

    #[test]
    fn blank_query_returns_nothing() {
        assert!(sample().search("  ", 200).is_empty());
        assert!(sample().search("", 200).is_empty());
    }

    #[test]
    fn exact_table_match_ranks_first() {
        let res = sample().search("users", 200);
        assert_eq!(res[0].kind, "table");
        assert_eq!(res[0].table, "users");
        assert!(res[0].column.is_none());
    }

    #[test]
    fn table_bonus_beats_column_on_same_base_score() {
        // "user" は users (前方 75 + 1) が user_name / user_id (前方 75) より上。
        let res = sample().search("USER", 200);
        assert_eq!(res[0].kind, "table");
        assert_eq!(res[0].table, "users");
    }

    #[test]
    fn word_boundary_beats_substring() {
        let s = vec![schema("t", &["xid", "user_id"])];
        let idx = ObjectIndex::build([("d", s.as_slice())]);
        let res = idx.search("id", 10);
        // user_id (単語境界 50) が xid (部分一致 25) より上。
        assert_eq!(res[0].column.as_deref(), Some("user_id"));
        assert_eq!(res[1].column.as_deref(), Some("xid"));
    }

    #[test]
    fn limit_caps_and_keeps_the_best() {
        let idx = sample();
        let all = idx.search("id", 200);
        let top2 = idx.search("id", 2);
        assert_eq!(top2.len(), 2);
        assert_eq!(top2, all[..2].to_vec());
    }

    #[test]
    fn utf16_order_differs_from_utf8_only_for_astral_vs_high_bmp() {
        // U+FF5E (BMP 高位) は U+1F600 (補助平面) より UTF-16 では後ろ。
        assert_eq!(cmp_utf16("\u{FF5E}", "\u{1F600}"), Ordering::Greater);
        assert_eq!("\u{FF5E}".cmp("\u{1F600}"), Ordering::Less);
    }
}
