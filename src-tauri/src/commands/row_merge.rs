//! 重複レコードのマージ (#2303) — 残す行を決め、子テーブルの参照を付け替えてから重複行を消す処理を、
//! 衝突を実行前に検出したうえで 1 トランザクションで行う。
//!
//! 計画 (`build_plan`) は読み取りだけで、プレビューも実行も同じ計画を立てる。実行は計画の文を既存の
//! `run_query_transaction_guarded_inner` (read_only ガード・文ごとの影響行数の検算・履歴・キャッシュ invalidate、
//! all-or-nothing) へそのまま渡す。`read_only` はそこでバックエンドが拒否する。`confirm_writes` /
//! `is_production` の確認は UI レベル (`RowMergeModal`) の責務。
//!
//! フライトレコーダー (#735) へは `bulk_capture` と同じ方式 (実行の直前に before、コミット直後に after を
//! 別接続で読む) で 1 バッチとして記録する。ベストエフォートで、記録できなくてもマージは通る
//! (理由は `undo_decline` として事前に示す)。Undo の順序は記録の順の逆なので、実行順と同じ
//! 「子 → 重複行の DELETE → 残す行の UPDATE」の順に保存する。取り消しでは残す行の列値が先に戻ってから重複行が
//! 復元されるので、重複行から採った UNIQUE 列 (email など) があっても UNIQUE 違反にならない。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::bulk_capture::BulkCaptureConfig;
use crate::commands::bulk_write::qualified_ref;
use crate::commands::query::{run_query_transaction_guarded_inner, TransactionRun};
use crate::db::data_diff::sql_literal;
use crate::db::row_merge::{
    classify_collision_group, collision_groups_sql, collision_members_sql, delete_where_sql,
    eq_cond, index_key_columns, is_row_key, loser_match_cond, norm_sig, or_conds, pick_values,
    repoint_sql, row_key_of, sig, skip_blocker, suggest_picks, survivor_update_sql,
    usable_unique_index, value_to_u64, ChildEdge, ConflictPolicy, MergeBlocker, MergeWarning,
    RowMergeRequest, SkipBlock, UndoDecline, MAX_CONFLICT_GROUPS, MAX_MERGE_ROWS,
};
use crate::db::subset::{exclude_cross_database_groups, group_foreign_keys};
use crate::db::types::{Column, IndexInfo, TableColumnInfo, Value};
use crate::db::{
    Connection, DriverKind, RowExpectation, WriteCapture, WriteKind, DEFAULT_CAPTURE_ROW_CAP,
};
use crate::error::{AppError, Result};
use crate::flight_recorder::{new_batch_id, persist_capture};
use crate::state::{AppState, Session};

/// プレビューに出す列 (残す行の列値を選ぶ単位)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergeColumn {
    pub name: String,
    pub type_name: String,
    /// 採用元を選べない列 (キー列・他の表から参照されている列・生成列)。
    pub locked: bool,
}

/// 付け替え対象の子テーブルの外部キー 1 本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergeChild {
    /// 別スキーマの子 (PostgreSQL) のときだけ入る。
    pub schema: Option<String>,
    pub table: String,
    pub constraint: String,
    pub columns: Vec<String>,
    pub parent_columns: Vec<String>,
    pub on_delete: Option<String>,
    /// 実際に付け替える行数。
    pub rows: u64,
    /// 衝突のため付け替えを飛ばす行数 (扱いが「飛ばす」のとき)。
    pub skipped: u64,
    /// 衝突のため削除する行数 (扱いが「削除」のとき)。
    pub deleted: u64,
    pub self_reference: bool,
}

/// 子側の一意キーの衝突。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergeConflict {
    pub table: String,
    pub index: String,
    pub columns: Vec<String>,
    /// 衝突するキーの数。
    pub groups: u64,
    /// 重なる (削除または付け替えを飛ばす対象になる) 子行の数。
    pub rows: u64,
    /// 衝突キーの例 (外部キー列以外の列の値)。
    pub sample: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMergePreview {
    pub columns: Vec<RowMergeColumn>,
    /// `[残す行, 重複行…]` の全列の値 (DB から読み直したもの)。
    pub rows: Vec<Vec<Value>>,
    /// 列ごとの採用元 (`rows` の添字)。
    pub picks: Vec<usize>,
    pub key_columns: Vec<String>,
    pub children: Vec<RowMergeChild>,
    pub conflicts: Vec<RowMergeConflict>,
    /// 実行する文 (順番どおり)。
    pub statements: Vec<String>,
    pub blockers: Vec<MergeBlocker>,
    pub warnings: Vec<MergeWarning>,
    /// SQLite の `PRAGMA foreign_keys` (他のドライバは `None`)。偽でも宣言済みの FK を根拠に付け替える。
    pub fk_enforced: Option<bool>,
    /// 付け替える子行の合計。
    pub repointed_rows: u64,
    /// 消す重複行の数。
    pub deleted_rows: u64,
    /// Undo (フライトレコーダー記録) を残せない理由。`None` なら記録できる見込み。
    pub undo_decline: Option<UndoDecline>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowMergeCaptureOutcome {
    pub recorded: u32,
    pub declined: u32,
    pub batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RowMergeOutcome {
    #[serde(rename_all = "camelCase")]
    Applied {
        repointed_rows: u64,
        deleted_rows: u64,
        capture: RowMergeCaptureOutcome,
    },
    /// 衝突などで実行しなかった。DB は未変更。
    Blocked { blockers: Vec<MergeBlocker> },
    /// プレビューの後でデータが変わり、影響行数が想定と合わないのでロールバックした。DB は未変更。
    #[serde(rename_all = "camelCase")]
    Changed {
        expected_rows: u64,
        actual_rows: u64,
        /// 実行する文が変わっている (件数が同じでも食い違う)。
        statements_changed: bool,
    },
    /// ロールバックしたが、トランザクション非対応の表のため一部が戻らなかった。
    #[serde(rename_all = "camelCase")]
    RollbackIncomplete {
        expected_rows: u64,
        actual_rows: u64,
    },
}

/// 実行オプション。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RowMergeOptions {
    /// フライトレコーダーへ記録する。
    pub capture: Option<BulkCaptureConfig>,
}

struct Step {
    sql: String,
    expect: RowExpectation,
}

/// 子テーブルの 1 本の外部キーについての、記録用の情報。
struct ChildCap {
    loser_sigs: HashSet<String>,
    survivor_ref: Vec<Value>,
    fk_cols: Vec<String>,
    /// 付け替え対象の行条件 (自己参照の除外つき)。
    scope: String,
}

/// 子テーブル 1 つ分 (外部キーが複数あれば束ねる) の記録用の情報。
struct ChildTable {
    table: String,
    table_ref: String,
    pk: Vec<String>,
    caps: Vec<ChildCap>,
}

struct Plan {
    preview: RowMergePreview,
    steps: Vec<Step>,
    key_types: Vec<String>,
    parent_ref: String,
    child_tables: Vec<ChildTable>,
    row_cap: usize,
}

fn exact(n: u64) -> RowExpectation {
    RowExpectation {
        min: Some(n),
        max: Some(n),
    }
}

fn db_opt(database: &str) -> Option<&str> {
    (!database.is_empty()).then_some(database)
}

async fn query(
    conn: &Connection,
    database: &str,
    sql: &str,
) -> Result<crate::db::types::QueryResult> {
    conn.execute(sql, db_opt(database)).await
}

/// 表名の照合。PostgreSQL は大文字小文字を区別し、MySQL / SQLite は区別しない。
fn same_name(driver: DriverKind, a: &str, b: &str) -> bool {
    if driver == DriverKind::Postgres {
        a == b
    } else {
        a.eq_ignore_ascii_case(b)
    }
}

/// `ON DELETE` が子行を消す / 書き換える動作か。
fn on_delete_touches_rows(action: Option<&str>) -> bool {
    matches!(
        action.map(str::to_ascii_uppercase).as_deref(),
        Some("CASCADE" | "SET NULL" | "SET DEFAULT")
    )
}

/// 別スキーマ (PostgreSQL) の子テーブルから、この表を参照する外部キー 1 本。
struct CrossSchemaFk {
    schema: String,
    table: String,
    constraint: String,
    /// 外部キーの列数 (複合なら 2 以上)。
    width: u64,
    column: String,
    referenced_column: String,
    on_delete: Option<String>,
}

fn pg_action(code: &str) -> Option<String> {
    match code {
        "c" => Some("CASCADE".into()),
        "n" => Some("SET NULL".into()),
        "d" => Some("SET DEFAULT".into()),
        "r" => Some("RESTRICT".into()),
        _ => None,
    }
}

/// PostgreSQL: 別スキーマから `schema.table` を参照する外部キー (複合も含む)。取得できなければエラー。
async fn pg_cross_schema_incoming(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<CrossSchemaFk>> {
    let d = DriverKind::Postgres;
    let sql = format!(
        "SELECT n.nspname::text, cl.relname::text, con.conname::text, \
                array_length(con.conkey, 1)::int8, \
                (SELECT a.attname::text FROM pg_catalog.pg_attribute a \
                  WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]), \
                (SELECT fa.attname::text FROM pg_catalog.pg_attribute fa \
                  WHERE fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]), \
                con.confdeltype::text \
           FROM pg_catalog.pg_constraint con \
           JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid \
           JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace \
           JOIN pg_catalog.pg_class fcl ON fcl.oid = con.confrelid \
           JOIN pg_catalog.pg_namespace fn ON fn.oid = fcl.relnamespace \
          WHERE con.contype = 'f' \
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint p \
                             WHERE p.oid = con.conparentid AND p.conrelid = con.conrelid) \
            AND fcl.relnamespace <> cl.relnamespace \
            AND fn.nspname = {} AND fcl.relname::text = {} \
          ORDER BY n.nspname, cl.relname, con.conname",
        sql_literal(d, &Value::String(schema.to_string())),
        sql_literal(d, &Value::String(table.to_string())),
    );
    let r = query(conn, schema, &sql).await?;
    Ok(r.rows
        .iter()
        .map(|row| {
            let text = |i: usize| row.get(i).map(norm_sig).unwrap_or_default();
            CrossSchemaFk {
                schema: text(0),
                table: text(1),
                constraint: text(2),
                width: row.get(3).map_or(0, value_to_u64),
                column: text(4),
                referenced_column: text(5),
                on_delete: pg_action(&text(6)),
            }
        })
        .collect())
}

/// MySQL: 別のデータベースの表から `db.table` を参照する外部キーの (データベース, 表, `DELETE_RULE`)。
async fn mysql_cross_database_incoming(
    conn: &Connection,
    db: &str,
    table: &str,
) -> Result<Vec<(String, String, String)>> {
    let d = DriverKind::Mysql;
    let lit_db = sql_literal(d, &Value::String(db.to_string()));
    let sql = format!(
        "SELECT DISTINCT k.TABLE_SCHEMA, k.TABLE_NAME, r.DELETE_RULE \
           FROM information_schema.KEY_COLUMN_USAGE k \
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
            AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
            AND r.TABLE_NAME = k.TABLE_NAME \
          WHERE k.REFERENCED_TABLE_SCHEMA = {lit_db} \
            AND k.REFERENCED_TABLE_NAME = {} \
            AND k.TABLE_SCHEMA <> {lit_db}",
        sql_literal(d, &Value::String(table.to_string())),
    );
    let r = query(conn, db, &sql).await?;
    Ok(r.rows
        .iter()
        .map(|row| {
            let text = |i: usize| row.get(i).map(norm_sig).unwrap_or_default();
            (text(0), text(1), text(2))
        })
        .collect())
}

fn child_row_counts(children: &[RowMergeChild]) -> Vec<u64> {
    children
        .iter()
        .map(|c| c.rows + c.skipped + c.deleted)
        .collect()
}

fn col_pos(columns: &[Column], name: &str) -> Option<usize> {
    columns.iter().position(|c| c.name == name).or_else(|| {
        columns
            .iter()
            .position(|c| c.name.eq_ignore_ascii_case(name))
    })
}

fn meta_type(cols: &[TableColumnInfo], name: &str) -> String {
    cols.iter()
        .find(|c| c.name.eq_ignore_ascii_case(name))
        .map(|c| c.data_type.clone())
        .unwrap_or_default()
}

fn blocked_preview(
    key_columns: &[String],
    blockers: Vec<MergeBlocker>,
    columns: Vec<RowMergeColumn>,
    rows: Vec<Vec<Value>>,
) -> RowMergePreview {
    RowMergePreview {
        picks: vec![0; columns.len()],
        columns,
        rows,
        key_columns: key_columns.to_vec(),
        children: vec![],
        conflicts: vec![],
        statements: vec![],
        blockers,
        warnings: vec![],
        fk_enforced: None,
        repointed_rows: 0,
        deleted_rows: 0,
        undo_decline: None,
    }
}

fn early(key_columns: &[String], blockers: Vec<MergeBlocker>) -> Plan {
    Plan {
        preview: blocked_preview(key_columns, blockers, vec![], vec![]),
        steps: vec![],
        key_types: vec![],
        parent_ref: String::new(),
        child_tables: vec![],
        row_cap: 0,
    }
}

/// 計画を立てる (読み取りのみ)。
async fn build_plan(
    session: &Session,
    database: &str,
    table: &str,
    req: &RowMergeRequest,
    row_cap: usize,
) -> Result<Plan> {
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let db = conn.resolve_attached_database(database);
    let parent_ref = qualified_ref(driver, &db, table);
    if req.losers.is_empty() || req.key_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "row merge needs a survivor, at least one duplicate row and key columns".into(),
        ));
    }
    if 1 + req.losers.len() > MAX_MERGE_ROWS {
        return Ok(early(
            &req.key_columns,
            vec![MergeBlocker::TooManyRows {
                max: MAX_MERGE_ROWS,
            }],
        ));
    }
    let mut blockers: Vec<MergeBlocker> = Vec::new();
    let mut warnings: Vec<MergeWarning> = Vec::new();

    // MySQL: トランザクションを持たないエンジンはロールバックできないので拒否する。
    if driver == DriverKind::Mysql {
        let sql = format!(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
            sql_literal(driver, &Value::String(db.clone())),
            sql_literal(driver, &Value::String(table.to_string())),
        );
        if let Ok(r) = query(conn, database, &sql).await {
            if let Some(Value::String(engine)) = r.rows.first().and_then(|r| r.first()) {
                if !engine.eq_ignore_ascii_case("InnoDB") {
                    return Ok(early(
                        &req.key_columns,
                        vec![MergeBlocker::UnsupportedEngine {
                            engine: engine.clone(),
                        }],
                    ));
                }
            }
        }
    }

    let tcols = conn.columns(database, table).await?;
    let all_idx = conn
        .indexes_for_database(database)
        .await
        .unwrap_or_default();
    let parent_idx: Vec<IndexInfo> = all_idx
        .iter()
        .find(|t| t.name == table)
        .map(|t| t.indexes.clone())
        .unwrap_or_default();
    if !is_row_key(&tcols, &parent_idx, &req.key_columns) {
        return Ok(early(&req.key_columns, vec![MergeBlocker::NoKey]));
    }
    let key_types: Vec<String> = req
        .key_columns
        .iter()
        .map(|c| meta_type(&tcols, c))
        .collect();

    // 選んだ行を DB から読み直す (キーで特定)。
    let mut keys: Vec<&Vec<Value>> = vec![&req.survivor];
    keys.extend(req.losers.iter());
    if keys.iter().any(|k| k.len() != req.key_columns.len()) {
        return Err(AppError::InvalidInput("key value count mismatch".into()));
    }
    let key_sigs: Vec<String> = keys.iter().map(|k| sig(k)).collect();
    let uniq: HashSet<&String> = key_sigs.iter().collect();
    if uniq.len() != key_sigs.len() {
        return Ok(early(
            &req.key_columns,
            vec![MergeBlocker::DuplicateSelection],
        ));
    }
    let key_conds: Vec<String> = keys
        .iter()
        .map(|k| eq_cond(driver, &req.key_columns, &key_types, k))
        .collect();
    let fetched = query(
        conn,
        database,
        &format!(
            "SELECT * FROM {parent_ref} WHERE {}",
            or_conds(&key_conds).unwrap_or_default()
        ),
    )
    .await?;
    let key_idx: Vec<usize> = req
        .key_columns
        .iter()
        .filter_map(|c| col_pos(&fetched.columns, c))
        .collect();
    if key_idx.len() != req.key_columns.len() {
        return Ok(early(&req.key_columns, vec![MergeBlocker::NoKey]));
    }
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(keys.len());
    for (i, ks) in key_sigs.iter().enumerate() {
        let found = fetched
            .rows
            .iter()
            .find(|r| sig(&key_idx.iter().map(|&j| r[j].clone()).collect::<Vec<_>>()) == *ks);
        match found {
            Some(r) => rows.push(r.clone()),
            None => blockers.push(MergeBlocker::RowNotFound { index: i }),
        }
    }
    let pcol_names: Vec<String> = fetched.columns.iter().map(|c| c.name.clone()).collect();
    if !blockers.is_empty() {
        return Ok(early(&req.key_columns, blockers));
    }
    let parent_types: Vec<String> = pcol_names.iter().map(|c| meta_type(&tcols, c)).collect();

    // 子テーブルの外部キーを集める (複合・自己参照を含む)。
    let fks = conn.foreign_keys(database).await?;
    let cross: std::collections::BTreeSet<(String, String)> = conn
        .cross_database_foreign_keys(database)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let (groups, _) = exclude_cross_database_groups(group_foreign_keys(&fks), &cross);
    let parent_pk = row_key_of(&tcols, &parent_idx).unwrap_or_default();
    let mut edges: Vec<ChildEdge> = Vec::new();
    for g in groups
        .iter()
        .filter(|g| same_name(driver, &g.parent, table))
    {
        let parent_cols = match &g.parent_cols {
            Some(c) => c.clone(),
            None => parent_pk.clone(),
        };
        if parent_cols.is_empty() || parent_cols.len() != g.child_cols.len() {
            blockers.push(MergeBlocker::UnresolvedForeignKey {
                table: g.child.clone(),
                constraint: g.constraint.clone(),
            });
            continue;
        }
        // 制約名で照合する (同じ列が別の制約にも入っていても取り違えない)。名前が無いドライバは先頭列で探す。
        let on_delete = fks
            .iter()
            .find(|f| {
                f.table == g.child
                    && same_name(driver, &f.referenced_table, table)
                    && match &f.constraint_name {
                        Some(n) => *n == g.constraint,
                        None => g.child_cols.first() == Some(&f.column),
                    }
            })
            .and_then(|f| f.on_delete.clone());
        edges.push(ChildEdge {
            child_db: database.to_string(),
            child: g.child.clone(),
            constraint: g.constraint.clone(),
            child_cols: g.child_cols.clone(),
            parent_cols,
            on_delete,
        });
    }
    // PostgreSQL: 別スキーマの子。取得に失敗したら子を取りこぼすので止める。複合 FK は付け替えず止める。
    if driver == DriverKind::Postgres {
        match pg_cross_schema_incoming(conn, database, table).await {
            Ok(extra) => {
                for e in extra {
                    if e.width >= 2 {
                        blockers.push(MergeBlocker::UnresolvedForeignKey {
                            table: format!("{}.{}", e.schema, e.table),
                            constraint: e.constraint,
                        });
                        continue;
                    }
                    edges.push(ChildEdge {
                        child_db: e.schema,
                        child: e.table.clone(),
                        constraint: e.constraint.clone(),
                        child_cols: vec![e.column],
                        parent_cols: vec![e.referenced_column],
                        on_delete: e.on_delete,
                    });
                }
            }
            Err(_) => blockers.push(MergeBlocker::CrossChildrenUnreadable {
                table: table.to_string(),
            }),
        }
    }
    // MySQL: 別データベースの子は辿れない。連鎖 / NULL 化する参照があれば黙って壊れるので止め、
    // RESTRICT (参照が残れば DELETE が失敗して全体ロールバック) なら警告にとどめる。
    if driver == DriverKind::Mysql {
        match mysql_cross_database_incoming(conn, &db, table).await {
            Ok(list) => {
                for (schema, tbl, rule) in list {
                    if on_delete_touches_rows(Some(&rule)) {
                        blockers.push(MergeBlocker::CrossDatabaseCascade { schema, table: tbl });
                    } else {
                        warnings.push(MergeWarning::CrossDatabaseChild {
                            table: format!("{schema}.{tbl}"),
                        });
                    }
                }
            }
            Err(_) => blockers.push(MergeBlocker::CrossChildrenUnreadable {
                table: table.to_string(),
            }),
        }
    }

    // SQLite の `PRAGMA foreign_keys` (他のドライバは `None`)。辺のループより前に読む。
    let fk_enforced = if driver == DriverKind::Sqlite {
        query(conn, database, "PRAGMA foreign_keys")
            .await
            .ok()
            .and_then(|r| r.rows.first().and_then(|r| r.first()).map(value_to_u64))
            .map(|n| n != 0)
    } else {
        None
    };

    // 列ごとの「採用元を選べない」判定と採用元。
    let mut locked: Vec<bool> = pcol_names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            req.key_columns.iter().any(|k| k.eq_ignore_ascii_case(n))
                || edges
                    .iter()
                    .any(|e| e.parent_cols.iter().any(|p| p.eq_ignore_ascii_case(n)))
                || tcols
                    .iter()
                    .find(|c| c.name.eq_ignore_ascii_case(&pcol_names[i]))
                    .is_some_and(TableColumnInfo::is_generated)
        })
        .collect();
    let mut picks = match &req.picks {
        None => suggest_picks(&rows, &locked),
        Some(list) => {
            let mut p = vec![0usize; pcol_names.len()];
            for pk in list {
                match pcol_names
                    .iter()
                    .position(|n| n.eq_ignore_ascii_case(&pk.column))
                {
                    Some(i) if pk.from_row < rows.len() => {
                        if pk.from_row != 0
                            && locked[i]
                            && norm_sig(&rows[pk.from_row][i]) != norm_sig(&rows[0][i])
                        {
                            blockers.push(MergeBlocker::LockedPick {
                                column: pk.column.clone(),
                            });
                        }
                        p[i] = if locked[i] { 0 } else { pk.from_row };
                    }
                    _ => blockers.push(MergeBlocker::InvalidPick {
                        column: pk.column.clone(),
                    }),
                }
            }
            p
        }
    };
    for (i, l) in locked.iter_mut().enumerate() {
        if *l {
            picks[i] = 0;
        }
    }
    let final_survivor: Vec<Value> = (0..pcol_names.len())
        .map(|c| rows[picks[c]][c].clone())
        .collect();

    // 残す行・消す行のキー条件 (自己参照の除外用)。
    let key_excl_conds: Vec<String> = key_conds.clone();
    let survivor_cond = key_conds[0].clone();

    let policy = req.conflict_policy;
    let mut steps: Vec<Step> = Vec::new();
    let mut children: Vec<RowMergeChild> = Vec::new();
    let mut conflicts: Vec<RowMergeConflict> = Vec::new();
    let mut child_tables: Vec<ChildTable> = Vec::new();
    let mut undo_decline: Option<UndoDecline> = None;
    let mut total_child_rows = 0u64;
    let mut idx_cache: HashMap<String, Vec<crate::db::types::TableIndexes>> = HashMap::new();
    idx_cache.insert(database.to_string(), all_idx);
    let mut repointed_total = 0u64;

    for edge in &edges {
        let self_ref = edge.child_db == database && edge.child.eq_ignore_ascii_case(table);
        let loser_refs_all: Vec<Option<Vec<Value>>> = rows[1..]
            .iter()
            .map(|r| pick_values(&pcol_names, r, &edge.parent_cols))
            .collect();
        let survivor_ref_opt = pick_values(&pcol_names, &rows[0], &edge.parent_cols);
        // 参照先の列が親の列に見つからない辺は、黙って飛ばさず止める (子が取りこぼされる)。
        let (Some(survivor_ref), true) =
            (survivor_ref_opt, loser_refs_all.iter().all(Option::is_some))
        else {
            blockers.push(MergeBlocker::UnresolvedForeignKey {
                table: edge.child.clone(),
                constraint: edge.constraint.clone(),
            });
            continue;
        };
        let loser_refs: Vec<Vec<Value>> = loser_refs_all.into_iter().flatten().collect();
        // 自己参照: 残す行の最終値が消える行 (または自分自身) を指してはいけない。
        if self_ref {
            let merged: HashSet<String> = loser_refs
                .iter()
                .chain(std::iter::once(&survivor_ref))
                .map(|v| sig(v))
                .collect();
            for c in &edge.child_cols {
                if let Some(i) = pcol_names.iter().position(|n| n.eq_ignore_ascii_case(c)) {
                    let v = &final_survivor[i];
                    if !matches!(v, Value::Null) && merged.contains(&norm_sig(v)) {
                        blockers.push(MergeBlocker::SelfReference {
                            table: edge.child.clone(),
                            column: c.clone(),
                        });
                    }
                }
            }
        }
        let child_cols_meta = match conn.columns(&edge.child_db, &edge.child).await {
            Ok(c) => c,
            Err(_) => {
                blockers.push(MergeBlocker::ChildUnreadable {
                    table: edge.child.clone(),
                });
                continue;
            }
        };
        let child_types: Vec<String> = edge
            .child_cols
            .iter()
            .map(|c| meta_type(&child_cols_meta, c))
            .collect();
        let child_ref = qualified_ref(
            driver,
            &conn.resolve_attached_database(&edge.child_db),
            &edge.child,
        );
        let Some(loser_match) = loser_match_cond(driver, edge, &child_types, &loser_refs) else {
            continue;
        };
        let excl = if self_ref {
            or_conds(&key_excl_conds).map(|e| format!(" AND NOT ({e})"))
        } else {
            None
        };
        let scope_losers = format!("({loser_match}){}", excl.clone().unwrap_or_default());
        let count = query(
            conn,
            &edge.child_db,
            &format!("SELECT COUNT(*) FROM {child_ref} WHERE {scope_losers}"),
        )
        .await?
        .rows
        .first()
        .and_then(|r| r.first())
        .map_or(0, value_to_u64);
        if count == 0 {
            continue;
        }
        if survivor_ref.iter().any(|v| matches!(v, Value::Null)) {
            blockers.push(MergeBlocker::NullReference {
                table: edge.child.clone(),
                column: edge.child_cols.join(", "),
            });
            continue;
        }
        total_child_rows += count;

        // 子の行キー (記録用) と、Undo を残せない理由。
        if !idx_cache.contains_key(&edge.child_db) {
            let v = conn
                .indexes_for_database(&edge.child_db)
                .await
                .unwrap_or_default();
            idx_cache.insert(edge.child_db.clone(), v);
        }
        let child_idx: Vec<IndexInfo> = idx_cache
            .get(&edge.child_db)
            .and_then(|v| v.iter().find(|t| t.name == edge.child))
            .map(|t| t.indexes.clone())
            .unwrap_or_default();
        let child_pk = row_key_of(&child_cols_meta, &child_idx);
        if edge.child_db != database {
            undo_decline.get_or_insert(UndoDecline::CrossSchemaChild {
                table: edge.child.clone(),
            });
        }
        if child_pk.is_none() {
            undo_decline.get_or_insert(UndoDecline::ChildWithoutKey {
                table: edge.child.clone(),
            });
        }

        // 一意キーの衝突。
        let survivor_match = eq_cond(driver, &edge.child_cols, &child_types, &survivor_ref);
        let scope_all = format!(
            "(({loser_match}) OR ({survivor_match})){}",
            excl.clone().unwrap_or_default()
        );
        let mut idxs: Vec<(String, Vec<String>)> = Vec::new();
        for i in child_idx.iter().filter(|i| i.unique || i.primary) {
            if !usable_unique_index(i) {
                if index_key_columns(i)
                    .iter()
                    .any(|c| edge.child_cols.iter().any(|f| f.eq_ignore_ascii_case(c)))
                {
                    warnings.push(MergeWarning::UncheckedIndex {
                        table: edge.child.clone(),
                        index: i.name.clone(),
                    });
                }
                continue;
            }
            idxs.push((i.name.clone(), index_key_columns(i)));
        }
        if !child_idx.iter().any(|i| i.primary) {
            if let Some(pk) = &child_pk {
                if child_cols_meta
                    .iter()
                    .any(|c| c.key.eq_ignore_ascii_case("PRI"))
                {
                    idxs.push(("PRIMARY".to_string(), pk.clone()));
                }
            }
        }
        let mut drops: Vec<String> = Vec::new();
        for (name, ucols) in idxs {
            if !ucols
                .iter()
                .any(|c| edge.child_cols.iter().any(|f| f.eq_ignore_ascii_case(c)))
            {
                continue;
            }
            let others: Vec<String> = ucols
                .iter()
                .filter(|c| !edge.child_cols.iter().any(|f| f.eq_ignore_ascii_case(c)))
                .cloned()
                .collect();
            let sql = collision_groups_sql(
                driver,
                &child_ref,
                &others,
                &scope_all,
                MAX_CONFLICT_GROUPS + 1,
            );
            let found = query(conn, &edge.child_db, &sql).await?;
            if found.rows.is_empty() {
                continue;
            }
            if found.rows.len() > MAX_CONFLICT_GROUPS {
                blockers.push(MergeBlocker::TooManyConflicts {
                    table: edge.child.clone(),
                    index: name,
                });
                continue;
            }
            let other_types: Vec<String> = others
                .iter()
                .map(|c| meta_type(&child_cols_meta, c))
                .collect();
            let mut select_cols = edge.child_cols.clone();
            select_cols.extend(others.iter().cloned());
            let mut idx_drops = 0u64;
            let mut sample: Vec<Vec<String>> = Vec::new();
            for g in &found.rows {
                let gvals: Vec<Value> = g.iter().take(others.len()).cloned().collect();
                if sample.len() < 5 {
                    sample.push(gvals.iter().map(norm_sig).collect());
                }
                let gcond =
                    (!others.is_empty()).then(|| eq_cond(driver, &others, &other_types, &gvals));
                let msql = collision_members_sql(
                    driver,
                    &child_ref,
                    &select_cols,
                    &scope_all,
                    gcond.as_deref(),
                );
                let members = query(conn, &edge.child_db, &msql).await?;
                let loser_sigs: Vec<String> = loser_refs.iter().map(|v| sig(v)).collect();
                let survivor_sig = sig(&survivor_ref);
                let mut tagged: Vec<(Option<usize>, String)> = Vec::new();
                for m in &members.rows {
                    let fk: Vec<Value> = m.iter().take(edge.child_cols.len()).cloned().collect();
                    let s = sig(&fk);
                    let origin = if s == survivor_sig {
                        None
                    } else if let Some(i) = loser_sigs.iter().position(|x| *x == s) {
                        Some(i)
                    } else {
                        continue;
                    };
                    let mut all_cols = edge.child_cols.clone();
                    all_cols.extend(others.iter().cloned());
                    let mut all_types = child_types.clone();
                    all_types.extend(other_types.iter().cloned());
                    tagged.push((origin, eq_cond(driver, &all_cols, &all_types, m)));
                }
                for c in classify_collision_group(&tagged) {
                    idx_drops += 1;
                    if !drops.contains(&c) {
                        drops.push(c);
                    }
                }
            }
            if policy == ConflictPolicy::Abort {
                blockers.push(MergeBlocker::UniqueConflict {
                    table: edge.child.clone(),
                    index: name.clone(),
                    groups: found.rows.len() as u64,
                });
            }
            conflicts.push(RowMergeConflict {
                table: edge.child.clone(),
                index: name,
                columns: ucols,
                groups: found.rows.len() as u64,
                rows: idx_drops,
                sample,
            });
        }
        drops.sort();
        let dropped = drops.len() as u64;
        let (mut skipped, mut deleted) = (0u64, 0u64);
        let mut exclude: Vec<String> = Vec::new();
        match policy {
            ConflictPolicy::Abort => {}
            ConflictPolicy::DeleteColliding => {
                deleted = dropped;
                for (sql, n) in delete_where_sql(&child_ref, &drops) {
                    steps.push(Step {
                        sql,
                        expect: RowExpectation::at_most(n),
                    });
                }
            }
            ConflictPolicy::SkipRepoint => {
                skipped = dropped;
                match skip_blocker(edge.on_delete.as_deref(), fk_enforced, dropped) {
                    Some(SkipBlock::Unsafe) => blockers.push(MergeBlocker::SkipUnsafe {
                        table: edge.child.clone(),
                    }),
                    // 外部キー検査が無効だと、重複行の DELETE で連鎖が働かず孤児行が残る。
                    Some(SkipBlock::NoForeignKeys) => {
                        blockers.push(MergeBlocker::SkipWithoutForeignKeys {
                            table: edge.child.clone(),
                        })
                    }
                    None => {}
                }
                exclude = drops.clone();
            }
        }
        // 消える子行 (衝突で削除する行・飛ばして連鎖で消える行) を、さらに別の表が連鎖 / NULL 化で参照していると
        // 孫の行が黙って消え、Undo にも残らない。見つかれば止める。
        let removes_child_rows = dropped > 0
            && match policy {
                ConflictPolicy::Abort => false,
                ConflictPolicy::DeleteColliding => true,
                ConflictPolicy::SkipRepoint => {
                    edge.on_delete
                        .as_deref()
                        .map(str::to_ascii_uppercase)
                        .as_deref()
                        == Some("CASCADE")
                }
            };
        if removes_child_rows {
            let mut referencing: Vec<String> = Vec::new();
            // 同じスキーマ / DB の表からの参照 (別スキーマの子の場合は、その外部キーは `fks` に無いので除く)。
            if edge.child_db == database {
                for f in fks.iter().filter(|f| {
                    same_name(driver, &f.referenced_table, &edge.child)
                        && on_delete_touches_rows(f.on_delete.as_deref())
                }) {
                    if !referencing.contains(&f.table) {
                        referencing.push(f.table.clone());
                    }
                }
            }
            // 別スキーマ (PostgreSQL) / 別データベース (MySQL) の表からの参照も調べる。取得失敗は "*" で止める。
            match driver {
                DriverKind::Postgres => {
                    match pg_cross_schema_incoming(conn, &edge.child_db, &edge.child).await {
                        Ok(list) => {
                            for e in list
                                .iter()
                                .filter(|e| on_delete_touches_rows(e.on_delete.as_deref()))
                            {
                                let name = format!("{}.{}", e.schema, e.table);
                                if !referencing.contains(&name) {
                                    referencing.push(name);
                                }
                            }
                        }
                        Err(_) => referencing.push("*".to_string()),
                    }
                }
                DriverKind::Mysql => {
                    match mysql_cross_database_incoming(conn, &edge.child_db, &edge.child).await {
                        Ok(list) => {
                            for (schema, tbl, rule) in list {
                                if on_delete_touches_rows(Some(&rule)) {
                                    let name = format!("{schema}.{tbl}");
                                    if !referencing.contains(&name) {
                                        referencing.push(name);
                                    }
                                }
                            }
                        }
                        Err(_) => referencing.push("*".to_string()),
                    }
                }
                DriverKind::Sqlite => {}
            }
            for r in referencing {
                blockers.push(MergeBlocker::DeletedChildReferenced {
                    table: edge.child.clone(),
                    referencing: r,
                });
            }
        }
        let repoint_rows = count.saturating_sub(deleted + skipped);
        let mut sql = repoint_sql(
            driver,
            &child_ref,
            edge,
            &child_types,
            &survivor_ref,
            &loser_match,
            &exclude,
        );
        if let Some(ex) = &excl {
            sql.push_str(ex);
        }
        steps.push(Step {
            sql,
            expect: RowExpectation::at_most(count.saturating_sub(deleted)),
        });
        repointed_total += repoint_rows;
        children.push(RowMergeChild {
            schema: (edge.child_db != database).then(|| edge.child_db.clone()),
            table: edge.child.clone(),
            constraint: edge.constraint.clone(),
            columns: edge.child_cols.clone(),
            parent_columns: edge.parent_cols.clone(),
            on_delete: edge.on_delete.clone(),
            rows: repoint_rows,
            skipped,
            deleted,
            self_reference: self_ref,
        });
        let cap = ChildCap {
            loser_sigs: loser_refs.iter().map(|v| sig(v)).collect(),
            survivor_ref: survivor_ref.clone(),
            fk_cols: edge.child_cols.clone(),
            scope: scope_losers,
        };
        match child_tables.iter_mut().find(|t| t.table_ref == child_ref) {
            Some(t) => t.caps.push(cap),
            None => child_tables.push(ChildTable {
                table: edge.child.clone(),
                table_ref: child_ref,
                pk: child_pk.unwrap_or_default(),
                caps: vec![cap],
            }),
        }
    }

    // 重複行の DELETE → 残す行の UPDATE。
    let loser_conds = &key_conds[1..];
    let deleted_rows = loser_conds.len() as u64;
    for (sql, n) in delete_where_sql(&parent_ref, loser_conds) {
        steps.push(Step {
            sql,
            expect: exact(n),
        });
    }
    let mut sets: Vec<(String, String, Value)> = Vec::new();
    for (i, &p) in picks.iter().enumerate() {
        if p != 0 && norm_sig(&rows[p][i]) != norm_sig(&rows[0][i]) {
            sets.push((
                pcol_names[i].clone(),
                parent_types[i].clone(),
                rows[p][i].clone(),
            ));
        }
    }
    if let Some(sql) = survivor_update_sql(driver, &parent_ref, &sets, &survivor_cond) {
        steps.push(Step {
            sql,
            expect: exact(1),
        });
    }

    let touched = total_child_rows + rows.len() as u64;
    if undo_decline.is_none() && touched > row_cap as u64 {
        undo_decline = Some(UndoDecline::TooManyRows {
            limit: row_cap as u64,
        });
    }
    let columns: Vec<RowMergeColumn> = fetched
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| RowMergeColumn {
            name: c.name.clone(),
            type_name: parent_types[i].clone(),
            locked: locked[i],
        })
        .collect();
    let preview = RowMergePreview {
        columns,
        rows,
        picks,
        key_columns: req.key_columns.clone(),
        children,
        conflicts,
        statements: steps.iter().map(|s| s.sql.clone()).collect(),
        blockers,
        warnings,
        fk_enforced,
        repointed_rows: repointed_total,
        deleted_rows,
        undo_decline,
    };
    Ok(Plan {
        preview,
        steps,
        key_types,
        parent_ref,
        child_tables,
        row_cap,
    })
}

fn row_cap_of(opts_cap: Option<u32>) -> usize {
    opts_cap
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_CAPTURE_ROW_CAP)
        .max(1)
}

/// プレビュー (読み取りのみ。`read_only` 接続でも動く)。
pub async fn preview_row_merge_inner(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
    request: &RowMergeRequest,
    row_cap: Option<u32>,
) -> Result<RowMergePreview> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    Ok(
        build_plan(&session, database, table, request, row_cap_of(row_cap))
            .await?
            .preview,
    )
}

/// 重複レコードのマージのプレビュー (#2303)。残す行・重複行を DB から読み直し、子テーブルごとの付け替え件数・
/// 衝突・実行する SQL を返す。読み取りのみ。
#[tauri::command]
pub async fn preview_row_merge(
    session_id: String,
    database: String,
    table: String,
    request: RowMergeRequest,
    row_cap: Option<u32>,
    state: State<'_, AppState>,
) -> Result<RowMergePreview> {
    preview_row_merge_inner(
        state.inner(),
        &session_id,
        &database,
        &table,
        &request,
        row_cap,
    )
    .await
}

/// 重複レコードのマージを実行する (#2303)。子の付け替え → 重複行の DELETE → 残す行の UPDATE を 1 トランザクション
/// (all-or-nothing) で行う。実行の直前にもう一度計画を立て直し、衝突があれば何も書かずに `blocked` を返す。
/// `read_only` 接続はバックエンドが拒否する。
#[tauri::command]
pub async fn apply_row_merge(
    session_id: String,
    database: String,
    table: String,
    request: RowMergeRequest,
    options: Option<RowMergeOptions>,
    state: State<'_, AppState>,
) -> Result<RowMergeOutcome> {
    apply_row_merge_inner(
        state.inner(),
        &session_id,
        &database,
        &table,
        &request,
        options.unwrap_or_default(),
    )
    .await
}

pub async fn apply_row_merge_inner(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
    request: &RowMergeRequest,
    options: RowMergeOptions,
) -> Result<RowMergeOutcome> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // read_only は文ごとのガードでも拒否されるが、計画を立てる前に明示的に止める。
    crate::commands::query::ensure_allowed_for_session(&session, "DELETE FROM merge_guard")?;
    let cap_cfg = options.capture.clone().filter(|_| !session.skip_history);
    let row_cap = row_cap_of(cap_cfg.as_ref().and_then(|c| c.row_cap));
    let plan = build_plan(&session, database, table, request, row_cap).await?;
    // プレビューの後でデータが変わっていれば、何も書かずに止める (利用者はプレビューを見直す)。
    if let Some(exp) = &request.expected {
        let actual = child_row_counts(&plan.preview.children);
        if exp.statements != plan.preview.statements || exp.child_rows != actual {
            return Ok(RowMergeOutcome::Changed {
                expected_rows: exp.child_rows.iter().sum(),
                actual_rows: actual.iter().sum(),
                statements_changed: exp.statements != plan.preview.statements,
            });
        }
    }
    if !plan.preview.blockers.is_empty() {
        return Ok(RowMergeOutcome::Blocked {
            blockers: plan.preview.blockers,
        });
    }
    let snapshot = match (&cap_cfg, &plan.preview.undo_decline) {
        (Some(_), None) => capture_before(&session, database, table, request, &plan).await,
        _ => None,
    };
    let statements: Vec<String> = plan.steps.iter().map(|s| s.sql.clone()).collect();
    let expects: Vec<RowExpectation> = plan.steps.iter().map(|s| s.expect).collect();
    let run = run_query_transaction_guarded_inner(
        state,
        session_id.to_string(),
        statements.clone(),
        expects,
        db_opt(database).map(str::to_string),
    )
    .await?;
    Ok(match run {
        TransactionRun::Committed(_) => {
            let capture = match (snapshot, &cap_cfg) {
                (Some(snap), Some(cfg)) => {
                    capture_after(
                        &session,
                        database,
                        table,
                        request,
                        &plan,
                        snap,
                        cfg,
                        &statements.join(";\n"),
                    )
                    .await
                }
                _ => RowMergeCaptureOutcome::default(),
            };
            RowMergeOutcome::Applied {
                repointed_rows: plan.preview.repointed_rows,
                deleted_rows: plan.preview.deleted_rows,
                capture,
            }
        }
        TransactionRun::RolledBack(v) => RowMergeOutcome::Changed {
            expected_rows: v.expected,
            actual_rows: v.actual,
            statements_changed: false,
        },
        TransactionRun::RollbackIncomplete(v) => RowMergeOutcome::RollbackIncomplete {
            expected_rows: v.expected,
            actual_rows: v.actual,
        },
    })
}

// ---------------------------------------------------------------- フライトレコーダー

#[derive(Debug, Clone, Default)]
struct Fetched {
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
}

struct ChildSnapshot {
    pk_idx: Vec<usize>,
    before: Fetched,
    /// 予測した新しいキー (主キーが外部キー列を含む表のみ)。
    new_keys: Vec<(String, Vec<Value>)>,
    new_pre_sigs: HashSet<String>,
}

struct Snapshot {
    children: Vec<Option<ChildSnapshot>>,
}

async fn fetch_by_conds(
    conn: &Connection,
    database: &str,
    table_ref: &str,
    conds: &[String],
) -> Option<Fetched> {
    let mut out = Fetched::default();
    for chunk in conds.chunks(crate::db::row_merge::COND_CHUNK) {
        let w = or_conds(chunk)?;
        let r = query(
            conn,
            database,
            &format!("SELECT * FROM {table_ref} WHERE {w}"),
        )
        .await
        .ok()?;
        if out.columns.is_empty() {
            out.columns = r.columns;
        }
        out.rows.extend(r.rows);
    }
    Some(out)
}

fn idx_of(columns: &[Column], names: &[String]) -> Option<Vec<usize>> {
    let v: Vec<usize> = names.iter().filter_map(|n| col_pos(columns, n)).collect();
    (v.len() == names.len() && !v.is_empty()).then_some(v)
}

fn row_sig(row: &[Value], idx: &[usize]) -> String {
    sig(&idx.iter().map(|&i| row[i].clone()).collect::<Vec<_>>())
}

/// 実行の直前: 子の対象行 (before) と、新しいキーに既にある行を読む。読めなければ記録を辞退する (`None`)。
async fn capture_before(
    session: &Session,
    database: &str,
    _table: &str,
    _req: &RowMergeRequest,
    plan: &Plan,
) -> Option<Snapshot> {
    let conn = &session.conn;
    let mut children = Vec::new();
    for t in &plan.child_tables {
        if t.pk.is_empty() {
            return None;
        }
        let scopes: Vec<String> = t.caps.iter().map(|c| c.scope.clone()).collect();
        let before = fetch_by_conds(conn, database, &t.table_ref, &scopes).await?;
        if before.rows.len() > plan.row_cap {
            return None;
        }
        let pk_idx = idx_of(&before.columns, &t.pk)?;
        let pk_types: Vec<String> = pk_idx
            .iter()
            .map(|&i| before.columns[i].type_name.clone())
            .collect();
        let mut seen = HashSet::new();
        if !before.rows.iter().all(|r| seen.insert(row_sig(r, &pk_idx))) {
            return None;
        }
        let fk_in_pk = t.caps.iter().any(|c| {
            c.fk_cols
                .iter()
                .any(|f| t.pk.iter().any(|p| p.eq_ignore_ascii_case(f)))
        });
        let mut new_keys = Vec::new();
        let mut new_pre_sigs = HashSet::new();
        if fk_in_pk {
            for r in &before.rows {
                let mut nr = r.clone();
                for cap in &t.caps {
                    let fk_idx = idx_of(&before.columns, &cap.fk_cols)?;
                    let cur: Vec<Value> = fk_idx.iter().map(|&i| r[i].clone()).collect();
                    if cap.loser_sigs.contains(&sig(&cur)) {
                        for (j, &i) in fk_idx.iter().enumerate() {
                            nr[i] = cap.survivor_ref[j].clone();
                        }
                    }
                }
                let key: Vec<Value> = pk_idx.iter().map(|&i| nr[i].clone()).collect();
                new_keys.push((sig(&key), key));
            }
            let conds: Vec<String> = new_keys
                .iter()
                .map(|(_, k)| eq_cond(conn.driver_kind(), &t.pk, &pk_types, k))
                .collect();
            let pre = fetch_by_conds(conn, database, &t.table_ref, &conds).await?;
            let pidx = idx_of(&pre.columns, &t.pk)?;
            new_pre_sigs = pre.rows.iter().map(|r| row_sig(r, &pidx)).collect();
        }
        children.push(Some(ChildSnapshot {
            pk_idx,
            before,
            new_keys,
            new_pre_sigs,
        }));
    }
    Some(Snapshot { children })
}

fn build_capture(
    kind: WriteKind,
    table: &str,
    pk: &[String],
    columns: &[Column],
    before_rows: Vec<Vec<Value>>,
    after_rows: Vec<Vec<Value>>,
) -> WriteCapture {
    WriteCapture {
        kind,
        capturable: true,
        reason: None,
        table: Some(table.to_string()),
        primary_key: pk.to_vec(),
        columns: columns.iter().map(|c| c.name.clone()).collect(),
        column_types: columns.iter().map(|c| c.type_name.clone()).collect(),
        rows_affected: before_rows.len().max(after_rows.len()) as u64,
        before_rows,
        after_rows,
        companion: None,
    }
}

/// 子テーブルの before / after から記録 (Update / Delete / Insert) を組み立てる純関数。
/// Update の before は「after 行の `set_idx` の列だけを before の値に戻した行」にして、
/// 同時に他者が変えた別の列を Undo が巻き戻さないようにする。
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ChildDiff {
    pub updates: Vec<(Vec<Value>, Vec<Value>)>,
    pub deletes: Vec<Vec<Value>>,
    pub inserts: Vec<Vec<Value>>,
}

pub(crate) fn diff_child(
    pk_idx: &[usize],
    set_idx: &[usize],
    before: &[Vec<Value>],
    new_keys: &[(String, Vec<Value>)],
    new_pre_sigs: &HashSet<String>,
    after: &[Vec<Value>],
) -> ChildDiff {
    let a_by: HashMap<String, &Vec<Value>> =
        after.iter().map(|r| (row_sig(r, pk_idx), r)).collect();
    let before_sigs: HashSet<String> = before.iter().map(|r| row_sig(r, pk_idx)).collect();
    let mut d = ChildDiff::default();
    for b in before {
        match a_by.get(&row_sig(b, pk_idx)) {
            Some(a) => {
                let mut restored = (*a).clone();
                for &i in set_idx {
                    restored[i] = b[i].clone();
                }
                if restored != **a {
                    d.updates.push((restored, (*a).clone()));
                }
            }
            None => d.deletes.push(b.clone()),
        }
    }
    for (s, _) in new_keys {
        if !before_sigs.contains(s) && !new_pre_sigs.contains(s) {
            if let Some(a) = a_by.get(s) {
                d.inserts.push((*a).clone());
            }
        }
    }
    d
}

#[allow(clippy::too_many_arguments)]
async fn capture_after(
    session: &Session,
    database: &str,
    table: &str,
    req: &RowMergeRequest,
    plan: &Plan,
    snap: Snapshot,
    cfg: &BulkCaptureConfig,
    sql_text: &str,
) -> RowMergeCaptureOutcome {
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let mut declined = 0u32;
    let mut captures: Vec<WriteCapture> = Vec::new();
    for (t, s) in plan.child_tables.iter().zip(snap.children.iter()) {
        let Some(s) = s else {
            declined += 1;
            continue;
        };
        let pk_types: Vec<String> = s
            .pk_idx
            .iter()
            .map(|&i| s.before.columns[i].type_name.clone())
            .collect();
        let mut conds: Vec<String> = s
            .before
            .rows
            .iter()
            .map(|r| {
                let k: Vec<Value> = s.pk_idx.iter().map(|&i| r[i].clone()).collect();
                eq_cond(driver, &t.pk, &pk_types, &k)
            })
            .collect();
        conds.extend(
            s.new_keys
                .iter()
                .map(|(_, k)| eq_cond(driver, &t.pk, &pk_types, k)),
        );
        let Some(after) = fetch_by_conds(conn, database, &t.table_ref, &conds).await else {
            declined += 1;
            continue;
        };
        let mut set_idx: Vec<usize> = Vec::new();
        for cap in &t.caps {
            if let Some(v) = idx_of(&s.before.columns, &cap.fk_cols) {
                set_idx.extend(v);
            }
        }
        // 主キーに含まれる外部キー列は Update ではなく Delete + Insert で表す。
        set_idx.retain(|i| !s.pk_idx.contains(i));
        let d = diff_child(
            &s.pk_idx,
            &set_idx,
            &s.before.rows,
            &s.new_keys,
            &s.new_pre_sigs,
            &after.rows,
        );
        let cols = &s.before.columns;
        if !d.updates.is_empty() {
            let (b, a): (Vec<_>, Vec<_>) = d.updates.into_iter().unzip();
            captures.push(build_capture(
                WriteKind::Update,
                &t.table,
                &t.pk,
                cols,
                b,
                a,
            ));
        }
        if !d.deletes.is_empty() {
            captures.push(build_capture(
                WriteKind::Delete,
                &t.table,
                &t.pk,
                cols,
                d.deletes,
                vec![],
            ));
        }
        if !d.inserts.is_empty() {
            captures.push(build_capture(
                WriteKind::Insert,
                &t.table,
                &t.pk,
                cols,
                vec![],
                d.inserts,
            ));
        }
    }
    // 親: 残す行の UPDATE (採用元で変えた列だけ) と、重複行の DELETE。
    let parent_fetch = query(
        conn,
        database,
        &format!("SELECT * FROM {} WHERE {}", plan.parent_ref, {
            let conds: Vec<String> = std::iter::once(&req.survivor)
                .chain(req.losers.iter())
                .map(|k| eq_cond(driver, &req.key_columns, &plan.key_types, k))
                .collect();
            or_conds(&conds).unwrap_or_default()
        }),
    )
    .await
    .ok();
    let p = &plan.preview;
    let cols: Vec<Column> = p
        .columns
        .iter()
        .map(|c| Column {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
        })
        .collect();
    let set_idx: Vec<usize> = p
        .picks
        .iter()
        .enumerate()
        .filter(|(i, &pk)| pk != 0 && norm_sig(&p.rows[pk][*i]) != norm_sig(&p.rows[0][*i]))
        .map(|(i, _)| i)
        .collect();
    // 実行順 (重複行の DELETE → 残す行の UPDATE) のとおりに保存する。Undo は逆順なので、残す行の列値が先に戻る。
    captures.push(build_capture(
        WriteKind::Delete,
        table,
        &req.key_columns,
        &cols,
        p.rows[1..].to_vec(),
        vec![],
    ));
    if !set_idx.is_empty() {
        let kidx: Option<Vec<usize>> = parent_fetch
            .as_ref()
            .and_then(|f| idx_of(&f.columns, &req.key_columns));
        let after_row = parent_fetch.as_ref().and_then(|f| {
            let k = kidx.as_ref()?;
            let want = sig(&req.survivor);
            f.rows.iter().find(|r| row_sig(r, k) == want).cloned()
        });
        match after_row {
            Some(a) => {
                let mut restored = a.clone();
                for &i in &set_idx {
                    restored[i] = p.rows[0][i].clone();
                }
                captures.push(build_capture(
                    WriteKind::Update,
                    table,
                    &req.key_columns,
                    &cols,
                    vec![restored],
                    vec![a],
                ));
            }
            None => declined += 1,
        }
    }

    let mut out = RowMergeCaptureOutcome {
        recorded: 0,
        declined,
        batch_id: None,
    };
    let batch_id = new_batch_id();
    for c in &captures {
        let saved = persist_capture(
            session.skip_history,
            session.profile_id.clone(),
            driver,
            db_opt(database).map(str::to_string),
            sql_text.to_string(),
            c,
            cfg.retention_days.map(i64::from),
            Some(batch_id.clone()),
        )
        .await;
        if saved.is_some() {
            out.recorded += 1;
        } else {
            out.declined += 1;
        }
    }
    if out.recorded > 0 {
        out.batch_id = Some(batch_id);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(vals: &[i64]) -> Vec<Value> {
        vals.iter().map(|v| Value::Int(*v)).collect()
    }

    #[test]
    fn diff_child_classifies_update_delete_insert() {
        // 子の主キーは (order, coupon) = 列 0, 1。外部キー列 0 を 1 -> 9 に付け替える。
        let before = vec![r(&[1, 5, 0]), r(&[1, 6, 0])];
        // (1,5) は (9,5) へ移動 (Delete + Insert)、(1,6) は衝突で削除された (Delete のみ)。
        let new_keys = vec![
            (sig(&r(&[9, 5])), r(&[9, 5])),
            (sig(&r(&[9, 6])), r(&[9, 6])),
        ];
        let pre: HashSet<String> = [sig(&r(&[9, 6]))].into_iter().collect();
        let after = vec![r(&[9, 5, 0]), r(&[9, 6, 0])];
        let d = diff_child(&[0, 1], &[], &before, &new_keys, &pre, &after);
        assert_eq!(d.deletes, vec![r(&[1, 5, 0]), r(&[1, 6, 0])]);
        assert_eq!(d.inserts, vec![r(&[9, 5, 0])]);
        assert!(d.updates.is_empty());
    }

    #[test]
    fn diff_child_update_restores_only_set_columns() {
        // 主キー列 0、外部キー列 1。列 2 は別の人が変えた値。
        let before = vec![r(&[10, 1, 7])];
        let after = vec![r(&[10, 9, 8])];
        let d = diff_child(&[0], &[1], &before, &[], &HashSet::new(), &after);
        assert_eq!(d.updates, vec![(r(&[10, 1, 8]), r(&[10, 9, 8]))]);
    }
}
