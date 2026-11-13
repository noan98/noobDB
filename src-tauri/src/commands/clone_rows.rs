//! 行を子レコードごと同じ DB 内に複製する (#2304)。
//!
//! 行の収集は `commands::subset` と同じ `SubsetWalk` を**子の方向だけ**で動かす (親は辿らない。
//! 外部への参照はそのまま残る)。どの列をどう決めるかの判断は純粋層 `db::clone_rows` が持ち、
//! ここは実 DB で駆動する層。
//!
//! - **書き込みは 1 トランザクション。** 表は親が先の順、表の中の自己参照は参照される行が先の順に
//!   1 行ずつ `INSERT` し、失敗したら全部ロールバックする。PostgreSQL / SQLite は `RETURNING`、
//!   MySQL は `LAST_INSERT_ID()` で採番値を受け取る。式の方針 (`gen_random_uuid()` など) は
//!   `SELECT (式)` で評価した値を `INSERT` する (3 ドライバで同じ経路にするため)。
//! - **`read_only` 接続はバックエンドが拒否する** (緊急書き込みモードでも)。`is_production` /
//!   `confirm_writes` の確認は UI レベルの責務 (`CloneRowsModal`)。
//! - **Undo**: コミット後、新しい行の全列のイメージを表ごとに `Insert` の記録として、同じ
//!   `batch_id` でフライトレコーダーへ保存する (`preview_flight_batch` / `apply_flight_batch`)。
//!   記録は親が先の順で保存するので、バッチの取り消しは子から消える。主キーの無い表は記録できない。
//! - 実行前に、方針が足りない表・UNIQUE の衝突・循環があれば何も書かずに `InvalidInput` で返す。

use std::collections::BTreeSet;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::commands::bulk_capture::BulkCaptureConfig;
use crate::commands::query::record_write_history;
use crate::commands::subset::{collect_subset_with, CollectMode, SubsetColumnInfo, SubsetRequest};
use crate::db::clone_rows::{
    analyze, auto_columns, expression_select, insert_sql, key_of, rule_columns,
    validate_expression, CloneColumnRule, CloneInput, CloneTable, FkRemap, KeyColumnReport,
    KeyRule, TableReport, UniqueConflict, MAX_CLONE_ROWS,
};
use crate::db::data_diff::key_signature;
use crate::db::subset::{
    key_literal, select_by_keys_sql, SubsetWarning, COMPOSITE_KEY_CHUNK, KEY_CHUNK,
};
use crate::db::sync::table_ref_for;
use crate::db::types::Value;
use crate::db::{Connection, DriverKind, WriteCapture, WriteKind};
use crate::error::{AppError, Result};
use crate::flight_recorder::{new_batch_id, persist_capture};
use crate::state::{AppState, Session};

/// 履歴に残す `INSERT` 文の最大数 (それ以上は省略する)。
const HISTORY_STATEMENTS: usize = 200;
/// 履歴に残す SQL テキストの最大文字数 (超えたら末尾を省略する)。
const HISTORY_MAX_CHARS: usize = 20_000;

fn history_text(statements: &[String]) -> String {
    let joined = statements.join(";\n");
    if joined.chars().count() <= HISTORY_MAX_CHARS {
        return joined;
    }
    let mut cut: String = joined.chars().take(HISTORY_MAX_CHARS).collect();
    cut.push_str("\n-- (truncated)");
    cut
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneTablePreview {
    pub table: String,
    pub rows: u64,
    pub root_rows: u64,
    pub child_rows: u64,
    pub columns: Vec<SubsetColumnInfo>,
    pub key_columns: Vec<KeyColumnReport>,
    pub needs_policy: bool,
    pub conflicts: Vec<UniqueConflict>,
}

/// 実行前のプレビュー: 表ごとの件数・主キーの決まり方・衝突 (挿入順)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneRowsPreview {
    /// 挿入順 (親が先)。
    pub tables: Vec<CloneTablePreview>,
    pub total_rows: u64,
    pub cycles: Vec<Vec<String>>,
    pub warnings: Vec<SubsetWarning>,
    /// 実行を止める問題 (方針の不足・UNIQUE の衝突・循環) が無いか。
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneKeyMapping {
    pub old_key: Vec<Value>,
    pub new_key: Vec<Value>,
    /// 選んだ起点の行か (新しい親の行)。
    pub root: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneTableOutcome {
    pub table: String,
    pub rows: u64,
    /// 旧キー → 新キーの対応表の列 (主キー)。主キーの無い表は空で、対応表も空。
    pub key_columns: Vec<String>,
    pub mappings: Vec<CloneKeyMapping>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneRowsOutcome {
    pub tables: Vec<CloneTableOutcome>,
    pub total_rows: u64,
    pub root_table: String,
    pub root_key_columns: Vec<String>,
    /// 新しい親の行の主キー (起点の行ごと)。
    pub root_new_keys: Vec<Vec<Value>>,
    /// Undo 用に保存した記録の件数と、記録できなかった表の数 (主キーが無い等)。
    pub recorded: u32,
    pub declined: u32,
    /// 記録できなかった表 (主キーが無い・読み戻せない・行数の上限超過・保存の失敗)。
    pub declined_tables: Vec<String>,
    /// フライトレコーダーへの記録を試みたか (設定がオフ・履歴を残さない接続では偽)。
    pub capture_enabled: bool,
    /// 記録に共通のバッチ id (保存できなければ `None`)。
    pub batch_id: Option<String>,
    pub warnings: Vec<SubsetWarning>,
}

struct Prepared {
    collected: crate::commands::subset::Collected,
    tables: Vec<CloneTable>,
    reports: Vec<TableReport>,
    attached: String,
    exec_db: Option<String>,
    root_table: String,
}

/// 方針の指定を検査する (存在しない列・不正な式はエラー。行の無い表への指定は無視する)。
fn validate_rules(
    driver: DriverKind,
    prepared: &[CloneTable],
    rules: &[CloneColumnRule],
) -> Result<()> {
    for (table, cols) in rule_columns(rules) {
        let Some(t) = prepared.iter().find(|t| t.meta.name == table) else {
            continue;
        };
        for c in cols {
            if !t.meta.columns.iter().any(|x| x == c) {
                return Err(AppError::InvalidInput(format!(
                    "table '{table}' has no column '{c}' to override"
                )));
            }
        }
    }
    for r in rules {
        if let KeyRule::Expression { sql } = &r.rule {
            validate_expression(driver, sql)?;
        }
    }
    Ok(())
}

async fn prepare(
    session: &Session,
    req: &SubsetRequest,
    rules: &[CloneColumnRule],
) -> Result<Prepared> {
    let collected = collect_subset_with(
        session,
        req,
        CollectMode {
            follow_parents: false,
            max_total_rows: MAX_CLONE_ROWS,
        },
        |_| {},
    )
    .await?;
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let db = conn.resolve_database(req.source_database.as_deref()).await;
    let mut tables = Vec::with_capacity(collected.result.tables.len());
    for t in &collected.result.tables {
        let Some(meta) = collected.tables.get(&t.table) else {
            continue;
        };
        let cols = conn.columns(&db, &t.table).await?;
        // SQLite の INTEGER 主キーが採番されるのは rowid 表だけ (WITHOUT ROWID 表は採番されない)。
        let rowid_alias = match conn {
            Connection::Sqlite(c) => c.is_rowid_table(&db, &t.table).await?,
            Connection::MySql(_) | Connection::Postgres(_) => true,
        };
        let auto = auto_columns(driver, &cols, &meta.primary_key, rowid_alias);
        let unique_indexes = conn
            .list_indexes(&db, &t.table)
            .await?
            .into_iter()
            .filter(|i| {
                i.unique && !i.primary && i.first_expression_at.is_none() && i.predicate.is_none()
            })
            .map(|i| (i.name, i.columns))
            .collect();
        tables.push(CloneTable {
            meta: meta.clone(),
            auto_columns: auto,
            unique_indexes,
        });
    }
    validate_rules(driver, &tables, rules)?;
    let inputs: Vec<CloneInput<'_>> = tables
        .iter()
        .zip(collected.result.tables.iter())
        .map(|(table, rows)| CloneInput {
            table,
            rows: &rows.rows,
        })
        .collect();
    let reports = analyze(&inputs, &collected.edges, rules);
    let attached =
        conn.resolve_attached_database(req.source_database.as_deref().unwrap_or_default());
    let exec_db = req
        .source_database
        .as_deref()
        .filter(|d| !d.is_empty())
        .map(str::to_string);
    Ok(Prepared {
        collected,
        tables,
        reports,
        attached,
        exec_db,
        root_table: req.table.trim().to_string(),
    })
}

fn preview_of(p: &Prepared) -> CloneRowsPreview {
    let tables = p
        .collected
        .result
        .tables
        .iter()
        .zip(p.reports.iter())
        .map(|(t, r)| {
            let key_of = |name: &str| {
                t.primary_key.iter().any(|k| k == name)
                    || p.collected.edges.iter().any(|e| {
                        (e.child == t.table && e.child_cols.iter().any(|x| x == name))
                            || (e.parent == t.table && e.parent_cols.iter().any(|x| x == name))
                    })
            };
            CloneTablePreview {
                table: t.table.clone(),
                rows: t.rows.len() as u64,
                root_rows: t.root_rows,
                child_rows: t.child_rows,
                columns: t
                    .columns
                    .iter()
                    .map(|n| SubsetColumnInfo {
                        name: n.clone(),
                        key: key_of(n),
                    })
                    .collect(),
                key_columns: r.key_columns.clone(),
                needs_policy: r.needs_policy,
                conflicts: r.conflicts.clone(),
            }
        })
        .collect();
    let cycles = p.collected.result.cycles.clone();
    CloneRowsPreview {
        tables,
        total_rows: p.collected.result.total_rows(),
        ready: cycles.is_empty()
            && p.collected.result.total_rows() > 0
            && !p.reports.iter().any(TableReport::blocked),
        cycles,
        warnings: p.collected.result.warnings.clone(),
    }
}

/// 実行前の検査。1 つでも問題があれば何も書かずにエラーにする。
fn ensure_ready(p: &Prepared) -> Result<()> {
    if p.collected.result.total_rows() == 0 {
        return Err(AppError::InvalidInput("there are no rows to clone".into()));
    }
    if let Some(c) = p.collected.result.cycles.first() {
        return Err(AppError::InvalidInput(format!(
            "foreign keys form a cycle among: {}; rows cannot be cloned in a valid order",
            c.join(", ")
        )));
    }
    let missing: Vec<&str> = p
        .reports
        .iter()
        .filter(|r| r.needs_policy)
        .map(|r| r.table.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "no key policy for: {}; the primary key is not auto-generated, so choose an expression or an override value",
            missing.join(", ")
        )));
    }
    if let Some(r) = p.reports.iter().find(|r| !r.conflicts.is_empty()) {
        let c = &r.conflicts[0];
        return Err(AppError::InvalidInput(format!(
            "unique index '{}' on '{}' ({}) would conflict for {} cloned row(s); override these columns",
            c.index,
            r.table,
            c.columns.join(", "),
            c.rows
        )));
    }
    Ok(())
}

/// 実行せずに、表ごとの件数・主キーの決まり方・UNIQUE の衝突を返す (行は読むが何も書かない)。
pub async fn preview_clone_rows_inner(
    state: &AppState,
    request: SubsetRequest,
    rules: Vec<CloneColumnRule>,
) -> Result<CloneRowsPreview> {
    let session = state
        .get(&request.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.source_session_id.clone()))?;
    let prepared = prepare(&session, &request, &rules).await?;
    Ok(preview_of(&prepared))
}

/// 行の複製のプレビュー (#2304)。書き込みはしない。
#[tauri::command]
pub async fn preview_clone_rows(
    request: SubsetRequest,
    rules: Vec<CloneColumnRule>,
    state: State<'_, AppState>,
) -> Result<CloneRowsPreview> {
    preview_clone_rows_inner(&state, request, rules).await
}

struct TableApplied {
    rows: u64,
    mappings: Vec<CloneKeyMapping>,
    /// コミット前に読み戻した新しい行の全列 (記録用)。読み戻せなければ `None`。
    after_rows: Option<Vec<Vec<Value>>>,
}

fn first_cell(res: &crate::db::types::QueryResult, what: &str) -> Result<Value> {
    res.rows
        .first()
        .and_then(|r| r.first())
        .cloned()
        .ok_or_else(|| AppError::Other(format!("{what} returned no value")))
}

/// 開いたトランザクションの中で、全表の行を挿入する。
async fn apply(
    session: &Session,
    p: &Prepared,
    rules: &[CloneColumnRule],
    statements: &mut Vec<String>,
) -> Result<Vec<TableApplied>> {
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let root_table = p.root_table.clone();
    let root_sigs: BTreeSet<String> = p
        .tables
        .iter()
        .find(|t| t.meta.name == root_table)
        .map(|rt| {
            p.collected
                .roots
                .iter()
                .filter_map(|r| key_of(&rt.meta, r))
                .map(|k| key_signature(&k))
                .collect()
        })
        .unwrap_or_default();
    let mut remap = FkRemap::new(&p.collected.edges);
    let mut out = Vec::with_capacity(p.tables.len());
    for (ct, data) in p.tables.iter().zip(p.collected.result.tables.iter()) {
        let meta = &ct.meta;
        let table_ref = table_ref_for(driver, &p.attached, &meta.name);
        let table_rules: Vec<&CloneColumnRule> =
            rules.iter().filter(|r| r.table == meta.name).collect();
        let mut mappings = Vec::new();
        let mut new_keys = Vec::new();
        for old in &data.rows {
            let mut vals = old.clone();
            let mut changed = remap.remap(meta, &mut vals);
            for r in &table_rules {
                let Some(i) = meta.columns.iter().position(|c| *c == r.column) else {
                    continue;
                };
                let ty = meta.column_types.get(i).map(String::as_str).unwrap_or("");
                let new = match &r.rule {
                    KeyRule::Literal { value } => match value {
                        Some(s) => Value::String(s.clone()),
                        None => Value::Null,
                    },
                    KeyRule::Expression { sql } => {
                        let select =
                            expression_select(driver, sql, ty, old.get(i).unwrap_or(&Value::Null))?;
                        let res = conn
                            .fetch_in_transaction_bound(&select.sql, &select.binds)
                            .await?;
                        first_cell(&res, "the key expression")?
                    }
                };
                if let Some(slot) = vals.get_mut(i) {
                    *slot = new;
                }
                changed.insert(i);
            }
            // DB が採番する列 (方針も張り替えも無いもの) は INSERT に含めず、採番値を受け取る。
            let omitted: Vec<usize> = ct
                .auto_columns
                .iter()
                .filter_map(|c| meta.columns.iter().position(|x| x == c))
                .filter(|i| !changed.contains(i))
                .collect();
            let mut cols = Vec::new();
            let mut lits = Vec::new();
            for (i, name) in meta.columns.iter().enumerate() {
                if omitted.contains(&i) {
                    continue;
                }
                cols.push(name.clone());
                let ty = meta.column_types.get(i).map(String::as_str).unwrap_or("");
                lits.push(key_literal(driver, ty, vals.get(i).unwrap_or(&Value::Null)));
            }
            let returning: Vec<String> = omitted
                .iter()
                .filter_map(|&i| meta.columns.get(i).cloned())
                .collect();
            let sql = insert_sql(driver, &table_ref, &cols, &lits, &returning);
            if returning.is_empty() {
                conn.execute_in_transaction(&sql).await?;
            } else if driver == DriverKind::Mysql {
                if returning.len() > 1 {
                    return Err(AppError::InvalidInput(format!(
                        "table '{}' has several generated key columns; give an override for them",
                        meta.name
                    )));
                }
                conn.execute_in_transaction(&sql).await?;
                let res = conn
                    .execute_in_transaction("SELECT LAST_INSERT_ID()")
                    .await?;
                let id = first_cell(&res, "LAST_INSERT_ID()")?;
                if matches!(id, Value::Int(0) | Value::UInt(0)) {
                    return Err(AppError::Other(format!(
                        "could not read the generated key of '{}'",
                        meta.name
                    )));
                }
                if let Some(slot) = omitted.first().and_then(|&i| vals.get_mut(i)) {
                    *slot = id;
                }
            } else {
                let res = conn.fetch_in_transaction(&sql).await?;
                let row = res.rows.first().ok_or_else(|| {
                    AppError::Other(format!(
                        "INSERT into '{}' returned no generated key",
                        meta.name
                    ))
                })?;
                for (&i, v) in omitted.iter().zip(row.iter()) {
                    if let Some(slot) = vals.get_mut(i) {
                        *slot = v.clone();
                    }
                }
            }
            if statements.len() < HISTORY_STATEMENTS {
                statements.push(sql);
            }
            remap.register(meta, old, &vals);
            if let (Some(ok), Some(nk)) = (key_of(meta, old), key_of(meta, &vals)) {
                let is_root = meta.name == root_table && root_sigs.contains(&key_signature(&ok));
                new_keys.push(nk.clone());
                mappings.push(CloneKeyMapping {
                    old_key: ok,
                    new_key: nk,
                    root: is_root,
                });
            }
        }
        let after_rows = read_back(session, meta, &table_ref, &new_keys, data.rows.len()).await;
        out.push(TableApplied {
            rows: data.rows.len() as u64,
            mappings,
            after_rows,
        });
    }
    Ok(out)
}

/// 採番値 (MySQL の `LAST_INSERT_ID()` は符号なし) と読み戻した行で整数の型が違っても同じ行と
/// 見なす署名。
fn loose_sig(key: &[Value]) -> String {
    key.iter()
        .map(|v| match v {
            Value::Int(i) => i.to_string(),
            Value::UInt(u) => u.to_string(),
            Value::String(s) => s.clone(),
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// 挿入した行の全列をコミット前に読み戻す (Undo の記録用)。主キーが無い・読めない・件数が合わない
/// ときは `None` (記録を辞退するだけで複製は妨げない)。
async fn read_back(
    session: &Session,
    meta: &crate::db::subset::SubsetTable,
    table_ref: &str,
    new_keys: &[Vec<Value>],
    expected: usize,
) -> Option<Vec<Vec<Value>>> {
    let driver = session.conn.driver_kind();
    if meta.primary_key.is_empty() || new_keys.len() != expected {
        return None;
    }
    let chunk = if meta.primary_key.len() > 1 {
        COMPOSITE_KEY_CHUNK
    } else {
        KEY_CHUNK
    };
    let mut rows = Vec::new();
    for keys in new_keys.chunks(chunk) {
        let sql =
            select_by_keys_sql(driver, table_ref, meta, &meta.primary_key, keys, None).ok()?;
        let res = session.conn.fetch_in_transaction(&sql).await.ok()?;
        rows.extend(res.rows);
    }
    if rows.len() != expected {
        return None;
    }
    // 挿入と逆の順 (子が先) に並べる。Undo の DELETE は記録の行順に出るので、自己参照の表でも
    // 子から消えて外部キー違反にならない。
    let mut by_key: std::collections::HashMap<String, Vec<Value>> = rows
        .into_iter()
        .filter_map(|r| key_of(meta, &r).map(|k| (loose_sig(&k), r)))
        .collect();
    let ordered: Vec<Vec<Value>> = new_keys
        .iter()
        .rev()
        .filter_map(|k| by_key.remove(&loose_sig(k)))
        .collect();
    (ordered.len() == expected).then_some(ordered)
}

/// 子レコードごと行を複製する (#2304)。`read_only` 接続は拒否する。
pub async fn clone_rows_inner(
    state: &AppState,
    request: SubsetRequest,
    rules: Vec<CloneColumnRule>,
    capture: Option<BulkCaptureConfig>,
) -> Result<CloneRowsOutcome> {
    let session = state
        .get(&request.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.source_session_id.clone()))?;
    if session.read_only {
        tracing::warn!(session_id = %session.id, "read-only guard rejected a row clone");
        return Err(AppError::ReadOnly(
            "read-only profile: cloning rows is not allowed".into(),
        ));
    }
    let prepared = prepare(&session, &request, &rules).await?;
    ensure_ready(&prepared)?;
    let conn = &session.conn;
    if conn.transaction_active().await {
        return Err(AppError::InvalidInput(
            "finish the open transaction before cloning rows".into(),
        ));
    }
    let started = Instant::now();
    conn.begin_transaction(prepared.exec_db.as_deref()).await?;
    let mut statements = Vec::new();
    let applied = match apply(&session, &prepared, &rules, &mut statements).await {
        Ok(a) => a,
        Err(e) => {
            if let Err(re) = conn.finish_transaction(false).await {
                tracing::warn!(error = %re, "rollback after a failed row clone also failed");
            }
            record_write_history(
                &session,
                history_text(&statements),
                prepared.exec_db.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await;
            return Err(e);
        }
    };
    conn.finish_transaction(true).await?;
    let total: u64 = applied.iter().map(|a| a.rows).sum();
    record_write_history(
        &session,
        history_text(&statements),
        prepared.exec_db.as_deref(),
        Some(total as i64),
        Some(started.elapsed().as_millis() as i64),
        None,
    )
    .await;
    session.query_cache.invalidate_all().await;

    // Undo の記録 (親が先の順で保存するので、バッチの取り消しは子から消える)。フライトレコーダーの
    // 設定がオフ (`capture` なし) か履歴を残さない接続なら記録しない。行数が上限を超えるときは
    // 一部だけを記録すると取り消しが不完全になるので、全体を辞退する。
    let capture_cfg = capture.filter(|_| !session.skip_history);
    let capture_enabled = capture_cfg.is_some();
    let batch_id = new_batch_id();
    let (mut recorded, mut declined_tables) = (0u32, Vec::<String>::new());
    if let Some(cfg) = &capture_cfg {
        let row_cap = cfg
            .row_cap
            .map_or(crate::db::DEFAULT_CAPTURE_ROW_CAP as u64, u64::from);
        // 主キーのない表が 1 つでもあれば、一部の表だけの Undo は不完全なので全体を辞退する。
        if total > row_cap || applied.iter().any(|a| a.rows > 0 && a.after_rows.is_none()) {
            declined_tables = prepared
                .tables
                .iter()
                .map(|t| t.meta.name.clone())
                .collect();
        } else {
            for (ct, a) in prepared.tables.iter().zip(applied.iter()) {
                let Some(after) = &a.after_rows else {
                    declined_tables.push(ct.meta.name.clone());
                    continue;
                };
                let capture = WriteCapture {
                    kind: WriteKind::Insert,
                    capturable: true,
                    reason: None,
                    table: Some(ct.meta.name.clone()),
                    primary_key: ct.meta.primary_key.clone(),
                    columns: ct.meta.columns.clone(),
                    column_types: ct.meta.column_types.clone(),
                    before_rows: Vec::new(),
                    after_rows: after.clone(),
                    rows_affected: after.len() as u64,
                    companion: None,
                };
                let saved = persist_capture(
                    session.skip_history,
                    session.profile_id.clone(),
                    session.conn.driver_kind(),
                    prepared.exec_db.clone(),
                    format!(
                        "-- clone rows (#2304): {} ({} row(s))",
                        ct.meta.name,
                        after.len()
                    ),
                    &capture,
                    cfg.retention_days.map(i64::from),
                    Some(batch_id.clone()),
                )
                .await;
                if saved.is_some() {
                    recorded += 1;
                } else {
                    declined_tables.push(ct.meta.name.clone());
                }
            }
        }
    }
    let declined = declined_tables.len() as u32;

    let root_table = prepared.root_table.clone();
    let root_applied = prepared
        .tables
        .iter()
        .zip(applied.iter())
        .find(|(t, _)| t.meta.name == root_table);
    let root_key_columns = root_applied
        .map(|(t, _)| t.meta.primary_key.clone())
        .unwrap_or_default();
    let root_new_keys = root_applied
        .map(|(_, a)| {
            a.mappings
                .iter()
                .filter(|m| m.root)
                .map(|m| m.new_key.clone())
                .collect()
        })
        .unwrap_or_default();
    let tables = prepared
        .tables
        .iter()
        .zip(applied)
        .map(|(t, a)| CloneTableOutcome {
            table: t.meta.name.clone(),
            rows: a.rows,
            key_columns: t.meta.primary_key.clone(),
            mappings: a.mappings,
        })
        .collect();
    Ok(CloneRowsOutcome {
        tables,
        total_rows: total,
        root_table,
        root_key_columns,
        root_new_keys,
        recorded,
        declined,
        declined_tables,
        capture_enabled,
        batch_id: (recorded > 0).then_some(batch_id),
        warnings: prepared.collected.result.warnings.clone(),
    })
}

/// 行を子レコードごと同じ DB 内に複製する (#2304)。1 トランザクションで、失敗したら全部ロールバック。
/// `read_only` 接続はバックエンドが拒否する。`is_production` / `confirm_writes` は UI の確認。
#[tauri::command]
pub async fn clone_rows(
    request: SubsetRequest,
    rules: Vec<CloneColumnRule>,
    capture: Option<BulkCaptureConfig>,
    state: State<'_, AppState>,
) -> Result<CloneRowsOutcome> {
    clone_rows_inner(&state, request, rules, capture).await
}
