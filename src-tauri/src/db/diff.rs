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

use super::ddl_extras::{normalize_check, normalize_expr};
use super::types::{
    CheckConstraintInfo, ForeignKey, GeneratedColumnInfo, IndexInfo, TableColumnInfo,
    TableDdlExtras, TableIndexes,
};
use super::DriverKind;

/// Where a table or column sits relative to the two schemas being compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    /// Present only in the source schema (would be added to the target).
    SourceOnly,
    /// Present only in the target schema (would be removed from the target).
    TargetOnly,
    /// Present in both, but the definitions differ.
    Different,
    /// Present in both with identical definitions.
    #[default]
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// インデックス (UNIQUE 含む、主キー以外) の差分 (#1625)。[`attach_index_diffs`] を
    /// 呼んだ経路 (スキーマ比較) でのみ埋まる。`SourceOnly` テーブルは source の
    /// インデックスを全て `SourceOnly` で持ち (`CREATE TABLE` の後に作る)、
    /// `Same` / `Different` テーブルは差のあるものだけを持つ。
    #[serde(default)]
    pub indexes: Vec<IndexDiff>,
    /// 既存テーブルの外部キー制約の差分 (追加・削除・参照動作の変更, #1625)。
    /// [`attach_foreign_key_diffs`] を呼んだ経路でのみ埋まる。`foreign_keys` とは別物。
    #[serde(default)]
    pub fk_changes: Vec<ForeignKeyDiff>,
    /// SQLite の列変更 (テーブル再作成) に必要な target 側の完全な定義 (#1625)。
    /// [`attach_sqlite_rebuild_context`] が `Different` テーブルにだけ載せる。
    #[serde(default)]
    pub target_snapshot: Option<TargetTableSnapshot>,
    /// CHECK 制約の差分 (#1837)。[`attach_extras_diffs`] を呼んだ経路でのみ埋まる。
    /// `SourceOnly` テーブルは source の CHECK を全て `SourceOnly` で持つ (`CREATE TABLE` に
    /// 含める)。既存テーブルは差のあるものだけ。
    #[serde(default)]
    pub check_changes: Vec<CheckDiff>,
    /// 生成列の式の差分 (#1837)。[`attach_extras_diffs`] を呼んだ経路でのみ埋まる。
    /// 列自体の差分 (`columns`) とは別に、式・STORED/VIRTUAL の違いを持つ。
    #[serde(default)]
    pub generated_changes: Vec<GeneratedDiff>,
}

/// CHECK 制約 1 本の差分 (#1837)。`name` は制約名 (無名の SQLite 制約は空)。
/// 名前ではなく式の正規化形で対応づける (名前だけの違いは差分にしない)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckDiff {
    pub name: String,
    pub status: DiffStatus,
    pub source: Option<CheckConstraintInfo>,
    pub target: Option<CheckConstraintInfo>,
}

/// 生成列の式の差分 (#1837)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedDiff {
    pub column: String,
    pub status: DiffStatus,
    pub source: Option<GeneratedColumnInfo>,
    pub target: Option<GeneratedColumnInfo>,
    /// `Different` のとき `expression` / `storage` (STORED と VIRTUAL の違い)。
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

/// インデックス 1 本の定義。`IndexInfo` は内部用の項目を IPC に出さない (`serde(skip)`)
/// ので、往復する diff 用に全項目を直列化できる形で持つ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub method: Option<String>,
    #[serde(default)]
    pub predicate: Option<String>,
    #[serde(default)]
    pub first_expression_at: Option<usize>,
    #[serde(default)]
    pub key_column_count: Option<usize>,
    #[serde(default)]
    pub column_options: Vec<String>,
    #[serde(default)]
    pub nulls_not_distinct: bool,
}

impl DiffIndex {
    fn from_info(i: &IndexInfo) -> Self {
        Self {
            name: i.name.clone(),
            columns: i.columns.clone(),
            unique: i.unique,
            method: i.method.clone(),
            predicate: i.predicate.clone(),
            first_expression_at: i.first_expression_at,
            key_column_count: i.key_column_count,
            column_options: i.column_options.clone(),
            nulls_not_distinct: i.nulls_not_distinct,
        }
    }

    pub(crate) fn to_info(&self) -> IndexInfo {
        IndexInfo {
            name: self.name.clone(),
            columns: self.columns.clone(),
            unique: self.unique,
            primary: false,
            method: self.method.clone(),
            predicate: self.predicate.clone(),
            first_expression_at: self.first_expression_at,
            key_column_count: self.key_column_count,
            column_options: self.column_options.clone(),
            nulls_not_distinct: self.nulls_not_distinct,
            ..Default::default()
        }
    }
}

/// 1 インデックスの差分。`changed_fields` は `Different` のとき、違う属性名
/// (`columns` / `unique` / `method` / `predicate` / `include` / `order` / `expression`)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDiff {
    pub name: String,
    pub status: DiffStatus,
    pub source: Option<DiffIndex>,
    pub target: Option<DiffIndex>,
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

/// 既存テーブルの外部キー 1 制約の差分。制約名ではなく (列, 参照先テーブル) で対応づける
/// (名前だけの違いは差分にしない)。`changed_fields` は `Different` のとき
/// `on_delete` / `on_update` / `referenced_columns`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyDiff {
    pub status: DiffStatus,
    pub source: Option<DiffForeignKey>,
    pub target: Option<DiffForeignKey>,
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

/// SQLite のテーブル再作成 (12 ステップ手順) が必要とする target 側の完全な定義。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TargetTableSnapshot {
    /// target の全列 (差分に出ない同一の列も含む)。
    pub columns: Vec<TableColumnInfo>,
    /// target の全外部キー制約。
    #[serde(default)]
    pub foreign_keys: Vec<DiffForeignKey>,
    /// UNIQUE 制約 (`sqlite_autoindex_*`) の列。再作成で失わないよう `UNIQUE (...)` で出す。
    #[serde(default)]
    pub unique_constraints: Vec<Vec<String>>,
    /// 旧表を DROP すると消えるインデックス・トリガーの元の `CREATE` 文 (`sqlite_master.sql`)。
    #[serde(default)]
    pub recreate_sql: Vec<String>,
    /// 表を参照するビュー。`RENAME` のスキーマ検査を通すため、旧表の `DROP` の前に
    /// 落として (名前)、再作成後に `recreate_sql` の末尾で作り直す。
    #[serde(default)]
    pub drop_views: Vec<String>,
    /// 元の `CREATE TABLE` 文。再現できない構文 (CHECK など) の警告に使う。
    #[serde(default)]
    pub original_sql: Option<String>,
    /// この表を外部キーで参照する他の表 (`表名 (ON DELETE ...)`)。再作成の警告に使う。
    #[serde(default)]
    pub referenced_by: Vec<String>,
    /// target の CHECK 制約 (テーブル再作成で失わないよう `CONSTRAINT ... CHECK` で出す, #1837)。
    /// `extras_known` が true のときだけ信頼できる。
    #[serde(default)]
    pub checks: Vec<CheckConstraintInfo>,
    /// target の生成列 (SQLite の `table_info` は生成列を隠すので別に持つ, #1837)。
    #[serde(default)]
    pub generated: Vec<GeneratedColumnInfo>,
    /// `checks` / `generated` を取得できたか。false なら再作成 SQL の警告に
    /// 「CHECK / 生成列は含まれない」を残す。
    #[serde(default)]
    pub extras_known: bool,
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
    /// 同期計画の警告にそのまま載せる。
    #[serde(default)]
    pub warnings: Vec<String>,
    /// インデックスの差分を比較済みか ([`attach_index_diffs`] を通ったか)。true なら
    /// `CREATE TABLE` 同期は「索引が含まれません」の警告を出さず `CREATE INDEX` を出す。
    #[serde(default)]
    pub indexes_compared: bool,
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
                    ..Default::default()
                },
                (None, Some(t)) => TableDiff {
                    name,
                    status: DiffStatus::TargetOnly,
                    columns: one_sided_columns(&t.columns, DiffStatus::TargetOnly),
                    ..Default::default()
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
                        ..Default::default()
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
        indexes_compared: false,
    }
}

/// インデックス差分の対象か。主キーは列の `key` で比べ、SQLite の UNIQUE 制約に紐づく
/// 自動インデックス (`sqlite_autoindex_*`、名前が合成で作り直せない) は対象外。
fn is_comparable_index(i: &IndexInfo) -> bool {
    !i.primary && !i.name.starts_with("sqlite_autoindex_")
}

fn normalize_predicate(p: &Option<String>) -> Option<String> {
    p.as_deref()
        .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|p| !p.is_empty())
}

/// 同名のインデックス 2 本の違いを属性名で返す。アクセスメソッドは省略 (SQLite) と
/// `btree` を同一視し、大小は無視する。
fn index_changed_fields(s: &DiffIndex, t: &DiffIndex) -> Vec<String> {
    let method = |m: &Option<String>| m.as_deref().unwrap_or("btree").to_ascii_lowercase();
    let mut fields = Vec::new();
    if s.columns != t.columns {
        fields.push("columns".to_string());
    }
    if s.unique != t.unique {
        fields.push("unique".to_string());
    }
    if method(&s.method) != method(&t.method) {
        fields.push("method".to_string());
    }
    if normalize_predicate(&s.predicate) != normalize_predicate(&t.predicate) {
        fields.push("predicate".to_string());
    }
    // INCLUDE 列の境目 (`None` は全列がキー列)。
    let include_len = |i: &DiffIndex| {
        i.key_column_count
            .map_or(0, |k| i.columns.len().saturating_sub(k))
    };
    if include_len(s) != include_len(t) {
        fields.push("include".to_string());
    }
    if s.column_options != t.column_options
        && !(s.column_options.iter().all(String::is_empty)
            && t.column_options.iter().all(String::is_empty))
    {
        fields.push("order".to_string());
    }
    if s.first_expression_at != t.first_expression_at
        || s.nulls_not_distinct != t.nulls_not_distinct
    {
        fields.push("expression".to_string());
    }
    fields
}

/// 両側のインデックスを比べて各テーブルの `indexes` に載せる (#1625)。`SourceOnly` テーブルは
/// source のインデックスを全て `SourceOnly` で載せ (`CREATE TABLE` の後に作る)、`TargetOnly` は
/// `DROP TABLE` で消えるので載せない。`Same` / `Different` は同名で突き合わせ、差のあるものだけを
/// 載せる。差があれば `Same` を `Different` に格上げする。比較済みの印 (`indexes_compared`) を立てる。
pub fn attach_index_diffs(diff: &mut SchemaDiff, source: &[TableIndexes], target: &[TableIndexes]) {
    let by_table = |all: &'_ [TableIndexes]| -> HashMap<String, Vec<DiffIndex>> {
        all.iter()
            .map(|t| {
                (
                    t.name.clone(),
                    t.indexes
                        .iter()
                        .filter(|i| is_comparable_index(i))
                        .map(DiffIndex::from_info)
                        .collect(),
                )
            })
            .collect()
    };
    let src = by_table(source);
    let tgt = by_table(target);
    let empty: Vec<DiffIndex> = Vec::new();
    for table in diff.tables.iter_mut() {
        let s = src.get(&table.name).unwrap_or(&empty);
        let t = tgt.get(&table.name).unwrap_or(&empty);
        match table.status {
            DiffStatus::SourceOnly => {
                table.indexes = s
                    .iter()
                    .map(|i| IndexDiff {
                        name: i.name.clone(),
                        status: DiffStatus::SourceOnly,
                        source: Some(i.clone()),
                        target: None,
                        changed_fields: Vec::new(),
                    })
                    .collect();
            }
            DiffStatus::TargetOnly => {}
            DiffStatus::Same | DiffStatus::Different => {
                table.indexes = diff_indexes(s, t);
                if !table.indexes.is_empty() && table.status == DiffStatus::Same {
                    table.status = DiffStatus::Different;
                }
            }
        }
    }
    diff.indexes_compared = true;
}

fn diff_indexes(source: &[DiffIndex], target: &[DiffIndex]) -> Vec<IndexDiff> {
    let names = sorted_union(
        source.iter().map(|i| i.name.as_str()),
        target.iter().map(|i| i.name.as_str()),
    );
    let mut out = Vec::new();
    for name in names {
        let s = source.iter().find(|i| i.name == name);
        let t = target.iter().find(|i| i.name == name);
        match (s, t) {
            (Some(s), None) => out.push(IndexDiff {
                name,
                status: DiffStatus::SourceOnly,
                source: Some(s.clone()),
                target: None,
                changed_fields: Vec::new(),
            }),
            (None, Some(t)) => out.push(IndexDiff {
                name,
                status: DiffStatus::TargetOnly,
                source: None,
                target: Some(t.clone()),
                changed_fields: Vec::new(),
            }),
            (Some(s), Some(t)) => {
                let changed = index_changed_fields(s, t);
                if !changed.is_empty() {
                    out.push(IndexDiff {
                        name,
                        status: DiffStatus::Different,
                        source: Some(s.clone()),
                        target: Some(t.clone()),
                        changed_fields: changed,
                    });
                }
            }
            (None, None) => {}
        }
    }
    out
}

/// 外部キー 1 制約を diff 用の形にする (名前が使えなければ `None`)。
fn diff_fk_of(table: &str, g: &super::table_ddl::FkGroup<'_>) -> DiffForeignKey {
    DiffForeignKey {
        name: g
            .name
            .filter(|n| is_usable_constraint_name(table, n))
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
    }
}

fn all_diff_fks(table: &str, fks: &[ForeignKey]) -> Vec<DiffForeignKey> {
    super::table_ddl::group_foreign_keys(table, fks)
        .iter()
        .map(|g| diff_fk_of(table, g))
        .collect()
}

/// 外部キーを (列, 参照先テーブル) で同一視するためのキー。表記の大小は無視する。
fn fk_signature(fk: &DiffForeignKey) -> String {
    format!(
        "{}->{}",
        fk.columns
            .iter()
            .map(|c| c.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join(","),
        fk.referenced_table.to_ascii_lowercase()
    )
}

fn fk_changed_fields(s: &DiffForeignKey, t: &DiffForeignKey) -> Vec<String> {
    let action = |a: &Option<String>| {
        a.as_deref()
            .map(|a| a.trim().to_ascii_uppercase())
            .filter(|a| !a.is_empty() && a != "NO ACTION")
    };
    let mut fields = Vec::new();
    if action(&s.on_delete) != action(&t.on_delete) {
        fields.push("on_delete".to_string());
    }
    if action(&s.on_update) != action(&t.on_update) {
        fields.push("on_update".to_string());
    }
    let refs = |f: &DiffForeignKey| {
        f.referenced_columns
            .iter()
            .map(|c| c.to_ascii_lowercase())
            .collect::<Vec<_>>()
    };
    // 参照先列が解決できていない側 (空) は比べない。
    if !s.referenced_columns.is_empty() && !t.referenced_columns.is_empty() && refs(s) != refs(t) {
        fields.push("referenced_columns".to_string());
    }
    fields
}

/// 既存テーブル (`Same` / `Different`) の外部キーを両側で比べて `fk_changes` に載せる
/// (#1625)。追加・削除・`ON DELETE` / `ON UPDATE` の違いが対象。差があれば `Same` を
/// `Different` に格上げする。
pub fn attach_foreign_key_diffs(
    diff: &mut SchemaDiff,
    source_fks: &[ForeignKey],
    target_fks: &[ForeignKey],
) {
    for table in diff
        .tables
        .iter_mut()
        .filter(|t| matches!(t.status, DiffStatus::Same | DiffStatus::Different))
    {
        let s = all_diff_fks(&table.name, source_fks);
        let t = all_diff_fks(&table.name, target_fks);
        let mut changes = Vec::new();
        for sf in &s {
            let sig = fk_signature(sf);
            match t.iter().find(|tf| fk_signature(tf) == sig) {
                None => changes.push(ForeignKeyDiff {
                    status: DiffStatus::SourceOnly,
                    source: Some(sf.clone()),
                    target: None,
                    changed_fields: Vec::new(),
                }),
                Some(tf) => {
                    let changed = fk_changed_fields(sf, tf);
                    if !changed.is_empty() {
                        changes.push(ForeignKeyDiff {
                            status: DiffStatus::Different,
                            source: Some(sf.clone()),
                            target: Some(tf.clone()),
                            changed_fields: changed,
                        });
                    }
                }
            }
        }
        for tf in &t {
            let sig = fk_signature(tf);
            if !s.iter().any(|sf| fk_signature(sf) == sig) {
                changes.push(ForeignKeyDiff {
                    status: DiffStatus::TargetOnly,
                    source: None,
                    target: Some(tf.clone()),
                    changed_fields: Vec::new(),
                });
            }
        }
        if !changes.is_empty() && table.status == DiffStatus::Same {
            table.status = DiffStatus::Different;
        }
        table.fk_changes = changes;
    }
}

fn check_info(name: &str, def: &str) -> CheckConstraintInfo {
    CheckConstraintInfo {
        name: name.to_string(),
        definition: def.to_string(),
    }
}

/// 1 テーブルぶんの CHECK 制約を突き合わせる。式の正規化形が同じものは名前が違っても同一、
/// 同名で式が違えば `Different`、残りは片側のみ。
fn diff_checks(source: &[(String, String)], target: &[(String, String)]) -> Vec<CheckDiff> {
    let mut out = Vec::new();
    let mut t_used = vec![false; target.len()];
    let mut s_left: Vec<&(String, String)> = Vec::new();
    for s in source {
        let norm = normalize_check(&s.1);
        match target
            .iter()
            .enumerate()
            .find(|(i, t)| !t_used[*i] && normalize_check(&t.1) == norm)
        {
            Some((i, _)) => t_used[i] = true,
            None => s_left.push(s),
        }
    }
    let mut t_left: Vec<&(String, String)> = target
        .iter()
        .enumerate()
        .filter(|(i, _)| !t_used[*i])
        .map(|(_, t)| t)
        .collect();
    for s in s_left {
        // 同名 (無名は除く) で式だけ違うものは Different に。
        let pos = (!s.0.is_empty())
            .then(|| t_left.iter().position(|t| t.0 == s.0))
            .flatten();
        match pos {
            Some(p) => {
                let t = t_left.remove(p);
                out.push(CheckDiff {
                    name: s.0.clone(),
                    status: DiffStatus::Different,
                    source: Some(check_info(&s.0, &s.1)),
                    target: Some(check_info(&t.0, &t.1)),
                });
            }
            None => out.push(CheckDiff {
                name: s.0.clone(),
                status: DiffStatus::SourceOnly,
                source: Some(check_info(&s.0, &s.1)),
                target: None,
            }),
        }
    }
    for t in t_left {
        out.push(CheckDiff {
            name: t.0.clone(),
            status: DiffStatus::TargetOnly,
            source: None,
            target: Some(check_info(&t.0, &t.1)),
        });
    }
    out
}

fn diff_generated(
    source: &[GeneratedColumnInfo],
    target: &[GeneratedColumnInfo],
) -> Vec<GeneratedDiff> {
    let names = sorted_union(
        source.iter().map(|g| g.column.as_str()),
        target.iter().map(|g| g.column.as_str()),
    );
    let mut out = Vec::new();
    for column in names {
        let s = source.iter().find(|g| g.column == column);
        let t = target.iter().find(|g| g.column == column);
        match (s, t) {
            (Some(s), None) => out.push(GeneratedDiff {
                column,
                status: DiffStatus::SourceOnly,
                source: Some(s.clone()),
                target: None,
                changed_fields: Vec::new(),
            }),
            (None, Some(t)) => out.push(GeneratedDiff {
                column,
                status: DiffStatus::TargetOnly,
                source: None,
                target: Some(t.clone()),
                changed_fields: Vec::new(),
            }),
            (Some(s), Some(t)) => {
                let mut changed = Vec::new();
                if normalize_expr(&s.expression) != normalize_expr(&t.expression) {
                    changed.push("expression".to_string());
                }
                if s.is_virtual != t.is_virtual {
                    changed.push("storage".to_string());
                }
                // 型・NOT NULL は列情報に出ない生成列 (SQLite) だけ持つ。両側にあるときだけ比べる。
                if let (Some(st), Some(tt)) = (&s.data_type, &t.data_type) {
                    if !st.eq_ignore_ascii_case(tt) {
                        changed.push("data_type".to_string());
                    }
                    if s.not_null != t.not_null {
                        changed.push("nullable".to_string());
                    }
                }
                if !changed.is_empty() {
                    out.push(GeneratedDiff {
                        column,
                        status: DiffStatus::Different,
                        source: Some(s.clone()),
                        target: Some(t.clone()),
                        changed_fields: changed,
                    });
                }
            }
            (None, None) => {}
        }
    }
    out
}

/// 両側の CHECK 制約・生成列の式を比べて各テーブルの `check_changes` / `generated_changes` に
/// 載せる (#1837)。`SourceOnly` テーブルは source の全てを `SourceOnly` で載せ (`CREATE TABLE` に
/// 含める)、`TargetOnly` は `DROP TABLE` で消えるので載せない。`Same` / `Different` は差のある
/// ものだけを載せ、差があれば `Same` を `Different` に格上げする。これが無いと CHECK・生成式だけが
/// 違うスキーマが偽の「一致」になる。
pub fn attach_extras_diffs(
    diff: &mut SchemaDiff,
    source: &[(String, TableDdlExtras)],
    target: &[(String, TableDdlExtras)],
) {
    let empty = TableDdlExtras::default();
    let src: HashMap<&str, &TableDdlExtras> = source.iter().map(|(n, e)| (n.as_str(), e)).collect();
    let tgt: HashMap<&str, &TableDdlExtras> = target.iter().map(|(n, e)| (n.as_str(), e)).collect();
    for table in diff.tables.iter_mut() {
        let s = src.get(table.name.as_str()).copied().unwrap_or(&empty);
        let t = tgt.get(table.name.as_str()).copied().unwrap_or(&empty);
        match table.status {
            DiffStatus::SourceOnly => {
                table.check_changes = diff_checks(&s.checks, &[]);
                table.generated_changes = diff_generated(&s.generated, &[]);
            }
            DiffStatus::TargetOnly => {}
            DiffStatus::Same | DiffStatus::Different => {
                table.check_changes = diff_checks(&s.checks, &t.checks);
                table.generated_changes = diff_generated(&s.generated, &t.generated);
                if table.status == DiffStatus::Same
                    && (!table.check_changes.is_empty() || !table.generated_changes.is_empty())
                {
                    table.status = DiffStatus::Different;
                }
            }
        }
    }
}

/// SQLite の再作成が失わないよう、target の CHECK 制約と生成列を `target_snapshot` に載せる。
/// [`attach_sqlite_rebuild_context`] の後に呼ぶ (#1837)。
pub fn attach_target_extras_to_snapshots(
    diff: &mut SchemaDiff,
    target: &[(String, TableDdlExtras)],
) {
    let tgt: HashMap<&str, &TableDdlExtras> = target.iter().map(|(n, e)| (n.as_str(), e)).collect();
    let empty = TableDdlExtras::default();
    for table in diff.tables.iter_mut() {
        let Some(snap) = table.target_snapshot.as_mut() else {
            continue;
        };
        let e = tgt.get(table.name.as_str()).copied().unwrap_or(&empty);
        snap.checks = e.checks.iter().map(|(n, d)| check_info(n, d)).collect();
        snap.generated = e.generated.clone();
        snap.extras_known = true;
    }
}

/// `sqlite_master` の 1 行 (索引・トリガー・表の元の `CREATE` 文)。
#[derive(Debug, Clone)]
pub struct SqliteMasterEntry {
    /// `table` / `index` / `trigger`
    pub kind: String,
    pub name: String,
    pub table: String,
    pub sql: String,
}

/// SQLite の target で、テーブル再作成が要る表 (列の変更・外部キーの変更がある `Different`)
/// に、再作成に必要な target の完全な定義を載せる (#1625)。
pub fn attach_sqlite_rebuild_context(
    diff: &mut SchemaDiff,
    target_tables: &[TableColumns],
    target_fks: &[ForeignKey],
    target_indexes: &[TableIndexes],
    master: &[SqliteMasterEntry],
) {
    if diff.target_driver != DriverKind::Sqlite {
        return;
    }
    for table in diff.tables.iter_mut().filter(|t| {
        t.status == DiffStatus::Different
            && (t.columns.iter().any(|c| c.status == DiffStatus::Different)
                || !t.fk_changes.is_empty()
                || !t.check_changes.is_empty()
                || !t.generated_changes.is_empty())
    }) {
        let Some(tt) = target_tables.iter().find(|t| t.name == table.name) else {
            continue;
        };
        let lower = table.name.to_ascii_lowercase();
        let referenced_by = target_fks
            .iter()
            .filter(|f| f.referenced_table.to_ascii_lowercase() == lower && f.table != table.name)
            .map(|f| {
                format!(
                    "{} ({})",
                    f.table,
                    f.on_delete
                        .as_deref()
                        .map(|a| format!("ON DELETE {a}"))
                        .unwrap_or_else(|| "ON DELETE NO ACTION".to_string())
                )
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let unique_constraints = target_indexes
            .iter()
            .filter(|t| t.name == table.name)
            .flat_map(|t| t.indexes.iter())
            .filter(|i| i.unique && !i.primary && i.name.starts_with("sqlite_autoindex_"))
            .filter(|i| i.first_expression_at.is_none() && !i.columns.is_empty())
            .map(|i| i.columns.clone())
            .collect();
        table.target_snapshot = Some(TargetTableSnapshot {
            columns: tt.columns.clone(),
            foreign_keys: all_diff_fks(&table.name, target_fks),
            unique_constraints,
            recreate_sql: master
                .iter()
                .filter(|m| m.table == table.name && matches!(m.kind.as_str(), "index" | "trigger"))
                .map(|m| m.sql.clone())
                .chain(
                    master
                        .iter()
                        .filter(|m| m.kind == "view" && m.sql.to_ascii_lowercase().contains(&lower))
                        .map(|m| m.sql.clone()),
                )
                .collect(),
            drop_views: master
                .iter()
                .filter(|m| m.kind == "view" && m.sql.to_ascii_lowercase().contains(&lower))
                .map(|m| m.name.clone())
                .collect(),
            original_sql: master
                .iter()
                .find(|m| m.kind == "table" && m.name == table.name)
                .map(|m| m.sql.clone()),
            referenced_by,
            checks: Vec::new(),
            generated: Vec::new(),
            extras_known: false,
        });
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

    fn ti(table: &str, indexes: Vec<IndexInfo>) -> TableIndexes {
        TableIndexes {
            name: table.to_string(),
            indexes,
        }
    }

    fn ix(name: &str, cols: &[&str], unique: bool) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            unique,
            ..Default::default()
        }
    }

    #[test]
    fn index_diffs_classify_added_removed_and_changed_and_promote_same_tables() {
        let tables = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&tables, &tables);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
        let src = vec![ti(
            "t",
            vec![
                ix("only_src", &["a"], false),
                ix("both", &["a", "b"], true),
                ix("same", &["a"], false),
                IndexInfo {
                    primary: true,
                    ..ix("PRIMARY", &["a"], true)
                },
            ],
        )];
        let tgt = vec![ti(
            "t",
            vec![
                ix("only_tgt", &["a"], false),
                ix("both", &["a"], false),
                ix("same", &["a"], false),
                ix("sqlite_autoindex_t_1", &["a"], true),
            ],
        )];
        attach_index_diffs(&mut d, &src, &tgt);
        assert!(d.indexes_compared);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        let by: Vec<(&str, DiffStatus)> = d.tables[0]
            .indexes
            .iter()
            .map(|i| (i.name.as_str(), i.status))
            .collect();
        assert_eq!(
            by,
            vec![
                ("both", DiffStatus::Different),
                ("only_src", DiffStatus::SourceOnly),
                ("only_tgt", DiffStatus::TargetOnly),
            ]
        );
        assert_eq!(
            d.tables[0].indexes[0].changed_fields,
            vec!["columns", "unique"]
        );
    }

    #[test]
    fn index_method_default_and_predicate_whitespace_are_not_differences() {
        let mut a = ix("i", &["a"], false);
        a.method = Some("BTREE".into());
        a.predicate = Some("(x  IS NULL)".into());
        let mut b = ix("i", &["a"], false);
        b.predicate = Some("(x IS NULL)".into());
        assert!(
            index_changed_fields(&DiffIndex::from_info(&a), &DiffIndex::from_info(&b)).is_empty()
        );
    }

    #[test]
    fn foreign_key_actions_are_compared_by_columns_and_parent_not_name() {
        fn fk(name: &str, on_delete: Option<&str>) -> ForeignKey {
            ForeignKey {
                table: "t".into(),
                column: "pid".into(),
                referenced_table: "p".into(),
                referenced_column: Some("id".into()),
                constraint_name: Some(name.into()),
                on_delete: on_delete.map(str::to_string),
                on_update: None,
            }
        }
        let tables = vec![table("t", vec![col("pid", "int")])];
        let mut d = diff(&tables, &tables);
        attach_foreign_key_diffs(&mut d, &[fk("a", Some("CASCADE"))], &[fk("b", None)]);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        assert_eq!(d.tables[0].fk_changes[0].changed_fields, vec!["on_delete"]);
        let mut same = diff(&tables, &tables);
        attach_foreign_key_diffs(&mut same, &[fk("a", None)], &[fk("b", None)]);
        assert!(same.tables[0].fk_changes.is_empty());
        let mut added = diff(&tables, &tables);
        attach_foreign_key_diffs(&mut added, &[fk("a", None)], &[]);
        assert_eq!(added.tables[0].fk_changes[0].status, DiffStatus::SourceOnly);
    }

    fn extras(checks: &[(&str, &str)], generated: &[(&str, &str, bool)]) -> TableDdlExtras {
        TableDdlExtras {
            checks: checks
                .iter()
                .map(|(n, d)| (n.to_string(), d.to_string()))
                .collect(),
            generated: generated
                .iter()
                .map(|(c, e, v)| GeneratedColumnInfo::new(*c, *e, *v))
                .collect(),
        }
    }

    #[test]
    fn check_only_difference_is_no_longer_a_false_same() {
        let s = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&s, &s);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
        attach_extras_diffs(
            &mut d,
            &[("t".into(), extras(&[("a_pos", "CHECK (a > 0)")], &[]))],
            &[("t".into(), extras(&[], &[]))],
        );
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        assert_eq!(d.tables[0].check_changes.len(), 1);
        assert_eq!(d.tables[0].check_changes[0].status, DiffStatus::SourceOnly);
    }

    #[test]
    fn equivalent_checks_with_different_names_or_spacing_are_same() {
        let s = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&s, &s);
        attach_extras_diffs(
            &mut d,
            &[("t".into(), extras(&[("a_pos", "CHECK ((a > 0))")], &[]))],
            &[("t".into(), extras(&[("t_chk_1", "check (a>0)")], &[]))],
        );
        assert_eq!(d.tables[0].status, DiffStatus::Same);
        assert!(d.tables[0].check_changes.is_empty());
    }

    #[test]
    fn same_named_check_with_changed_expression_is_different() {
        let s = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&s, &s);
        attach_extras_diffs(
            &mut d,
            &[("t".into(), extras(&[("c", "CHECK (a > 0)")], &[]))],
            &[("t".into(), extras(&[("c", "CHECK (a > 5)")], &[]))],
        );
        let ch = &d.tables[0].check_changes;
        assert_eq!(ch.len(), 1);
        assert_eq!(ch[0].status, DiffStatus::Different);
    }

    #[test]
    fn target_only_check_is_reported() {
        let s = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&s, &s);
        attach_extras_diffs(
            &mut d,
            &[],
            &[("t".into(), extras(&[("c", "CHECK (a > 0)")], &[]))],
        );
        assert_eq!(d.tables[0].check_changes[0].status, DiffStatus::TargetOnly);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
    }

    #[test]
    fn generated_expression_and_storage_changes_are_detected() {
        let s = vec![table("t", vec![col("a", "int"), col("g", "int")])];
        let mut d = diff(&s, &s);
        attach_extras_diffs(
            &mut d,
            &[("t".into(), extras(&[], &[("g", "a + 1", false)]))],
            &[("t".into(), extras(&[], &[("g", "(a+2)", true)]))],
        );
        let g = &d.tables[0].generated_changes;
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].status, DiffStatus::Different);
        assert_eq!(g[0].changed_fields, vec!["expression", "storage"]);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
    }

    #[test]
    fn equivalent_generated_expressions_are_same() {
        let s = vec![table("t", vec![col("a", "int"), col("g", "int")])];
        let mut d = diff(&s, &s);
        attach_extras_diffs(
            &mut d,
            &[("t".into(), extras(&[], &[("g", "`a` + 1", false)]))],
            &[("t".into(), extras(&[], &[("g", "(`a`+1)", false)]))],
        );
        assert_eq!(d.tables[0].status, DiffStatus::Same);
    }

    #[test]
    fn source_only_table_carries_all_source_extras() {
        let s = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&s, &[]);
        attach_extras_diffs(
            &mut d,
            &[(
                "t".into(),
                extras(&[("c", "CHECK (a > 0)")], &[("g", "a", true)]),
            )],
            &[],
        );
        assert_eq!(d.tables[0].status, DiffStatus::SourceOnly);
        assert_eq!(d.tables[0].check_changes.len(), 1);
        assert_eq!(d.tables[0].generated_changes.len(), 1);
    }

    #[test]
    fn hidden_generated_column_type_difference_is_detected() {
        let s = vec![table("t", vec![col("a", "int")])];
        let mut d = diff(&s, &s);
        let mut src = GeneratedColumnInfo::new("g", "a + 1", false);
        src.data_type = Some("INTEGER".to_string());
        let mut tgt = src.clone();
        tgt.data_type = Some("TEXT".to_string());
        tgt.not_null = true;
        attach_extras_diffs(
            &mut d,
            &[(
                "t".into(),
                TableDdlExtras {
                    generated: vec![src],
                    ..Default::default()
                },
            )],
            &[(
                "t".into(),
                TableDdlExtras {
                    generated: vec![tgt],
                    ..Default::default()
                },
            )],
        );
        assert_eq!(
            d.tables[0].generated_changes[0].changed_fields,
            vec!["data_type", "nullable"]
        );
    }
}
