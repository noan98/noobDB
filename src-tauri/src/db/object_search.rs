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
//! - 対象文字列はテーブル / ビュー / ルーチン / トリガーのエントリならオブジェクト名、
//!   カラムエントリならカラム名の小文字化。クエリは trim + 小文字化。空クエリは結果なし。
//! - 基礎点: 完全一致 100 > 前方一致 75 > 単語境界 (`_` / 空白 / `.` / `-` の直後で
//!   一致) 50 > 部分一致 25。一致しなければ除外。テーブルとビューのエントリは +1
//!   (同点ならテーブル系を優先)。ルーチン / トリガー (#1629) はカラムと同じ +0。
//! - 同点の二次キーは DB → テーブル (非テーブル系ではオブジェクト名) → カラムの辞書順。
//!   JS の文字列比較 (UTF-16 コードユニット順) に合わせる。それでも並ぶものだけ
//!   種別 (テーブル < ビュー < ルーチン < トリガー < カラム) と `object_kind` で決める。
//!
//! ビュー / ルーチン / トリガー (#1629) は `schema_objects` から取り込む。ビューは
//! `schema_overview` (= `list_tables`) にもテーブルとして載るので、名前が一致するものは
//! 新しいエントリを足さず、そのエントリの種別をビューへ置き換える (二重に出さない)。
//! 共有ゴールデンベクタはテーブルとカラムのみを固定しており、追加の種別は含まない。

use std::cmp::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use super::types::{SchemaObject, TableRowEstimate, TableSchema};

/// 検索ヒット 1 件。テーブル・ビュー・ルーチン・トリガーそのものか、テーブル内のカラムか。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectHit {
    /// `"table"` / `"column"` / `"view"` / `"routine"` / `"trigger"`。
    pub kind: String,
    pub database: String,
    /// テーブル・カラムのヒットではテーブル名。ビュー / ルーチン / トリガーではオブジェクト名。
    pub table: String,
    /// `kind == "column"` のときだけ設定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    /// `kind` が `view` / `routine` / `trigger` のときの `SchemaObject.kind`
    /// (`view` / `materialized_view` / `procedure` / `function` / `trigger`)。定義を開くのに使う。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_kind: Option<String>,
    /// `SchemaObject.id` (PostgreSQL の oid など)。同名のオブジェクトを取り違えないための識別子。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    /// `kind == "table"` のときの推定行数 (索引構築時の概算。統計が無ければ省略)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_estimate: Option<i64>,
}

/// 索引エントリの種別。宣言順がそのまま同点時の最終的な並び順 (テーブル系 → ルーチン → トリガー → カラム)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum EntryKind {
    Table,
    View,
    Routine,
    Trigger,
    Column,
}

impl EntryKind {
    fn as_str(self) -> &'static str {
        match self {
            EntryKind::Table => "table",
            EntryKind::View => "view",
            EntryKind::Routine => "routine",
            EntryKind::Trigger => "trigger",
            EntryKind::Column => "column",
        }
    }

    /// 同点のときテーブル系を上位にするボーナス。
    fn bonus(self) -> u32 {
        u32::from(matches!(self, EntryKind::Table | EntryKind::View))
    }
}

#[derive(Debug)]
struct IndexEntry {
    kind: EntryKind,
    database: Arc<str>,
    /// テーブル / カラムのエントリではテーブル名、ビュー / ルーチン / トリガーではオブジェクト名。
    table: Arc<str>,
    /// カラムエントリのときだけ。
    column: Option<String>,
    /// 照合対象 (オブジェクト名またはカラム名) の小文字化。索引構築時に 1 度だけ作る。
    lower: String,
    /// ビュー / ルーチン / トリガーのときの `SchemaObject.kind` と `id`。
    object_kind: Option<String>,
    object_id: Option<String>,
    row_estimate: Option<i64>,
}

/// 1 つのデータベースぶんの索引の材料。
pub struct ObjectIndexSource<'a> {
    pub database: &'a str,
    pub tables: &'a [TableSchema],
    /// ビュー / ルーチン / トリガー (`schema_objects`)。取得できなかったら空でよい。
    pub objects: &'a [SchemaObject],
    /// テーブルの推定行数 (`table_row_estimates`)。取得できなかったら空でよい。
    pub row_estimates: &'a [TableRowEstimate],
}

/// 検索対象エントリの平坦な配列。`SchemaCache` が `Arc` で共有する。
#[derive(Debug, Default)]
pub struct ObjectIndex {
    entries: Vec<IndexEntry>,
}

impl ObjectIndex {
    /// DB 名 → そのテーブル一覧 (列名つき) から索引を作る (ビュー / ルーチン / 行数なし)。
    pub fn build<'a>(schemas: impl IntoIterator<Item = (&'a str, &'a [TableSchema])>) -> Self {
        Self::build_full(
            schemas
                .into_iter()
                .map(|(database, tables)| ObjectIndexSource {
                    database,
                    tables,
                    objects: &[],
                    row_estimates: &[],
                }),
        )
    }

    /// テーブル・列に加え、ビュー / ルーチン / トリガーと行数の目安も取り込んで索引を作る (#1629)。
    pub fn build_full<'a>(sources: impl IntoIterator<Item = ObjectIndexSource<'a>>) -> Self {
        let mut entries = Vec::new();
        for src in sources {
            let database: Arc<str> = Arc::from(src.database);
            let views: HashMap<&str, &SchemaObject> = src
                .objects
                .iter()
                .filter(|o| is_view_kind(&o.kind))
                .map(|o| (o.name.as_str(), o))
                .collect();
            let estimates: HashMap<&str, i64> = src
                .row_estimates
                .iter()
                .filter_map(|e| e.estimate.map(|n| (e.name.as_str(), n)))
                .collect();
            let mut listed: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for tbl in src.tables {
                let table: Arc<str> = Arc::from(tbl.name.as_str());
                if !tbl.name.is_empty() {
                    listed.insert(tbl.name.as_str());
                    let view = views.get(tbl.name.as_str());
                    entries.push(IndexEntry {
                        kind: if view.is_some() {
                            EntryKind::View
                        } else {
                            EntryKind::Table
                        },
                        database: database.clone(),
                        table: table.clone(),
                        column: None,
                        lower: tbl.name.to_lowercase(),
                        object_kind: view.map(|v| v.kind.clone()),
                        object_id: view.and_then(|v| v.id.clone()),
                        row_estimate: if view.is_some() {
                            None
                        } else {
                            estimates.get(tbl.name.as_str()).copied()
                        },
                    });
                }
                for col in &tbl.columns {
                    if col.is_empty() {
                        continue;
                    }
                    entries.push(IndexEntry {
                        kind: EntryKind::Column,
                        database: database.clone(),
                        table: table.clone(),
                        column: Some(col.clone()),
                        lower: col.to_lowercase(),
                        object_kind: None,
                        object_id: None,
                        row_estimate: None,
                    });
                }
            }
            for obj in src.objects {
                if obj.name.is_empty() {
                    continue;
                }
                let kind = if is_view_kind(&obj.kind) {
                    // テーブル一覧に載っているビューは上で種別を置き換え済み。
                    if listed.contains(obj.name.as_str()) {
                        continue;
                    }
                    EntryKind::View
                } else if obj.kind == "procedure" || obj.kind == "function" {
                    EntryKind::Routine
                } else if obj.kind == "trigger" {
                    EntryKind::Trigger
                } else {
                    continue;
                };
                entries.push(IndexEntry {
                    kind,
                    database: database.clone(),
                    table: Arc::from(obj.name.as_str()),
                    column: None,
                    lower: obj.name.to_lowercase(),
                    object_kind: Some(obj.kind.clone()),
                    object_id: obj.id.clone(),
                    row_estimate: None,
                });
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
                scored.push((base + entry.kind.bonus(), entry));
            }
        }
        let cmp = |a: &(u32, &IndexEntry), b: &(u32, &IndexEntry)| -> Ordering {
            b.0.cmp(&a.0)
                // 同点ではシステム DB を利用者 DB の後ろへ回す (#1610)。
                .then_with(|| {
                    is_system_database(&a.1.database).cmp(&is_system_database(&b.1.database))
                })
                .then_with(|| cmp_utf16(&a.1.database, &b.1.database))
                .then_with(|| cmp_utf16(&a.1.table, &b.1.table))
                .then_with(|| {
                    cmp_utf16(
                        a.1.column.as_deref().unwrap_or(""),
                        b.1.column.as_deref().unwrap_or(""),
                    )
                })
                // 同じ名前のオブジェクトが複数種別にあるときだけ、種別で決める。
                .then_with(|| a.1.kind.cmp(&b.1.kind))
                .then_with(|| a.1.object_kind.cmp(&b.1.object_kind))
                .then_with(|| a.1.object_id.cmp(&b.1.object_id))
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
                kind: e.kind.as_str().to_string(),
                database: e.database.to_string(),
                table: e.table.to_string(),
                column: e.column.clone(),
                object_kind: e.object_kind.clone(),
                object_id: e.object_id.clone(),
                row_estimate: e.row_estimate,
            })
            .collect()
    }
}

fn is_view_kind(kind: &str) -> bool {
    kind == "view" || kind == "materialized_view"
}

/// MySQL / PostgreSQL が持つ組み込みのシステム DB (大小無視)。
fn is_system_database(name: &str) -> bool {
    [
        "information_schema",
        "mysql",
        "performance_schema",
        "sys",
        "pg_catalog",
    ]
    .iter()
    .any(|s| name.eq_ignore_ascii_case(s))
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

/// JS の `\s` / `String.prototype.trim` が空白とみなす文字と `trim` は js_compat / stream_batch の
/// 定義に一本化している (#1610)。
pub(crate) use super::js_compat::js_trim;
pub(crate) use super::stream_batch::is_js_whitespace as is_js_space;

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
    fn user_databases_rank_before_system_databases_on_ties() {
        let t = vec![schema("users", &["id"])];
        let idx = ObjectIndex::build([
            ("information_schema", t.as_slice()),
            ("mysql", t.as_slice()),
            ("shop", t.as_slice()),
            ("zeta", t.as_slice()),
        ]);
        let dbs: Vec<String> = idx
            .search("users", 10)
            .into_iter()
            .map(|h| h.database)
            .collect();
        assert_eq!(dbs, ["shop", "zeta", "information_schema", "mysql"]);
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

    fn object(kind: &str, name: &str, id: Option<&str>) -> SchemaObject {
        SchemaObject {
            kind: kind.to_string(),
            name: name.to_string(),
            id: id.map(str::to_string),
        }
    }

    fn rich() -> ObjectIndex {
        let tables = vec![
            schema("orders", &["id", "total"]),
            schema("v_orders", &["id"]),
        ];
        let objects = vec![
            object("view", "v_orders", None),
            object("view", "ghost_view", None),
            object("function", "calc_orders", Some("42")),
            object("procedure", "orders", None),
            object("trigger", "trg_orders_ai", None),
        ];
        let est = vec![
            TableRowEstimate {
                name: "orders".to_string(),
                estimate: Some(1234),
            },
            TableRowEstimate {
                name: "empty".to_string(),
                estimate: None,
            },
        ];
        ObjectIndex::build_full([ObjectIndexSource {
            database: "shop",
            tables: &tables,
            objects: &objects,
            row_estimates: &est,
        }])
    }

    #[test]
    fn views_routines_and_triggers_are_searchable() {
        let res = rich().search("orders", 50);
        let kinds: Vec<(&str, &str)> = res
            .iter()
            .filter(|h| h.column.is_none())
            .map(|h| (h.kind.as_str(), h.table.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("table", "orders"),
                // 完全一致のテーブル (100+1) > 完全一致のプロシージャ (100) > 単語境界 (50+1 のビュー、50 のルーチン / トリガー)。
                ("routine", "orders"),
                ("view", "v_orders"),
                ("routine", "calc_orders"),
                ("trigger", "trg_orders_ai"),
            ]
        );
    }

    #[test]
    fn listed_views_replace_the_table_entry_and_unlisted_views_are_added() {
        let idx = rich();
        let v = idx.search("v_orders", 5);
        assert_eq!(v[0].kind, "view");
        assert_eq!(v[0].object_kind.as_deref(), Some("view"));
        // テーブル一覧に載っているビューは 1 件だけ (テーブルとの二重表示なし)。
        assert_eq!(
            v.iter()
                .filter(|h| h.table == "v_orders" && h.column.is_none())
                .count(),
            1
        );
        let ghost = idx.search("ghost", 5);
        assert_eq!(ghost.len(), 1);
        assert_eq!(ghost[0].kind, "view");
    }

    #[test]
    fn routine_hits_carry_the_object_kind_and_id() {
        let hit = &rich().search("calc_", 5)[0];
        assert_eq!(hit.kind, "routine");
        assert_eq!(hit.object_kind.as_deref(), Some("function"));
        assert_eq!(hit.object_id.as_deref(), Some("42"));
        assert!(hit.column.is_none());
    }

    #[test]
    fn table_hits_carry_the_row_estimate_only() {
        let idx = rich();
        let t = idx.search("orders", 1);
        assert_eq!(t[0].kind, "table");
        assert_eq!(t[0].row_estimate, Some(1234));
        // ビューと列には付かない。
        for h in idx.search("orders", 50) {
            if h.kind != "table" {
                assert_eq!(h.row_estimate, None, "{h:?}");
            }
        }
    }

    #[test]
    fn same_name_objects_of_different_kinds_are_ordered_deterministically() {
        let objects = vec![
            object("trigger", "same", None),
            object("function", "same", Some("2")),
            object("procedure", "same", Some("1")),
        ];
        let idx = ObjectIndex::build_full([ObjectIndexSource {
            database: "d",
            tables: &[],
            objects: &objects,
            row_estimates: &[],
        }]);
        let order: Vec<(String, Option<String>)> = idx
            .search("same", 10)
            .into_iter()
            .map(|h| (h.kind, h.object_kind))
            .collect();
        assert_eq!(
            order,
            [
                ("routine".to_string(), Some("function".to_string())),
                ("routine".to_string(), Some("procedure".to_string())),
                ("trigger".to_string(), Some("trigger".to_string())),
            ]
        );
    }

    #[test]
    fn build_without_extras_matches_the_legacy_hit_shape() {
        let hits = sample().search("users", 3);
        assert!(hits
            .iter()
            .all(|h| h.object_kind.is_none() && h.row_estimate.is_none()));
    }

    #[test]
    fn utf16_order_differs_from_utf8_only_for_astral_vs_high_bmp() {
        // U+FF5E (BMP 高位) は U+1F600 (補助平面) より UTF-16 では後ろ。
        assert_eq!(cmp_utf16("\u{FF5E}", "\u{1F600}"), Ordering::Greater);
        assert_eq!("\u{FF5E}".cmp("\u{1F600}"), Ordering::Less);
    }
}
