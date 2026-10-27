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
//! 列名の変更は、再作成を旧い列名のまま行い (索引・トリガー・ビューは元の `CREATE` 文で作り直す)、
//! コミット前に `ALTER TABLE ... RENAME COLUMN` を流して反映する。SQLite 自身が索引・トリガー・ビュー・
//! CHECK・子表の外部キーの参照を書き換えるので、文の機械的な書き換えは要らない。そのため再作成の入力
//! (編集で追加する FK / CHECK を含む) は旧い列名で組み立てる。
//!
//! 拡張点 (#1893 生成列など): [`SqliteRebuildEdit`] に項目を足し、[`build_table_diff`] で
//! `generated_changes` を埋める。ただし生成列の式も旧い列名で渡す必要があり、列を追加する編集は
//! 列の位置 (`position`) の扱いも決めなければならない。再作成側 (`sync.rs`) は生成列の変更に対応済み。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::ddl_extras::normalize_check;
use super::diff::{
    attach_sqlite_rebuild_context, attach_target_extras_to_snapshots, CheckDiff, ColumnDiff,
    DiffForeignKey, DiffStatus, ForeignKeyDiff, SchemaDiff, SqliteMasterEntry, TableColumns,
    TableDiff, TargetTableSnapshot,
};
use super::sync::{
    mask_string_literals, quote_ident, references_identifier, sqlite_rebuild_sql, SQLITE_FK_ON,
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
    /// 再作成では再現できない構文が元の `CREATE TABLE` にある (`target` は構文名)。再作成後は失われる。
    LostSyntax,
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

/// 利用者向けに文言をフロントで組み立てるエラー。`rebuild_error:<コード>:<引数>` の形で返す。
fn coded(code: &str, arg: impl std::fmt::Display) -> AppError {
    invalid(format!("rebuild_error:{code}:{arg}"))
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
    let mut renames: Vec<(String, String)> = Vec::new();
    let mut final_names: HashSet<String> = HashSet::new();
    let mut dropped: Vec<&str> = Vec::new();
    for e in &edit.columns {
        if !snap.columns.iter().any(|c| c.name == e.original) {
            return Err(coded("unknown_column", &e.original));
        }
        if e.drop {
            dropped.push(&e.original);
            continue;
        }
        let name = e.name.trim();
        if name.is_empty() {
            return Err(coded("empty_name", &e.original));
        }
        if !final_names.insert(name.to_ascii_lowercase()) {
            return Err(coded("duplicate_column", name));
        }
        if name != e.original {
            // 削除する列の名前は再作成で空くので、そこへの改名は許す。生き残る別の列の現在の名前への
            // 改名 (入れ替え・連鎖) は安全な順序を作れない。
            let clash = edit.columns.iter().any(|o| {
                !o.drop && o.original != e.original && o.original.eq_ignore_ascii_case(name)
            });
            if clash {
                return Err(coded("rename_clash", format!("{} -> {name}", e.original)));
            }
            renames.push((e.original.clone(), name.to_string()));
        }
    }
    for c in &edit.added_columns {
        let name = c.name.trim();
        if name.is_empty() {
            return Err(coded("empty_name", ""));
        }
        if !final_names.insert(name.to_ascii_lowercase()) {
            return Err(coded("duplicate_column", name));
        }
        // 旧い名前で列を足すと、再作成後の表に旧い列と同名の列が並んでしまう (改名は再作成の後に行う)。
        if renames
            .iter()
            .any(|(old, _)| old.eq_ignore_ascii_case(name))
        {
            return Err(coded("add_old_name", name));
        }
        // 削除する列と同名の列の追加は、再作成が「元の列を残してコピー」と取り違えやすいので受け付けない。
        if dropped.iter().any(|d| d.eq_ignore_ascii_case(name)) {
            return Err(coded("drop_add_same_name", name));
        }
    }
    if final_names.is_empty() {
        return Err(coded("no_columns", ""));
    }
    Ok(renames)
}

/// 編集内容から [`TableDiff`] (再作成の入力) とリスクを作る。列名はすべて旧い名前 (`renames` は
/// 編集側の新しい名前を旧い名前へ戻すのに使う)。
fn build_table_diff(
    table: &str,
    edit: &SqliteRebuildEdit,
    snap: &TargetTableSnapshot,
    renames: &[(String, String)],
) -> Result<(TableDiff, Vec<SqliteRebuildRisk>)> {
    let mut risks: Vec<SqliteRebuildRisk> = Vec::new();
    let mut columns: Vec<ColumnDiff> = Vec::new();
    let mut added: Vec<ColumnDiff> = Vec::new();
    let mut final_names: Vec<String> = Vec::new();

    for e in &edit.columns {
        if e.drop {
            // 削除する列は元の名前のまま (改名の対象にならない)。TargetOnly を SourceOnly より先に並べる。
            let Some(tc) = snap.columns.iter().find(|c| c.name == e.original) else {
                return Err(coded("unknown_column", &e.original));
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
        let Some(tc) = snap.columns.iter().find(|c| c.name == e.original) else {
            return Err(coded("unknown_column", &e.original));
        };
        final_names.push(tc.name.clone());
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
            name: tc.name.clone(),
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
            return Err(coded(
                "unknown_fk",
                format!("({}) -> {}", d.columns.join(", "), d.ref_table),
            ));
        };
        fk_changes.push(ForeignKeyDiff {
            status: DiffStatus::TargetOnly,
            source: None,
            target: Some(found.clone()),
            changed_fields: Vec::new(),
        });
    }
    for f in &edit.added_foreign_keys {
        // 編集側の列名は新しい名前。再作成は旧い名前で行うので戻す。
        let cols: Vec<String> = f
            .columns
            .iter()
            .map(|c| {
                let c = c.trim();
                renames
                    .iter()
                    .find(|(_, new)| new.eq_ignore_ascii_case(c))
                    .map_or_else(|| c.to_string(), |(old, _)| old.clone())
            })
            .collect();
        let refs: Vec<String> = f.ref_columns.iter().map(|c| c.trim().to_string()).collect();
        if f.ref_table.trim().is_empty() || cols.is_empty() || cols.len() != refs.len() {
            return Err(coded("incomplete_fk", ""));
        }
        if let Some(missing) = cols
            .iter()
            .find(|c| !final_names.iter().any(|n| n.eq_ignore_ascii_case(c)))
        {
            return Err(coded("fk_column_missing", missing));
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
        return Err(coded("checks_unreadable", ""));
    }
    for def in &edit.dropped_checks {
        let want = normalize_check(def);
        let Some(found) = snap
            .checks
            .iter()
            .find(|c| normalize_check(&c.definition) == want)
        else {
            return Err(coded("unknown_check", def));
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
            return Err(coded("empty_check", ""));
        }
        // 式の列名は新しい名前。旧い名前へ戻す (識別子単位で、文字列リテラルの中は触らない)。
        let expr = renames.iter().fold(expr.to_string(), |e, (old, new)| {
            rename_identifier(&e, new, old)
        });
        let expr = expr.as_str();
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

/// 再作成スクリプトの末尾の `PRAGMA foreign_keys=ON` の直前 (= コミット前) へ、列名変更の文を差し込む。
/// 再作成が終わった後に行うので、SQLite が作り直した索引・トリガー・ビュー・CHECK・子表の外部キーの
/// 参照を新しい名前へ書き換える。
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
    let tail = format!("{SQLITE_FK_ON};");
    match script.strip_suffix(&tail) {
        Some(head) => format!("{head}{stmts}{tail}"),
        None => format!("{script}\n{stmts}"),
    }
}

/// 元の `CREATE TABLE` にあるが、再作成では再現できない構文 (名前の一覧)。
fn lost_syntax(original_sql: &str) -> Vec<&'static str> {
    let masked = mask_string_literals(original_sql).to_ascii_uppercase();
    let mut out = Vec::new();
    // `) STRICT` / `) WITHOUT ROWID, STRICT` は最後の閉じ括弧より後ろにある。
    if masked
        .rsplit_once(')')
        .is_some_and(|(_, tail)| references_identifier(tail, "STRICT"))
    {
        out.push("STRICT");
    }
    if references_identifier(&masked, "COLLATE") {
        out.push("COLLATE");
    }
    if masked.contains("ON CONFLICT") {
        out.push("ON CONFLICT");
    }
    // `NOT DEFERRABLE` (既定) は失われても同じなので数えない。
    if masked.matches("DEFERRABLE").count() > masked.matches("NOT DEFERRABLE").count() {
        out.push("DEFERRABLE");
    }
    out
}

/// rowid を別名する `INTEGER PRIMARY KEY` を持たない rowid テーブルか。再作成は rowid ごとコピーする。
fn needs_rowid_copy(snap: &TargetTableSnapshot) -> bool {
    let upper = snap
        .original_sql
        .as_deref()
        .unwrap_or("")
        .to_ascii_uppercase();
    if upper.contains("WITHOUT ROWID") {
        return false;
    }
    let pk: Vec<_> = snap
        .columns
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .collect();
    let has_alias = pk.len() == 1 && pk[0].data_type.eq_ignore_ascii_case("INTEGER");
    let shadowed = snap.columns.iter().any(|c| {
        ["rowid", "oid", "_rowid_"]
            .iter()
            .any(|r| c.name.eq_ignore_ascii_case(r))
    });
    !has_alias && !shadowed
}

/// `INSERT INTO tmp (cols) SELECT cols FROM t` を rowid ごとコピーする形へ書き換える。
fn copy_rowid(table: &str, script: String) -> String {
    let tmp = quote_ident(DriverKind::Sqlite, &format!("__noobdb_rebuild_{table}"));
    let head = format!("INSERT INTO {tmp} (");
    let Some(start) = script.find(&head) else {
        return script;
    };
    let after = start + head.len();
    let Some(sel) = script[after..].find(") SELECT ") else {
        return script;
    };
    let sel_at = after + sel + ") SELECT ".len();
    format!(
        "{}rowid, {}rowid, {}",
        &script[..after],
        &script[after..sel_at],
        &script[sel_at..]
    )
}

/// 編集内容と現状のスナップショットから再作成 SQL を作る (純関数、DB に触れない)。
pub fn plan_rebuild(
    table: &str,
    edit: &SqliteRebuildEdit,
    snap: TargetTableSnapshot,
) -> Result<SqliteRebuildPlan> {
    let renames = collect_renames(edit, &snap)?;
    let mut warnings: Vec<String> = Vec::new();
    let (diff, mut risks) = build_table_diff(table, edit, &snap, &renames)?;
    if diff.columns.is_empty()
        && diff.fk_changes.is_empty()
        && diff.check_changes.is_empty()
        && renames.is_empty()
    {
        return Err(coded("unchanged", ""));
    }
    // AUTOINCREMENT の主キーを INTEGER 以外へ変えると、再作成後の表では AUTOINCREMENT が外れる。
    let original_sql = snap.original_sql.clone().unwrap_or_default();
    if original_sql.to_ascii_uppercase().contains("AUTOINCREMENT")
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
    for name in lost_syntax(&original_sql) {
        risks.push(SqliteRebuildRisk {
            kind: SqliteRebuildRiskKind::LostSyntax,
            target: name.to_string(),
        });
    }
    let Some(script) = sqlite_rebuild_sql(&diff, &snap, &mut warnings) else {
        return Err(coded("no_columns", ""));
    };
    let script = if needs_rowid_copy(&snap) {
        copy_rowid(table, script)
    } else {
        script
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
) -> Result<(TargetTableSnapshot, Vec<SqliteMasterEntry>)> {
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
        objects: Default::default(),
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
    let snap = diff
        .tables
        .into_iter()
        .next()
        .and_then(|t| t.target_snapshot)
        .ok_or_else(|| invalid(format!("table '{table}' does not exist")))?;
    Ok((snap, master))
}

/// スナップショットを読んで再作成 SQL を作る。
pub async fn plan_table_rebuild(
    conn: &Connection,
    database: &str,
    table: &str,
    edit: &SqliteRebuildEdit,
) -> Result<SqliteRebuildPlan> {
    let (snap, master) = load_snapshot(conn, database, table).await?;
    // 他の表のトリガーがこの表を参照していると、旧表を DROP して名前を戻す `RENAME TO` のスキーマ検査で
    // 失敗する (SQLite はその時点で他表のトリガーの参照先を検証する)。実行前に分かりやすく止める。
    if let Some(t) = master.iter().find(|m| {
        m.kind == "trigger"
            && !m.table.eq_ignore_ascii_case(table)
            && references_identifier(&mask_string_literals(&m.sql), table)
    }) {
        return Err(coded("other_table_trigger", &t.name));
    }
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
    fn renames_run_after_the_rebuild_and_leave_the_old_names_in_the_rebuild() {
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
        let rename =
            "ALTER TABLE \"t\" RENAME COLUMN \"name\" TO \"title\";\nPRAGMA foreign_keys=ON;";
        assert!(plan.sql.ends_with(rename), "{}", plan.sql);
        assert!(
            plan.sql.contains("CREATE INDEX idx_name ON t (name)"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("SELECT \"id\", \"name\", \"qty\" FROM"),
            "{}",
            plan.sql
        );
    }

    #[test]
    fn added_foreign_key_columns_are_translated_back_ignoring_case() {
        let mut edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            added_foreign_keys: vec![RebuildForeignKey {
                name: None,
                columns: vec!["TITLE".into()],
                ref_table: "owners".into(),
                ref_columns: vec!["name".into()],
                on_delete: None,
                on_update: None,
            }],
            ..Default::default()
        };
        edit.columns[1].name = "title".into();
        let plan = plan_rebuild("t", &edit, base_snapshot()).unwrap();
        assert!(
            plan.sql.contains("FOREIGN KEY (\"name\") REFERENCES"),
            "{}",
            plan.sql
        );
    }

    #[test]
    fn added_constraints_are_translated_back_to_the_old_names() {
        let mut edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            added_checks: vec![RebuildCheck {
                name: None,
                expression: "length(title) > 0".into(),
            }],
            added_foreign_keys: vec![RebuildForeignKey {
                name: None,
                columns: vec!["title".into()],
                ref_table: "owners".into(),
                ref_columns: vec!["name".into()],
                on_delete: None,
                on_update: None,
            }],
            ..Default::default()
        };
        edit.columns[1].name = "title".into();
        let plan = plan_rebuild("t", &edit, base_snapshot()).unwrap();
        assert!(
            plan.sql.contains("CHECK (length(\"name\") > 0)"),
            "{}",
            plan.sql
        );
        assert!(
            plan.sql.contains("FOREIGN KEY (\"name\") REFERENCES"),
            "{}",
            plan.sql
        );
    }

    #[test]
    fn dropping_an_existing_constraint_while_renaming_matches_the_old_snapshot() {
        let mut snap = base_snapshot();
        snap.checks = vec![CheckConstraintInfo {
            name: String::new(),
            definition: "CHECK (name <> '')".into(),
        }];
        let mut edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            dropped_checks: vec!["CHECK (name <> '')".into()],
            ..Default::default()
        };
        edit.columns[1].name = "title".into();
        let plan = plan_rebuild("t", &edit, snap).unwrap();
        assert!(!plan.sql.contains("<>"), "{}", plan.sql);
    }

    #[test]
    fn adding_a_column_named_like_a_renamed_or_dropped_column_is_rejected() {
        let new_col = |n: &str| RebuildNewColumn {
            name: n.into(),
            data_type: "TEXT".into(),
            not_null: false,
            default: None,
        };
        let cols = || {
            vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", false, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ]
        };
        let mut renamed = SqliteRebuildEdit {
            columns: cols(),
            added_columns: vec![new_col("name")],
            ..Default::default()
        };
        renamed.columns[1].name = "title".into();
        let e = plan_rebuild("t", &renamed, base_snapshot()).unwrap_err();
        assert!(e.to_string().contains("rebuild_error:add_old_name"), "{e}");
        let mut dropped = SqliteRebuildEdit {
            columns: cols(),
            added_columns: vec![new_col("qty")],
            ..Default::default()
        };
        dropped.columns[2].drop = true;
        let e = plan_rebuild("t", &dropped, base_snapshot()).unwrap_err();
        assert!(
            e.to_string().contains("rebuild_error:drop_add_same_name"),
            "{e}"
        );
    }

    #[test]
    fn lost_syntax_is_reported_as_a_risk() {
        let mut snap = base_snapshot();
        snap.original_sql = Some(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, qty TEXT, \
             FOREIGN KEY (qty) REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED) STRICT"
                .into(),
        );
        let edit = SqliteRebuildEdit {
            columns: vec![
                keep("id", "INTEGER", true, None),
                keep("name", "TEXT", true, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            ..Default::default()
        };
        let plan = plan_rebuild("t", &edit, snap).unwrap();
        let lost: Vec<_> = plan
            .risks
            .iter()
            .filter(|r| r.kind == SqliteRebuildRiskKind::LostSyntax)
            .map(|r| r.target.as_str())
            .collect();
        assert_eq!(lost, vec!["STRICT", "COLLATE", "DEFERRABLE"]);
        // NOT DEFERRABLE (既定) だけなら失われるものは無い。
        assert!(lost_syntax("CREATE TABLE t (a REFERENCES p NOT DEFERRABLE)").is_empty());
    }

    #[test]
    fn rowid_tables_without_an_integer_primary_key_copy_the_rowid() {
        let mut snap = base_snapshot();
        snap.columns[0] = snap_col("code", "TEXT", true, "PRI", None);
        snap.original_sql =
            Some("CREATE TABLE t (code TEXT PRIMARY KEY, name TEXT, qty TEXT)".into());
        snap.columns[1].name = "name".into();
        let edit = SqliteRebuildEdit {
            columns: vec![
                keep("code", "TEXT", true, None),
                keep("name", "TEXT", true, None),
                keep("qty", "TEXT", false, Some("'0'")),
            ],
            ..Default::default()
        };
        let plan = plan_rebuild("t", &edit, snap.clone()).unwrap();
        assert!(
            plan.sql
                .contains("(rowid, \"code\", \"name\", \"qty\") SELECT rowid, \"code\""),
            "{}",
            plan.sql
        );
        // WITHOUT ROWID は対象外。
        snap.original_sql =
            Some("CREATE TABLE t (code TEXT PRIMARY KEY, name, qty) WITHOUT ROWID".into());
        let plan = plan_rebuild("t", &edit, snap).unwrap();
        assert!(!plan.sql.contains("rowid,"), "{}", plan.sql);
    }

    #[test]
    fn rename_onto_a_dropped_column_name_is_allowed_but_a_swap_is_not() {
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
        let plan = plan_rebuild("t", &edit, base_snapshot()).unwrap();
        assert!(
            plan.sql.contains("RENAME COLUMN \"name\" TO \"qty\""),
            "{}",
            plan.sql
        );
        edit.columns[2].drop = false;
        edit.columns[2].name = "name".into();
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
