//! Schema comparison.
//!
//! Pure, driver-agnostic diffing of two schemas, each expressed as the table /
//! column metadata the introspection layer already produces (`TableColumnInfo`).
//! The command layer (`commands::diff`) fetches both sides from live sessions
//! and feeds them here; keeping the computation pure makes it unit-testable
//! without a database.
//!
//! This module is comparison / visualisation only: it classifies every table
//! and column as source-only, target-only, differing, or identical. Generating
//! the reconciling DDL is intentionally out of scope (see `super::sync`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::types::{ForeignKey, TableColumnInfo};
use super::DriverKind;

/// Where a table or column sits relative to the two schemas being compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    /// Present only in the source schema (would be added to the target).
    SourceOnly,
    /// Present only in the target schema (would be removed from the target).
    TargetOnly,
    /// Present in both, but the definitions differ.
    Different,
    /// Present in both with identical definitions.
    Same,
}

/// One table paired with its full column metadata — the collected shape of one
/// side of the comparison. Built by the command layer from `Connection::tables`
/// + `Connection::columns`.
///
/// Also the per-table unit of the schema drift snapshots (#736 / #1260): those
/// are assembled from `columns_for_database` and replayed through
/// `compute_schema_diff` without a live session. Hence `Serialize`/`Deserialize`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableColumns {
    pub name: String,
    pub columns: Vec<TableColumnInfo>,
}

/// Difference of a single column between the two schemas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDiff {
    pub name: String,
    pub status: DiffStatus,
    /// The source-side definition, when the column exists there.
    pub source: Option<TableColumnInfo>,
    /// The target-side definition, when the column exists there.
    pub target: Option<TableColumnInfo>,
    /// For `Different`, the attribute names that differ
    /// (`data_type` / `nullable` / `default` / `key` / `extra` / `comment` /
    /// `foreign_key`). Empty for every other status.
    pub changed_fields: Vec<String>,
}

/// Difference of a single table between the two schemas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDiff {
    pub name: String,
    pub status: DiffStatus,
    /// Column-level diffs. For a `SourceOnly` / `TargetOnly` table every column
    /// is listed with that same one-sided status so the UI can render the full
    /// shape. For a table present on both sides only the columns that actually
    /// differ (added / removed / changed) are listed — identical columns are
    /// omitted to keep the diff focused. For a `Same` table this is empty.
    pub columns: Vec<ColumnDiff>,
    /// `SourceOnly` テーブルの外部キー制約 (source 側、制約単位。複合キー・参照動作を
    /// 保つ)。`CREATE TABLE` 同期が FK を出すためだけに使い、[`attach_source_foreign_keys`]
    /// を呼んだ経路 (スキーマ比較) でのみ埋まる。サンドボックスなど呼ばない経路では
    /// 空のままで、FK は出力されない (FK 付きの表のコピーが親行欠落で失敗しないため)。
    /// `#[serde(default)]`: このフィールドを持たない JSON (往復後の diff) も読める。
    #[serde(default)]
    pub foreign_keys: Vec<DiffForeignKey>,
}

/// 外部キー 1 制約 (複合キーの列を束ねたもの)。`referenced_columns` が空なら参照先
/// 列は解決できなかった (参照先の主キーを暗黙に指す形で出力する)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffForeignKey {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

/// 制約名として DDL に出してよいか。SQLite の合成名 (`<table>:<id>`、実在の名前ではない)
/// と、識別子の長さ上限 (MySQL 64 / PostgreSQL 63) を超える名前は出さない。
fn is_usable_constraint_name(table: &str, name: &str) -> bool {
    let synthetic = name
        .strip_prefix(table)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()));
    !synthetic && name.chars().count() <= 63
}

/// `SourceOnly` テーブルへ、source 側の外部キー (`Connection::foreign_keys` の結果)
/// を制約単位に束ねて載せる。`CREATE TABLE` 同期が FK を出力するために呼ぶ。
pub fn attach_source_foreign_keys(diff: &mut SchemaDiff, fks: &[ForeignKey]) {
    attach_foreign_keys(diff, fks, DiffStatus::SourceOnly);
}

/// `TargetOnly` テーブルへ、target 側の外部キーを載せる。逆向きの同期 (down
/// マイグレーション) で `DROP TABLE` を子 → 親の順に並べるために使う。
pub fn attach_target_foreign_keys(diff: &mut SchemaDiff, fks: &[ForeignKey]) {
    attach_foreign_keys(diff, fks, DiffStatus::TargetOnly);
    // 残る表 (Same / Different) のうち、target のみの表を参照する FK も載せる。
    // SQLite は FK 有効時の DROP TABLE が暗黙の DELETE を実行し、残る子表の
    // ON DELETE CASCADE / SET NULL を発火させるため、同期側が検知できるようにする。
    let target_only: std::collections::HashSet<String> = diff
        .tables
        .iter()
        .filter(|t| t.status == DiffStatus::TargetOnly)
        .map(|t| t.name.to_ascii_lowercase())
        .collect();
    // SQLite の `foreign_key_list` は DDL に書かれた表記のまま返すので、大小は区別しない。
    let referencing: Vec<ForeignKey> = fks
        .iter()
        .filter(|f| target_only.contains(&f.referenced_table.to_ascii_lowercase()))
        .cloned()
        .collect();
    for table in diff
        .tables
        .iter_mut()
        .filter(|t| matches!(t.status, DiffStatus::Same | DiffStatus::Different))
    {
        table.foreign_keys = super::table_ddl::group_foreign_keys(&table.name, &referencing)
            .into_iter()
            .map(|g| DiffForeignKey {
                name: g.name.map(str::to_string),
                columns: g.columns.iter().map(|c| c.to_string()).collect(),
                referenced_table: g.referenced_table.to_string(),
                referenced_columns: Vec::new(),
                on_delete: g.on_delete.map(str::to_string),
                on_update: g.on_update.map(str::to_string),
            })
            .collect();
    }
}

fn attach_foreign_keys(diff: &mut SchemaDiff, fks: &[ForeignKey], status: DiffStatus) {
    for table in diff.tables.iter_mut().filter(|t| t.status == status) {
        table.foreign_keys = super::table_ddl::group_foreign_keys(&table.name, fks)
            .into_iter()
            .map(|g| DiffForeignKey {
                name: g
                    .name
                    .filter(|n| is_usable_constraint_name(&table.name, n))
                    .map(str::to_string),
                columns: g.columns.iter().map(|c| c.to_string()).collect(),
                referenced_table: g.referenced_table.to_string(),
                referenced_columns: if g.referenced_columns.iter().all(Option::is_some) {
                    g.referenced_columns
                        .iter()
                        .flatten()
                        .map(|c| c.to_string())
                        .collect()
                } else {
                    Vec::new()
                },
                on_delete: g.on_delete.map(str::to_string),
                on_update: g.on_update.map(str::to_string),
            })
            .collect();
    }
}

/// The full result of comparing a source schema against a target schema. Tables
/// are sorted by name and include identical (`Same`) tables so the UI can show
/// a complete classification overview, not only the differences.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaDiff {
    pub source_driver: DriverKind,
    pub target_driver: DriverKind,
    pub tables: Vec<TableDiff>,
    /// 比較時に集めきれなかった情報の注意 (例: SQLite で target の外部キー取得に失敗)。
    /// 同期計画の警告にそのまま載せる。空なら JSON に出さない。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Compares `source` against `target`, classifying every table and (for tables
/// present on both sides) every column. The result lists tables sorted by name.
///
/// Table and column names are matched case-sensitively: within a single driver
/// the introspection layer reports names consistently, and treating a rename or
/// case change as add+remove is the safe, predictable behaviour for a diff.
pub fn compute_schema_diff(
    source_driver: DriverKind,
    target_driver: DriverKind,
    source: &[TableColumns],
    target: &[TableColumns],
) -> SchemaDiff {
    let names = sorted_union(
        source.iter().map(|t| t.name.as_str()),
        target.iter().map(|t| t.name.as_str()),
    );

    // 名前ごとの線形探索 (find) はテーブル数の多いスキーマで O(n²) になるため、
    // 名前 → メタデータのマップを 1 度だけ作って引く (名前はドライバ内で一意)。
    // 出力順は従来どおり sorted_union が決める。
    let src_by_name: HashMap<&str, &TableColumns> =
        source.iter().map(|t| (t.name.as_str(), t)).collect();
    let tgt_by_name: HashMap<&str, &TableColumns> =
        target.iter().map(|t| (t.name.as_str(), t)).collect();

    let tables = names
        .into_iter()
        .map(|name| {
            let src = src_by_name.get(name.as_str()).copied();
            let tgt = tgt_by_name.get(name.as_str()).copied();
            match (src, tgt) {
                (Some(s), None) => TableDiff {
                    name,
                    status: DiffStatus::SourceOnly,
                    columns: one_sided_columns(&s.columns, DiffStatus::SourceOnly),
                    foreign_keys: Vec::new(),
                },
                (None, Some(t)) => TableDiff {
                    name,
                    status: DiffStatus::TargetOnly,
                    columns: one_sided_columns(&t.columns, DiffStatus::TargetOnly),
                    foreign_keys: Vec::new(),
                },
                (Some(s), Some(t)) => {
                    let columns = diff_columns(&s.columns, &t.columns);
                    let status = if columns.is_empty() {
                        DiffStatus::Same
                    } else {
                        DiffStatus::Different
                    };
                    TableDiff {
                        name,
                        status,
                        columns,
                        foreign_keys: Vec::new(),
                    }
                }
                // `names` is the union of the two sides, so at least one is Some.
                (None, None) => unreachable!(),
            }
        })
        .collect();

    SchemaDiff {
        source_driver,
        target_driver,
        tables,
        warnings: Vec::new(),
    }
}

/// Builds a one-sided column list (every column reported with `status`), used
/// for a table that exists on only one side.
fn one_sided_columns(columns: &[TableColumnInfo], status: DiffStatus) -> Vec<ColumnDiff> {
    columns
        .iter()
        .map(|c| {
            let (source, target) = match status {
                DiffStatus::SourceOnly => (Some(c.clone()), None),
                DiffStatus::TargetOnly => (None, Some(c.clone())),
                _ => (Some(c.clone()), Some(c.clone())),
            };
            ColumnDiff {
                name: c.name.clone(),
                status,
                source,
                target,
                changed_fields: Vec::new(),
            }
        })
        .collect()
}

/// Diffs the columns of a table present on both sides. Only non-identical
/// columns are returned (added / removed / changed); identical columns are
/// omitted. Result is sorted by column name.
fn diff_columns(source: &[TableColumnInfo], target: &[TableColumnInfo]) -> Vec<ColumnDiff> {
    let names = sorted_union(
        source.iter().map(|c| c.name.as_str()),
        target.iter().map(|c| c.name.as_str()),
    );

    // テーブル比較と同じく、列数の多いテーブルでの O(n²) を避ける (出力順は
    // sorted_union のまま)。
    let src_by_name: HashMap<&str, &TableColumnInfo> =
        source.iter().map(|c| (c.name.as_str(), c)).collect();
    let tgt_by_name: HashMap<&str, &TableColumnInfo> =
        target.iter().map(|c| (c.name.as_str(), c)).collect();

    let mut out = Vec::new();
    for name in names {
        let src = src_by_name.get(name.as_str()).copied();
        let tgt = tgt_by_name.get(name.as_str()).copied();
        match (src, tgt) {
            (Some(s), None) => out.push(ColumnDiff {
                name,
                status: DiffStatus::SourceOnly,
                source: Some(s.clone()),
                target: None,
                changed_fields: Vec::new(),
            }),
            (None, Some(t)) => out.push(ColumnDiff {
                name,
                status: DiffStatus::TargetOnly,
                source: None,
                target: Some(t.clone()),
                changed_fields: Vec::new(),
            }),
            (Some(s), Some(t)) => {
                let changed = changed_fields(s, t);
                if !changed.is_empty() {
                    out.push(ColumnDiff {
                        name,
                        status: DiffStatus::Different,
                        source: Some(s.clone()),
                        target: Some(t.clone()),
                        changed_fields: changed,
                    });
                }
            }
            (None, None) => unreachable!(),
        }
    }
    out
}

/// Lists which attributes differ between two same-named columns. Type/key/extra
/// comparisons are case-insensitive (drivers may report e.g. `INT` vs `int`);
/// `default` is compared exactly since a default value is significant verbatim.
fn changed_fields(s: &TableColumnInfo, t: &TableColumnInfo) -> Vec<String> {
    let mut fields = Vec::new();
    if !s.data_type.eq_ignore_ascii_case(&t.data_type) {
        fields.push("data_type".to_string());
    }
    if s.nullable != t.nullable {
        fields.push("nullable".to_string());
    }
    if s.default != t.default {
        fields.push("default".to_string());
    }
    if !s.key.eq_ignore_ascii_case(&t.key) {
        fields.push("key".to_string());
    }
    if !s.extra.eq_ignore_ascii_case(&t.extra) {
        fields.push("extra".to_string());
    }
    // 列コメント。ドライバ間で「無い」の表現が揺れる (None / 空文字) ので空は同一視する。
    fn norm(c: &Option<String>) -> Option<&str> {
        c.as_deref().filter(|c| !c.trim().is_empty())
    }
    if norm(&s.comment) != norm(&t.comment) {
        fields.push("comment".to_string());
    }
    if !opt_eq_ignore_case(&s.referenced_table, &t.referenced_table)
        || !opt_eq_ignore_case(&s.referenced_column, &t.referenced_column)
    {
        fields.push("foreign_key".to_string());
    }
    fields
}

fn opt_eq_ignore_case(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        (None, None) => true,
        _ => false,
    }
}

/// Sorted, de-duplicated union of two name iterators.
fn sorted_union<'a>(
    a: impl Iterator<Item = &'a str>,
    b: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let mut names: Vec<String> = a.chain(b).map(|s| s.to_string()).collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constraint_names_synthetic_or_too_long_are_not_usable() {
        assert!(is_usable_constraint_name("child", "fk_child_parent"));
        assert!(!is_usable_constraint_name("child", "child:0"));
        assert!(is_usable_constraint_name("child", "child:abc"));
        assert!(is_usable_constraint_name("child", &"a".repeat(63)));
        assert!(!is_usable_constraint_name("child", &"a".repeat(64)));
    }

    fn col(name: &str, data_type: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn table(name: &str, columns: Vec<TableColumnInfo>) -> TableColumns {
        TableColumns {
            name: name.to_string(),
            columns,
        }
    }

    fn diff(source: &[TableColumns], target: &[TableColumns]) -> SchemaDiff {
        compute_schema_diff(DriverKind::Mysql, DriverKind::Mysql, source, target)
    }

    #[test]
    fn identical_schemas_report_all_same_with_no_column_diffs() {
        let s = vec![table(
            "users",
            vec![col("id", "int"), col("name", "varchar(50)")],
        )];
        let t = vec![table(
            "users",
            vec![col("id", "int"), col("name", "varchar(50)")],
        )];
        let d = diff(&s, &t);
        assert_eq!(d.tables.len(), 1);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
        assert!(d.tables[0].columns.is_empty());
    }

    #[test]
    fn source_only_table_lists_all_columns_as_source_only() {
        let s = vec![table("only_src", vec![col("a", "int"), col("b", "text")])];
        let t = vec![];
        let d = diff(&s, &t);
        assert_eq!(d.tables.len(), 1);
        assert_eq!(d.tables[0].status, DiffStatus::SourceOnly);
        assert_eq!(d.tables[0].columns.len(), 2);
        assert!(d.tables[0]
            .columns
            .iter()
            .all(|c| c.status == DiffStatus::SourceOnly
                && c.source.is_some()
                && c.target.is_none()));
    }

    #[test]
    fn target_only_table_lists_all_columns_as_target_only() {
        let s = vec![];
        let t = vec![table("only_tgt", vec![col("a", "int")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::TargetOnly);
        assert_eq!(d.tables[0].columns[0].status, DiffStatus::TargetOnly);
        assert!(d.tables[0].columns[0].source.is_none());
        assert!(d.tables[0].columns[0].target.is_some());
    }

    #[test]
    fn added_and_removed_columns_are_classified() {
        let s = vec![table("t", vec![col("id", "int"), col("only_src", "int")])];
        let t = vec![table("t", vec![col("id", "int"), col("only_tgt", "int")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        // Only the two differing columns appear; the identical `id` is omitted.
        assert_eq!(d.tables[0].columns.len(), 2);
        // Sorted by name: only_src, only_tgt.
        assert_eq!(d.tables[0].columns[0].name, "only_src");
        assert_eq!(d.tables[0].columns[0].status, DiffStatus::SourceOnly);
        assert_eq!(d.tables[0].columns[1].name, "only_tgt");
        assert_eq!(d.tables[0].columns[1].status, DiffStatus::TargetOnly);
    }

    #[test]
    fn changed_column_reports_each_differing_field() {
        let mut s_col = col("v", "int");
        s_col.nullable = true;
        s_col.default = Some("0".to_string());
        let mut t_col = col("v", "bigint");
        t_col.nullable = false;
        t_col.default = Some("1".to_string());
        let s = vec![table("t", vec![s_col])];
        let t = vec![table("t", vec![t_col])];
        let d = diff(&s, &t);
        let cd = &d.tables[0].columns[0];
        assert_eq!(cd.status, DiffStatus::Different);
        assert!(cd.changed_fields.contains(&"data_type".to_string()));
        assert!(cd.changed_fields.contains(&"nullable".to_string()));
        assert!(cd.changed_fields.contains(&"default".to_string()));
    }

    #[test]
    fn data_type_and_key_comparison_is_case_insensitive() {
        let mut s_col = col("id", "INT");
        s_col.key = "PRI".to_string();
        let mut t_col = col("id", "int");
        t_col.key = "pri".to_string();
        let s = vec![table("t", vec![s_col])];
        let t = vec![table("t", vec![t_col])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
    }

    #[test]
    fn foreign_key_change_is_detected() {
        let mut s_col = col("user_id", "int");
        s_col.referenced_table = Some("users".to_string());
        s_col.referenced_column = Some("id".to_string());
        let t_col = col("user_id", "int"); // no FK
        let s = vec![table("t", vec![s_col])];
        let t = vec![table("t", vec![t_col])];
        let d = diff(&s, &t);
        let cd = &d.tables[0].columns[0];
        assert_eq!(cd.status, DiffStatus::Different);
        assert_eq!(cd.changed_fields, vec!["foreign_key".to_string()]);
    }

    #[test]
    fn tables_are_sorted_and_union_is_deduplicated() {
        let s = vec![
            table("b", vec![col("x", "int")]),
            table("a", vec![col("x", "int")]),
        ];
        let t = vec![
            table("c", vec![col("x", "int")]),
            table("a", vec![col("x", "int")]),
        ];
        let d = diff(&s, &t);
        let names: Vec<&str> = d.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
        assert_eq!(d.tables[0].status, DiffStatus::Same); // a present both, identical
        assert_eq!(d.tables[1].status, DiffStatus::SourceOnly); // b
        assert_eq!(d.tables[2].status, DiffStatus::TargetOnly); // c
    }

    #[test]
    fn drivers_are_carried_through() {
        let d = compute_schema_diff(DriverKind::Postgres, DriverKind::Postgres, &[], &[]);
        assert_eq!(d.source_driver, DriverKind::Postgres);
        assert_eq!(d.target_driver, DriverKind::Postgres);
        assert!(d.tables.is_empty());
    }

    // --- 修正 L4: 長さ/精度付き data_type の比較 (PostgreSQL introspection が
    // `character varying(50)` / `numeric(10,2)` のような完全型文字列を返す
    // ようになる変更を受けて) ---------------------------------------------

    #[test]
    fn varchar_length_difference_is_detected_as_different() {
        let s = vec![table("t", vec![col("name", "character varying(50)")])];
        let t = vec![table("t", vec![col("name", "character varying(255)")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        assert_eq!(
            d.tables[0].columns[0].changed_fields,
            vec!["data_type".to_string()]
        );
    }

    #[test]
    fn numeric_precision_scale_difference_is_detected() {
        let s = vec![table("t", vec![col("price", "numeric(10,2)")])];
        let t = vec![table("t", vec![col("price", "numeric(12,4)")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        assert!(d.tables[0].columns[0]
            .changed_fields
            .contains(&"data_type".to_string()));
    }

    #[test]
    fn identical_length_qualified_types_are_case_insensitive_same() {
        // 大文字小文字だけが違う場合 (ドライバがまれに揺れる可能性) は従来
        // どおり同一視する。長さ部分の数字は大小文字の影響を受けない。
        let s = vec![table("t", vec![col("name", "CHARACTER VARYING(50)")])];
        let t = vec![table("t", vec![col("name", "character varying(50)")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
    }

    #[test]
    fn column_comment_difference_is_detected_but_empty_equals_none() {
        let mut s = col("name", "text");
        s.comment = Some("ユーザ名".to_string());
        let t = col("name", "text");
        let d = diff(
            &[table("u", vec![s.clone()])],
            &[table("u", vec![t.clone()])],
        );
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        assert_eq!(d.tables[0].columns[0].changed_fields, vec!["comment"]);

        let mut empty = t;
        empty.comment = Some(String::new());
        let same = diff(
            &[table("u", vec![col("name", "text")])],
            &[table("u", vec![empty])],
        );
        assert_eq!(same.tables[0].status, DiffStatus::Same);
    }

    #[test]
    fn target_fks_attach_to_remaining_tables_referencing_target_only() {
        let t = |n: &str| table(n, vec![col("id", "int")]);
        let mut d = diff(&[t("child")], &[t("child"), t("parent"), t("other")]);
        let mk = |table: &str, to: &str| ForeignKey {
            table: table.to_string(),
            column: "pid".to_string(),
            referenced_table: to.to_string(),
            referenced_column: Some("id".to_string()),
            constraint_name: Some("fk".to_string()),
            on_delete: Some("CASCADE".to_string()),
            on_update: None,
        };
        attach_target_foreign_keys(&mut d, &[mk("child", "Parent"), mk("child", "child")]);
        let child = d.tables.iter().find(|t| t.name == "child").unwrap();
        assert_eq!(child.status, DiffStatus::Same);
        assert_eq!(child.foreign_keys.len(), 1);
        assert_eq!(child.foreign_keys[0].referenced_table, "Parent");
        assert_eq!(child.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    }
}
