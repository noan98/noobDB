//! SQLite のテーブル構造エディタ向けテーブル再作成の計画 (#1888)。
//!
//! SQLite は `ALTER TABLE` で列の型 / NOT NULL / DEFAULT を変えたり、FK / CHECK 制約を
//! 足し引きしたりできない。構造エディタ (`AlterTableModal`) の編集内容 ([`SqliteRebuildEdit`])
//! を、スキーマ同期が持つ既存のテーブル再作成ロジック (`sync::sqlite_rebuild_sql`、
//! 新表作成 → `INSERT ... SELECT` → 旧表 `DROP` → `RENAME` → インデックス / トリガー /
//! ビューの作り直し) の入力 ([`TableDiff`] と [`TargetTableSnapshot`]) へ変換して SQL を作る。
//!
//! 生成した SQL は `apply_sync_sql` (= `SqliteConn::execute_sync_transaction`) で流す。
//! その経路が 1 トランザクション、`PRAGMA foreign_keys` の退避、コミット前の
//! `foreign_key_check` (違反が増えたらロールバック) を担う。このモジュールは SQL を作る
//! だけで、DB は変更しない (スナップショットの読み取りのみ)。
//!
//! 拡張点 (#1893 生成列など): 編集の入力は [`SqliteRebuildEdit`] に項目を足し、
//! [`build_table_diff`] で `generated_changes` を埋めるだけでよい (再作成側は対応済み)。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::ddl_extras::normalize_check;
use super::diff::{
    attach_sqlite_rebuild_context, attach_target_extras_to_snapshots, CheckDiff, ColumnDiff,
    DiffForeignKey, DiffStatus, ForeignKeyDiff, SchemaDiff, TableColumns, TableDiff,
    TargetTableSnapshot,
};
use super::sync::{
    created_index_name, index_tail, mask_string_literals, quote_ident, references_identifier,
    sqlite_rebuild_sql, SQLITE_FK_OFF,
};
use super::types::{CheckConstraintInfo, TableColumnInfo};
use super::{Connection, DriverKind};
use crate::error::{AppError, Result};

/// 既存列 1 本の編集後の定義。`original` が現状の列名、`name` が編集後の列名
/// (違えばリネーム)。`drop` が true の列は削除する (他の項目は無視)。
#[derive(Debug, Clone, Deserialize)]
pub struct RebuildColumnEdit {
    pub original: String,
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    /// 生の DEFAULT 式 (`describe_table` の `default` と同じ表記)。無ければ `None` / 空文字。
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub drop: bool,
}

/// 追加する列。
#[derive(Debug, Clone, Deserialize)]
pub struct RebuildNewColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    #[serde(default)]
    pub default: Option<String>,
}

/// 追加する外部キー。
#[derive(Debug, Clone, Deserialize)]
pub struct RebuildForeignKey {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
}

/// 削除する外部キー。SQLite の FK は実在の制約名を持たないので (列, 参照先テーブル) で指す。
#[derive(Debug, Clone, Deserialize)]
pub struct RebuildForeignKeyRef {
    pub columns: Vec<String>,
    pub ref_table: String,
}

/// 追加する CHECK 制約。`expression` は括弧の中身 (`price > 0`)。
#[derive(Debug, Clone, Deserialize)]
pub struct RebuildCheck {
    #[serde(default)]
    pub name: Option<String>,
    pub expression: String,
}

/// 構造エディタの編集内容一式。変更のない列も含めて全列を `columns` に載せる。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SqliteRebuildEdit {
    pub columns: Vec<RebuildColumnEdit>,
    #[serde(default)]
    pub added_columns: Vec<RebuildNewColumn>,
    #[serde(default)]
    pub added_foreign_keys: Vec<RebuildForeignKey>,
    #[serde(default)]
    pub dropped_foreign_keys: Vec<RebuildForeignKeyRef>,
    #[serde(default)]
    pub added_checks: Vec<RebuildCheck>,
    /// 削除する CHECK 制約の定義 (`describe` が返す `CHECK (...)` 句。式の正規化形で照合する)。
    #[serde(default)]
    pub dropped_checks: Vec<String>,
}

/// 実行前に利用者へ見せるべきリスクの種類。文言はフロントが i18n で組み立てる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqliteRebuildRiskKind {
    /// 列を削除する (その列のデータは失われる)。
    DropColumn,
    /// 型の親和性が変わる (`'007'` が `7` になるなど、保存される値が変換されうる)。
    TypeAffinity,
    /// NULL 可の列を NOT NULL にする (NULL の行があるとコピーに失敗して全体がロールバックされる)。
    NotNull,
    /// NOT NULL かつ DEFAULT なしの列を追加する (既存行があるとコピーに失敗する)。
    AddNotNullColumn,
    /// CHECK 制約を足す (既存行が違反するとコピーに失敗する)。
    AddCheck,
    /// 外部キーを足す (既存行が違反するとコミット前の検査で失敗する)。
    AddForeignKey,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteRebuildRisk {
    pub kind: SqliteRebuildRiskKind,
    /// 対象の列名 (制約のときは制約名 / 式の要約)。
    pub target: String,
}

/// `plan_sqlite_table_rebuild` の応答。
#[derive(Debug, Clone, Serialize)]
pub struct SqliteRebuildPlan {
    /// 再作成スクリプト (複数文を 1 つの文字列にしたもの。`apply_sync_sql` の 1 要素として流す)。
    pub sql: String,
    /// 再作成で再現できない構文・作り直す索引・子表の参照などの注意 (スキーマ同期と同じ文言)。
    pub warnings: Vec<String>,
    pub risks: Vec<SqliteRebuildRisk>,
}

/// 型名から SQLite の型の親和性 (<https://www.sqlite.org/datatype3.html#determination_of_column_affinity>)。
fn affinity(data_type: &str) -> &'static str {
    let u = data_type.to_ascii_uppercase();
    if u.contains("INT") {
        "INTEGER"
    } else if u.contains("CHAR") || u.contains("CLOB") || u.contains("TEXT") {
        "TEXT"
    } else if u.trim().is_empty() || u.contains("BLOB") {
        "BLOB"
    } else if u.contains("REAL") || u.contains("FLOA") || u.contains("DOUB") {
        "REAL"
    } else {
        "NUMERIC"
    }
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::InvalidInput(msg.into())
}

fn non_blank(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// SQL 中の識別子 `old` (引用符つきも含む) を `new` に置き換える。文字列リテラルとコメントの
/// 中は触らない。
fn rename_identifier(sql: &str, old: &str, new: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let new_ident = quote_ident(DriverKind::Sqlite, new);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                out.push(c);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            out.push('\'');
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            '"' | '`' | '[' => {
                let close = if c == '[' { ']' } else { c };
                let start = i;
                i += 1;
                let mut body = String::new();
                while i < chars.len() {
                    if chars[i] == close {
                        if close != ']' && chars.get(i + 1) == Some(&close) {
                            body.push(close);
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    body.push(chars[i]);
                    i += 1;
                }
                let end = (i + 1).min(chars.len());
                if body.eq_ignore_ascii_case(old) {
                    out.push_str(&new_ident);
                } else {
                    out.extend(chars[start..end].iter());
                }
                i = end;
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    out.push(chars[i]);
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                out.push_str("/*");
                i += 2;
                while i < chars.len() {
                    if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        out.push_str("*/");
                        i += 2;
                        break;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
            }
            _ if is_word(c) => {
                let start = i;
                while i < chars.len() && is_word(chars[i]) {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                if word.eq_ignore_ascii_case(old) {
                    out.push_str(&new_ident);
                } else {
                    out.push_str(&word);
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// インデックスの `CREATE INDEX` 文のうち、列リストと `WHERE` の部分だけで `old` を `new` にする
/// (索引名・表名と同名の列に反応しない)。
fn rename_in_index_sql(sql: &str, old: &str, new: &str) -> String {
    let tail = index_tail(sql);
    if tail.is_empty() {
        return sql.to_string();
    }
    let total = sql.chars().count();
    let tail_len = tail.chars().count();
    let head: String = sql.chars().take(total - tail_len).collect();
    let rest: String = sql.chars().skip(total - tail_len).collect();
    format!("{head}{}", rename_identifier(&rest, old, new))
}

/// スナップショットの列名の変更 (`renames` は (旧, 新))。構造化された定義 (列・FK・UNIQUE・CHECK・
/// 生成列) と、このテーブルのインデックスの `CREATE` 文を新しい名前へ揃える。トリガー / ビューは
/// 文の中の参照を機械的に直すと別表の同名の列まで巻き込みうるので、作り直さず警告に出す。
/// 実際の列名の変更は `ALTER TABLE ... RENAME COLUMN` を再作成スクリプトの先頭で行う
/// (SQLite 自身が子表の外部キーや他表のトリガーの参照を直す)。
fn apply_renames(
    table: &str,
    snap: &mut TargetTableSnapshot,
    renames: &[(String, String)],
    warnings: &mut Vec<String>,
) {
    for (old, new) in renames {
        for c in snap.columns.iter_mut().filter(|c| &c.name == old) {
            c.name = new.clone();
        }
        let swap = |name: &mut String| {
            if name == old {
                *name = new.clone();
            }
        };
        for fk in snap.foreign_keys.iter_mut() {
            fk.columns.iter_mut().for_each(swap);
            if fk.referenced_table.eq_ignore_ascii_case(table) {
                fk.referenced_columns.iter_mut().for_each(swap);
            }
        }
        for uq in snap.unique_constraints.iter_mut() {
            uq.iter_mut().for_each(swap);
        }
        for ck in snap.checks.iter_mut() {
            ck.definition = rename_identifier(&ck.definition, old, new);
        }
        for g in snap.generated.iter_mut() {
            if &g.column == old {
                g.column = new.clone();
            }
            g.expression = rename_identifier(&g.expression, old, new);
        }
        let mut kept: Vec<String> = Vec::with_capacity(snap.recreate_sql.len());
        for sql in std::mem::take(&mut snap.recreate_sql) {
            if created_index_name(&sql).is_some() {
                kept.push(rename_in_index_sql(&sql, old, new));
            } else if references_identifier(&mask_string_literals(&sql), old) {
                warnings.push(format!(
                    "{table}: 名前を変える列 {old} を参照するため、次の定義は再作成後に作り直しません。新しい列名 {new} で手動で作り直してください: {}",
                    sql.split_whitespace().collect::<Vec<_>>().join(" ")
                ));
            } else {
                kept.push(sql);
            }
        }
        snap.recreate_sql = kept;
    }
}

fn fk_sig(columns: &[String], ref_table: &str) -> String {
    format!(
        "{}->{}",
        columns
            .iter()
            .map(|c| c.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join(","),
        ref_table.to_ascii_lowercase()
    )
}

/// 編集内容を検証して列名の変更 (旧, 新) を取り出す。
fn collect_renames(
    edit: &SqliteRebuildEdit,
    snap: &TargetTableSnapshot,
) -> Result<Vec<(String, String)>> {
    let mut renames = Vec::new();
    let mut final_names: HashSet<String> = HashSet::new();
    for e in &edit.columns {
        if !snap.columns.iter().any(|c| c.name == e.original) {
            return Err(invalid(format!("column '{}' does not exist", e.original)));
        }
        if e.drop {
            continue;
        }
        let name = e.name.trim();
        if name.is_empty() {
            return Err(invalid(format!(
                "column '{}' has an empty name",
                e.original
            )));
        }
        if !final_names.insert(name.to_ascii_lowercase()) {
            return Err(invalid(format!("duplicate column name '{name}'")));
        }
        if name != e.original {
            // 他の列 (削除する列も含む) の現在の名前への改名は安全な順序を作れない。
            let clash = snap
                .columns
                .iter()
                .any(|c| c.name != e.original && c.name.eq_ignore_ascii_case(name));
            if clash {
                return Err(invalid(format!(
                    "cannot rename '{}' to '{name}': another column currently has that name (apply the drop/rename in separate steps)",
                    e.original
                )));
            }
            renames.push((e.original.clone(), name.to_string()));
        }
    }
    for c in &edit.added_columns {
        let name = c.name.trim();
        if name.is_empty() {
            return Err(invalid("added column has an empty name"));
        }
        if !final_names.insert(name.to_ascii_lowercase()) {
            return Err(invalid(format!("duplicate column name '{name}'")));
        }
    }
    if final_names.is_empty() {
        return Err(invalid("a table needs at least one column"));
    }
    Ok(renames)
}

/// 編集内容から [`TableDiff`] (再作成の入力) とリスクを作る。`snap` は列名の変更を反映済みのもの。
fn build_table_diff(
    table: &str,
    edit: &SqliteRebuildEdit,
    snap: &TargetTableSnapshot,
) -> Result<(TableDiff, Vec<SqliteRebuildRisk>)> {
    let mut risks: Vec<SqliteRebuildRisk> = Vec::new();
    let mut columns: Vec<ColumnDiff> = Vec::new();
    let mut added: Vec<ColumnDiff> = Vec::new();
    let mut final_names: Vec<String> = Vec::new();

    for e in &edit.columns {
        if e.drop {
            // 削除する列は元の名前のまま (改名の対象にならない)。TargetOnly を SourceOnly より先に並べる。
            let Some(tc) = snap.columns.iter().find(|c| c.name == e.original) else {
                return Err(invalid(format!("column '{}' does not exist", e.original)));
            };
            risks.push(SqliteRebuildRisk {
                kind: SqliteRebuildRiskKind::DropColumn,
                target: tc.name.clone(),
            });
            columns.push(ColumnDiff {
                name: tc.name.clone(),
                status: DiffStatus::TargetOnly,
                source: None,
                target: Some(tc.clone()),
                changed_fields: Vec::new(),
            });
            continue;
        }
        let new_name = e.name.trim().to_string();
        let Some(tc) = snap.columns.iter().find(|c| c.name == new_name) else {
            return Err(invalid(format!("column '{}' does not exist", e.original)));
        };
        final_names.push(new_name.clone());
        let data_type = match e.data_type.trim() {
            "" => tc.data_type.clone(),
            t => t.to_string(),
        };
        let default = non_blank(&e.default);
        let mut changed_fields = Vec::new();
        if data_type != tc.data_type.trim() {
            changed_fields.push("data_type".to_string());
        }
        if e.not_null == tc.nullable {
            changed_fields.push("nullable".to_string());
        }
        if default.as_deref()
            != tc
                .default
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
        {
            changed_fields.push("default".to_string());
        }
        if changed_fields.is_empty() {
            continue;
        }
        if changed_fields.iter().any(|f| f == "data_type")
            && affinity(&data_type) != affinity(&tc.data_type)
        {
            risks.push(SqliteRebuildRisk {
                kind: SqliteRebuildRiskKind::TypeAffinity,
                target: new_name.clone(),
            });
        }
        if changed_fields.iter().any(|f| f == "nullable") && e.not_null {
            risks.push(SqliteRebuildRisk {
                kind: SqliteRebuildRiskKind::NotNull,
                target: new_name.clone(),
            });
        }
        let mut source: TableColumnInfo = tc.clone();
        source.data_type = data_type;
        source.nullable = !e.not_null;
        source.default = default;
        columns.push(ColumnDiff {
            name: new_name,
            status: DiffStatus::Different,
            source: Some(source),
            target: Some(tc.clone()),
            changed_fields,
        });
    }
    for c in &edit.added_columns {
        let name = c.name.trim().to_string();
        final_names.push(name.clone());
        let default = non_blank(&c.default);
        if c.not_null && default.is_none() {
            risks.push(SqliteRebuildRisk {
                kind: SqliteRebuildRiskKind::AddNotNullColumn,
                target: name.clone(),
            });
        }
        let source = TableColumnInfo {
            name: name.clone(),
            data_type: c.data_type.trim().to_string(),
            nullable: !c.not_null,
            key: String::new(),
            default,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        };
        added.push(ColumnDiff {
            name,
            status: DiffStatus::SourceOnly,
            source: Some(source),
            target: None,
            changed_fields: Vec::new(),
        });
    }
    columns.extend(added);

    // 外部キー: 削除 → 追加の順に並べる (同じ (列, 参照先) を作り直すときに削除が先に効く)。
    let mut fk_changes: Vec<ForeignKeyDiff> = Vec::new();
    for d in &edit.dropped_foreign_keys {
        let sig = fk_sig(&d.columns, &d.ref_table);
        let Some(found) = snap
            .foreign_keys
            .iter()
            .find(|f| fk_sig(&f.columns, &f.referenced_table) == sig)
        else {
            return Err(invalid(format!(
                "foreign key ({}) -> {} does not exist",
                d.columns.join(", "),
                d.ref_table
            )));
        };
        fk_changes.push(ForeignKeyDiff {
            status: DiffStatus::TargetOnly,
            source: None,
            target: Some(found.clone()),
            changed_fields: Vec::new(),
        });
    }
    for f in &edit.added_foreign_keys {
        let cols: Vec<String> = f.columns.iter().map(|c| c.trim().to_string()).collect();
        let refs: Vec<String> = f.ref_columns.iter().map(|c| c.trim().to_string()).collect();
        if f.ref_table.trim().is_empty() || cols.is_empty() || cols.len() != refs.len() {
            return Err(invalid("incomplete foreign key"));
        }
        if let Some(missing) = cols
            .iter()
            .find(|c| !final_names.iter().any(|n| n.eq_ignore_ascii_case(c)))
        {
            return Err(invalid(format!(
                "foreign key column '{missing}' is not a column of the rebuilt table"
            )));
        }
        let target = cols.join(", ");
        risks.push(SqliteRebuildRisk {
            kind: SqliteRebuildRiskKind::AddForeignKey,
            target: non_blank(&f.name).unwrap_or(target),
        });
        fk_changes.push(ForeignKeyDiff {
            status: DiffStatus::SourceOnly,
            source: Some(DiffForeignKey {
                name: non_blank(&f.name),
                columns: cols,
                referenced_table: f.ref_table.trim().to_string(),
                referenced_columns: refs,
                on_delete: non_blank(&f.on_delete),
                on_update: non_blank(&f.on_update),
            }),
            target: None,
            changed_fields: Vec::new(),
        });
    }

    // CHECK 制約。
    let mut check_changes: Vec<CheckDiff> = Vec::new();
    if (!edit.dropped_checks.is_empty() || !edit.added_checks.is_empty()) && !snap.extras_known {
        return Err(invalid(
            "CHECK constraints of this table could not be read; cannot edit them",
        ));
    }
    for def in &edit.dropped_checks {
        let want = normalize_check(def);
        let Some(found) = snap
            .checks
            .iter()
            .find(|c| normalize_check(&c.definition) == want)
        else {
            return Err(invalid(format!("check constraint {def} does not exist")));
        };
        check_changes.push(CheckDiff {
            name: found.name.clone(),
            status: DiffStatus::TargetOnly,
            source: None,
            target: Some(found.clone()),
        });
    }
    for c in &edit.added_checks {
        let expr = c.expression.trim();
        if expr.is_empty() {
            return Err(invalid("empty check expression"));
        }
        let name = non_blank(&c.name).unwrap_or_default();
        risks.push(SqliteRebuildRisk {
            kind: SqliteRebuildRiskKind::AddCheck,
            target: if name.is_empty() {
                expr.to_string()
            } else {
                name.clone()
            },
        });
        check_changes.push(CheckDiff {
            name: name.clone(),
            status: DiffStatus::SourceOnly,
            source: Some(CheckConstraintInfo {
                name,
                definition: format!("CHECK ({expr})"),
            }),
            target: None,
        });
    }

    let diff = TableDiff {
        name: table.to_string(),
        status: DiffStatus::Different,
        columns,
        fk_changes,
        check_changes,
        ..Default::default()
    };
    Ok((diff, risks))
}

/// 再作成スクリプトの `PRAGMA foreign_keys=OFF` の直後へ列名変更の文を差し込む。
fn insert_renames(table: &str, script: String, renames: &[(String, String)]) -> String {
    if renames.is_empty() {
        return script;
    }
    let tident = quote_ident(DriverKind::Sqlite, table);
    let stmts: String = renames
        .iter()
        .map(|(old, new)| {
            format!(
                "ALTER TABLE {tident} RENAME COLUMN {} TO {};\n",
                quote_ident(DriverKind::Sqlite, old),
                quote_ident(DriverKind::Sqlite, new)
            )
        })
        .collect();
    let head = format!("{SQLITE_FK_OFF};\n");
    match script.strip_prefix(&head) {
        Some(rest) => format!("{head}{stmts}{rest}"),
        None => format!("{stmts}{script}"),
    }
}

/// 編集内容と現状のスナップショットから再作成 SQL を作る (純関数、DB に触れない)。
pub fn plan_rebuild(
    table: &str,
    edit: &SqliteRebuildEdit,
    mut snap: TargetTableSnapshot,
) -> Result<SqliteRebuildPlan> {
    let renames = collect_renames(edit, &snap)?;
    let mut warnings: Vec<String> = Vec::new();
    apply_renames(table, &mut snap, &renames, &mut warnings);
    let (diff, risks) = build_table_diff(table, edit, &snap)?;
    if diff.columns.is_empty()
        && diff.fk_changes.is_empty()
        && diff.check_changes.is_empty()
        && renames.is_empty()
    {
        return Err(invalid("no change requires a table rebuild"));
    }
    // AUTOINCREMENT の主キーを INTEGER 以外へ変えると、再作成後の表では AUTOINCREMENT が外れる。
    let original_upper = snap
        .original_sql
        .as_deref()
        .unwrap_or("")
        .to_ascii_uppercase();
    if original_upper.contains("AUTOINCREMENT")
        && diff.columns.iter().any(|c| {
            c.status == DiffStatus::Different
                && c.target
                    .as_ref()
                    .is_some_and(|t| t.key.eq_ignore_ascii_case("PRI"))
                && c.changed_fields.iter().any(|f| f == "data_type")
        })
    {
        warnings.push(format!(
            "{table}: 主キーの型を変えると AUTOINCREMENT が外れます (INTEGER PRIMARY KEY AUTOINCREMENT でなくなります)。"
        ));
    }
    let Some(script) = sqlite_rebuild_sql(&diff, &snap, &mut warnings) else {
        return Err(invalid(format!(
            "{table}: could not generate the table rebuild SQL (no columns left)"
        )));
    };
    Ok(SqliteRebuildPlan {
        sql: insert_renames(table, script, &renames),
        warnings,
        risks,
    })
}

/// 現状のテーブルから再作成に必要なスナップショットを読む。スキーマ比較が使う
/// `attach_sqlite_rebuild_context` / `attach_target_extras_to_snapshots` をそのまま使うため、
/// 1 表だけの `SchemaDiff` に載せて組み立てる。読み取りのみ。
pub async fn load_snapshot(
    conn: &Connection,
    database: &str,
    table: &str,
) -> Result<TargetTableSnapshot> {
    if conn.driver_kind() != DriverKind::Sqlite {
        return Err(invalid("table rebuild planning is SQLite only"));
    }
    let columns = conn.columns(database, table).await?;
    if columns.is_empty() {
        return Err(invalid(format!("table '{table}' does not exist")));
    }
    let fks = conn.foreign_keys(database).await?;
    let indexes = conn.indexes_for_database(database).await?;
    let master = crate::commands::diff::sqlite_master_entries(conn).await?;
    let extras = conn.table_ddl_extras(database, table).await?;
    let mut diff = SchemaDiff {
        source_driver: DriverKind::Sqlite,
        target_driver: DriverKind::Sqlite,
        // `attach_sqlite_rebuild_context` は列に差のある `Different` 表にだけスナップショットを載せる。
        tables: vec![TableDiff {
            name: table.to_string(),
            status: DiffStatus::Different,
            columns: vec![ColumnDiff {
                name: columns[0].name.clone(),
                status: DiffStatus::Different,
                source: None,
                target: None,
                changed_fields: Vec::new(),
            }],
            ..Default::default()
        }],
        warnings: Vec::new(),
        indexes_compared: false,
    };
    attach_sqlite_rebuild_context(
        &mut diff,
        &[TableColumns {
            name: table.to_string(),
            columns,
        }],
        &fks,
        &indexes,
        &master,
    );
    attach_target_extras_to_snapshots(&mut diff, &[(table.to_string(), extras)]);
    diff.tables
        .into_iter()
        .next()
        .and_then(|t| t.target_snapshot)
        .ok_or_else(|| invalid(format!("table '{table}' does not exist")))
}

/// スナップショットを読んで再作成 SQL を作る。
pub async fn plan_table_rebuild(
    conn: &Connection,
    database: &str,
    table: &str,
    edit: &SqliteRebuildEdit,
) -> Result<SqliteRebuildPlan> {
    let snap = load_snapshot(conn, database, table).await?;
    plan_rebuild(table, edit, snap)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap_col(
        name: &str,
        ty: &str,
        not_null: bool,
        key: &str,
        default: Option<&str>,
    ) -> TableColumnInfo {
        TableColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: !not_null,
            key: key.into(),
            default: default.map(str::to_string),
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn base_snapshot() -> TargetTableSnapshot {
        TargetTableSnapshot {
            columns: vec![
                snap_col("id", "INTEGER", true, "PRI", None),
                snap_col("name", "TEXT", false, "", None),
                snap_col("qty", "TEXT", false, "", Some("'0'")),
            ],
            original_sql: Some(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty TEXT DEFAULT '0')".into(),
            ),
            recreate_sql: vec!["CREATE INDEX idx_name ON t (name)".into()],
            extras_known: true,
            ..Default::default()
        }
    }

    fn keep(name: &str, ty: &str, nn: bool, default: Option<&str>) -> RebuildColumnEdit {
        RebuildColumnEdit {
            original: name.into(),
            name: name.into(),
            data_type: ty.into(),
            not_null: nn,
            default: default.map(str::to_string),
            drop: false,
        }
    }

    #[test]
    fn rename_identifier_skips_literals_and_other_words() {
        assert_eq!(
            rename_identifier(
                "CHECK (qty > 0 AND note = 'qty' AND qty2 > 1)",
                "qty",
                "amount"
            ),
            "CHECK (\"amount\" > 0 AND note = 'qty' AND qty2 > 1)"
        );
        assert_eq!(
            rename_identifier("(\"Qty\", `qty`, [QTY])", "qty", "a b"),
            "(\"a b\", \"a b\", \"a b\")"
        );
    }

    #[test]
    fn rename_in_index_sql_leaves_the_index_and_table_names_alone() {
        assert_eq!(
            rename_in_index_sql(
                "CREATE INDEX qty ON qty (qty, name) WHERE qty > 1",
                "qty",
                "amount"
            ),
            "CREATE INDEX qty ON qty (\"amount\", name) WHERE \"amount\" > 1"
        );
    }

    #[test]
    fn type_nullability_and_default_changes_produce_a_rebuild() {
        let edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", true, Some("'x'")),
                keep("qty", "INTEGER", false, Some("0")),
            ],
            ..Default::default()
        };
        let plan = plan_rebuild("t", &edit, base_snapshot()).unwrap();
        assert!(
            plan.sql.starts_with("PRAGMA foreign_keys=OFF;\n"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.ends_with("PRAGMA foreign_keys=ON;"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("\"qty\" INTEGER DEFAULT 0"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("\"name\" TEXT NOT NULL DEFAULT 'x'"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("CREATE INDEX idx_name ON t (name)"),
            "{}",
            plan.sql
        );
        let kinds: Vec<_> = plan
            .risks
            .iter()
            .map(|r| (r.kind, r.target.as_str()))
            .collect();
        assert!(kinds.contains(&(SqliteRebuildRiskKind::TypeAffinity, "qty")));
        assert!(kinds.contains(&(SqliteRebuildRiskKind::NotNull, "name")));
    }

    #[test]
    fn unchanged_edit_is_rejected() {
        let edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            ..Default::default()
        };
        assert!(plan_rebuild("t", &edit, base_snapshot()).is_err());
    }

    #[test]
    fn renames_run_first_and_rewrite_indexes() {
        let mut edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "INTEGER", false, Some("'0'")),
            ],
            ..Default::default()
        };
        edit.columns[1].name = "title".into();
        let plan = plan_rebuild("t", &edit, base_snapshot()).unwrap();
        let rename = "ALTER TABLE \"t\" RENAME COLUMN \"name\" TO \"title\";\n";
        let off = "PRAGMA foreign_keys=OFF;\n";
        assert!(
            plan.sql.starts_with(&format!("{off}{rename}")),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("CREATE INDEX idx_name ON t (\"title\")"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("SELECT \"id\", \"title\", \"qty\" FROM"),
            "{}",
            plan.sql
        );
    }

    #[test]
    fn rename_onto_a_dropped_column_name_is_rejected() {
        let mut edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            ..Default::default()
        };
        edit.columns[2].drop = true;
        edit.columns[1].name = "qty".into();
        assert!(plan_rebuild("t", &edit, base_snapshot()).is_err());
    }

    #[test]
    fn dropping_a_column_is_a_risk_and_is_excluded_from_the_copy() {
        let mut edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            ..Default::default()
        };
        edit.columns[2].drop = true;
        let plan = plan_rebuild("t", &edit, base_snapshot()).unwrap();
        assert!(plan
            .risks
            .iter()
            .any(|r| r.kind == SqliteRebuildRiskKind::DropColumn && r.target == "qty"));
        assert!(
            plan.sql.contains("SELECT \"id\", \"name\" FROM"),
            "{}",
            plan.sql
        );
    }

    #[test]
    fn foreign_keys_and_checks_are_added_and_dropped() {
        let mut snap = base_snapshot();
        snap.foreign_keys = vec![DiffForeignKey {
            name: None,
            columns: vec!["qty".into()],
            referenced_table: "old_ref".into(),
            referenced_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
        }];
        snap.checks = vec![CheckConstraintInfo {
            name: String::new(),
            definition: "CHECK (id > 0)".into(),
        }];
        let edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            added_foreign_keys: vec![RebuildForeignKey {
                name: None,
                columns: vec!["name".into()],
                ref_table: "owners".into(),
                ref_columns: vec!["name".into()],
                on_delete: Some("CASCADE".into()),
                on_update: None,
            }],
            dropped_foreign_keys: vec![RebuildForeignKeyRef {
                columns: vec!["qty".into()],
                ref_table: "old_ref".into(),
            }],
            added_checks: vec![RebuildCheck {
                name: Some("name_nonempty".into()),
                expression: "length(name) > 0".into(),
            }],
            dropped_checks: vec!["check ( id>0 )".into()],
            ..Default::default()
        };
        let plan = plan_rebuild("t", &edit, snap).unwrap();
        assert!(!plan.sql.contains("old_ref"), "{}", plan.sql);
        assert!(plan
            .sql
            .contains("FOREIGN KEY (\"name\") REFERENCES \"owners\" (\"name\") ON DELETE CASCADE"));
        assert!(plan
            .sql
            .contains("CONSTRAINT \"name_nonempty\" CHECK (length(name) > 0)"));
        assert!(!plan.sql.contains("CHECK (id > 0)"), "{}", plan.sql);
    }

    #[test]
    fn dropping_an_unknown_constraint_is_an_error() {
        let edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            dropped_checks: vec!["CHECK (nope > 0)".into()],
            ..Default::default()
        };
        assert!(plan_rebuild("t", &edit, base_snapshot()).is_err());
    }
}
