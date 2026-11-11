//! サブセット抽出 (#2241) — 外部キーを行単位で辿り、参照整合性を保ったまま一部の行だけを
//! 取り出して、別の接続への書き込み / INSERT スクリプトとして出力する。
//!
//! 計画 (どの行をどの順で取るか) は純粋層 `db::subset` が持つ。このモジュールはそれを
//! 実 DB で駆動する薄い層で、新しい書き込み経路は増やさない。
//!
//! - **取得は読み取り専用。** 起点の条件は `db::sandbox::checked_row_filter` で検査し、
//!   組み立てた `SELECT` はすべて `is_read_only_sql_for` に通してから実行する。
//! - **別の接続へ書く**ときは既存のインポート経路 (`Connection::import_rows_with_binary`)
//!   だけを使い、転送先が読み取り専用なら (緊急書き込みモードでも) 転送と同じく
//!   バックエンドで拒否する (`ensure_transfer_target_writable`)。`is_production` /
//!   `confirm_writes` の確認は UI レベル (`SubsetExtractModal`) の責務。書き込みは親の表が先の
//!   順なので、途中で止めても外部キー違反の行は残らない (入った行は親から順に完結している)。
//! - **INSERT スクリプト**は既存のエクスポートの SQL レンダラ (`write_export_to`) を使う。
//! - **マスキング**は `db::masking` を出力の直前にだけ掛ける (取得・辿りには影響しない)。
//!   外部キー / 主キーの列は参照が壊れるのでマスクできない (`check_mask_targets`)。
//! - 進捗は `subset-stream:*` イベント、`cancel_stream` で中断できる。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::diff::select_rows_where_sql;
use crate::commands::export::{
    load_mask_spec, write_export_to, ExportFormat, SqlConflict, SqlConflictMode, SqlExportOpts,
};
use crate::commands::progress::{needs_final_emit, ProgressThrottle};
use crate::commands::query::record_write_history;
use crate::commands::transfer::ensure_transfer_target_writable;
use crate::db::masking::{ColumnMask, MaskPlan, MaskRule};
use crate::db::sandbox::checked_row_filter;
use crate::db::subset::{
    check_mask_targets, clamp_child_depth, clamp_child_row_limit, clamp_root_row_limit,
    exclude_cross_database_groups, group_foreign_keys, reachable_tables, resolve_edges,
    select_by_keys_sql, SubsetEdge, SubsetOptions, SubsetResult, SubsetTable, SubsetWalk,
    SubsetWarning, MAX_TOTAL_ROWS,
};
use crate::db::sync::{quote_ident, table_ref_for};
use crate::db::transfer::{
    check_sqlite_unsigned_range, hex_binary_columns, plan_columns_mapped, value_to_cell,
};
use crate::db::types::{Column, Value};
use crate::db::upsert::{ConflictMode, ImportConflict};
use crate::db::{is_read_only_sql_for, Connection, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

pub(crate) const EV_SUBSET_PROGRESS: &str = "subset-stream:progress";
pub(crate) const EV_SUBSET_DONE: &str = "subset-stream:done";
pub(crate) const EV_SUBSET_ERROR: &str = "subset-stream:error";

/// 書き込みの 1 回あたりの行数。
const WRITE_BATCH: usize = 1000;

/// 起点と辿り方の指定。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsetRequest {
    pub source_session_id: String,
    #[serde(default)]
    pub source_database: Option<String>,
    /// 起点の表。
    pub table: String,
    /// 起点の行の条件 (`WHERE` の中身)。読み取り専用の条件だけ許す。空は全行 (上限まで)。
    #[serde(default)]
    pub where_clause: Option<String>,
    /// 起点の行数の上限。省略は既定値。
    #[serde(default)]
    pub root_row_limit: Option<u64>,
    /// 子の方向へ辿る段数。省略 / 0 は子を辿らない。
    #[serde(default)]
    pub child_depth: Option<u32>,
    /// 子の方向で、表ごとに足す行数の上限。省略は既定値。
    #[serde(default)]
    pub child_row_limit: Option<u64>,
}

/// 転送先に同じ主キーの行があるときの扱い。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExistingRows {
    /// 既存の行は読み飛ばす (既定)。親の行が転送先に既にあるのが普通なので。
    #[default]
    Skip,
    /// 素の INSERT。衝突したらエラー。
    Fail,
}

/// 出力先。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubsetOutput {
    /// 別の接続 (転送先の表は既に存在すること)。
    #[serde(rename_all = "camelCase")]
    Transfer {
        target_session_id: String,
        #[serde(default)]
        target_database: Option<String>,
        #[serde(default)]
        existing: ExistingRows,
    },
    /// INSERT スクリプトをファイルへ保存する (ソースと同じドライバの方言)。
    #[serde(rename_all = "camelCase")]
    Script {
        path: String,
        #[serde(default)]
        existing: ExistingRows,
    },
}

/// 出力に掛けるマスキング (表と列の組)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsetColumnMask {
    pub table: String,
    pub column: String,
    pub rule: MaskRule,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubsetColumnInfo {
    pub name: String,
    /// 主キー / 外部キーの列か (マスクできない)。
    pub key: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubsetTablePreview {
    pub table: String,
    pub rows: u64,
    pub root_rows: u64,
    pub child_rows: u64,
    pub parent_rows: u64,
    pub columns: Vec<SubsetColumnInfo>,
}

/// 実行前のプレビュー: 表ごとの抽出件数 (親が先の順)・循環・上限超過。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubsetPreview {
    pub tables: Vec<SubsetTablePreview>,
    pub total_rows: u64,
    pub cycles: Vec<Vec<String>>,
    pub warnings: Vec<SubsetWarning>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubsetTableCount {
    pub table: String,
    pub rows: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsetProgressEvent {
    pub stream_id: String,
    /// `collect` (行を集めている) / `write` (出力している)。
    pub phase: String,
    pub rows: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsetDoneEvent {
    pub stream_id: String,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub tables: Vec<SubsetTableCount>,
    pub warnings: Vec<SubsetWarning>,
    /// スクリプトを書き出したときのパス。
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsetErrorEvent {
    pub stream_id: String,
    pub message: String,
    pub rows: u64,
}

/// 集めた行と、その計画に使ったメタデータ。
pub(crate) struct Collected {
    pub result: SubsetResult,
    pub tables: BTreeMap<String, SubsetTable>,
    pub edges: Vec<SubsetEdge>,
}

/// カタログの照会に使う DB 名 (SQLite は空 = main)。
async fn catalog_db(conn: &Connection, database: Option<&str>) -> String {
    conn.resolve_database(database).await
}

/// 抽出対象の表のメタデータ (生成列は取得・出力から外す)。`required` の表に列が無ければ
/// エラー。それ以外 (外部キーで辿り着いた別スキーマ / 別 DB の表など) は取れないだけなので、
/// 戻りの 2 つ目に名前を返して続行する。
pub(crate) async fn load_subset_tables(
    conn: &Connection,
    db: &str,
    names: impl IntoIterator<Item = String>,
    required: &str,
) -> Result<(BTreeMap<String, SubsetTable>, Vec<String>)> {
    let mut out = BTreeMap::new();
    let mut missing = Vec::new();
    for name in names {
        let cols = conn.columns(db, &name).await?;
        if cols.is_empty() && name != required {
            missing.push(name);
            continue;
        }
        if cols.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "table '{name}' has no columns (does it exist on the source?)"
            )));
        }
        let primary_key: Vec<String> = cols
            .iter()
            .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
            .map(|c| c.name.clone())
            .collect();
        let kept: Vec<_> = cols.iter().filter(|c| !c.is_generated()).collect();
        out.insert(
            name.clone(),
            SubsetTable {
                name,
                columns: kept.iter().map(|c| c.name.clone()).collect(),
                column_types: kept.iter().map(|c| c.data_type.clone()).collect(),
                primary_key,
            },
        );
    }
    Ok((out, missing))
}

/// 計画を最後まで実行する (取得は読み取り専用)。`on_rows` へ集めた行の総数を通知する。
pub(crate) async fn run_walk(
    session: &Session,
    attached_db: &str,
    exec_db: Option<&str>,
    tables: &BTreeMap<String, SubsetTable>,
    walk: &mut SubsetWalk,
    mut on_rows: impl FnMut(u64),
) -> Result<()> {
    let conn = &session.conn;
    let driver = conn.driver_kind();
    while let Some(req) = walk.next_request() {
        let meta = tables
            .get(&req.table)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown table '{}'", req.table)))?;
        let sql = select_by_keys_sql(
            driver,
            &table_ref_for(driver, attached_db, &req.table),
            meta,
            &req.key_columns,
            &req.keys,
            req.limit,
        )?;
        // 取得は必ず読み取り専用。組み立てを誤っても書き込み文を流さない。
        if !is_read_only_sql_for(driver, &sql) {
            return Err(AppError::ReadOnly(
                "subset extraction only issues read-only statements".into(),
            ));
        }
        let res = conn.execute(&sql, exec_db).await?;
        walk.supply(&req, res.rows)?;
        on_rows(walk.total_rows());
    }
    Ok(())
}

/// 起点の行を読む `SELECT` を実行する。戻りは (行, 上限で打ち切ったか)。
pub(crate) async fn fetch_root_rows(
    session: &Session,
    attached_db: &str,
    exec_db: Option<&str>,
    meta: &SubsetTable,
    filter: Option<&str>,
    limit: u64,
) -> Result<(Vec<Vec<Value>>, bool)> {
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let sql = select_rows_where_sql(
        driver,
        attached_db,
        &meta.name,
        &meta.columns,
        &meta.primary_key,
        limit as usize + 1,
        filter,
    );
    if !is_read_only_sql_for(driver, &sql) {
        return Err(AppError::ReadOnly(
            "the start condition must keep the statement read-only".into(),
        ));
    }
    let res = conn.execute(&sql, exec_db).await?;
    let truncated = res.rows.len() as u64 > limit;
    let rows = res.rows.into_iter().take(limit as usize).collect();
    Ok((rows, truncated))
}

/// 起点から行を集める。
pub(crate) async fn collect_subset(
    source: &Session,
    req: &SubsetRequest,
    on_rows: impl FnMut(u64),
) -> Result<Collected> {
    let driver = source.conn.driver_kind();
    let table = req.table.trim().to_string();
    if table.is_empty() {
        return Err(AppError::InvalidInput("choose a start table".into()));
    }
    let filter = checked_row_filter(driver, &table, req.where_clause.as_deref())
        .map_err(AppError::InvalidInput)?;
    let root_limit = clamp_root_row_limit(req.root_row_limit);
    let child_depth = clamp_child_depth(req.child_depth);
    let child_limit = clamp_child_row_limit(req.child_row_limit);

    let exec_db = req.source_database.as_deref().filter(|d| !d.is_empty());
    let attached = source
        .conn
        .resolve_attached_database(req.source_database.as_deref().unwrap_or_default());
    let db = catalog_db(&source.conn, req.source_database.as_deref()).await;

    let fks = source.conn.foreign_keys(&db).await?;
    let cross: BTreeSet<(String, String)> = source
        .conn
        .cross_database_foreign_keys(&db)
        .await?
        .into_iter()
        .collect();
    // 別 DB の表を指す外部キーは、同名の表があっても辿らない (警告にする)。
    let (groups, cross_warnings) = exclude_cross_database_groups(group_foreign_keys(&fks), &cross);
    let names = reachable_tables(std::slice::from_ref(&table), &groups, child_depth);
    let (tables, missing) = load_subset_tables(&source.conn, &db, names, &table).await?;
    let (edges, mut edge_warnings) = resolve_edges(&groups, &tables);
    edge_warnings.extend(cross_warnings);
    // 別スキーマ / 別 DB の表を指す外部キーは辿れない。全体を失敗させず警告にして続ける。
    for g in &groups {
        let touches_missing = (missing.contains(&g.parent) && tables.contains_key(&g.child))
            || (missing.contains(&g.child) && tables.contains_key(&g.parent));
        if touches_missing {
            edge_warnings.push(SubsetWarning::UnresolvedForeignKey {
                table: g.child.clone(),
                constraint: g.constraint.clone(),
            });
        }
    }

    let mut walk = SubsetWalk::new(
        tables.clone(),
        edges.clone(),
        SubsetOptions {
            child_depth,
            child_row_limit: child_limit,
            max_total_rows: MAX_TOTAL_ROWS,
        },
    );
    for w in edge_warnings {
        walk.push_warning(w);
    }
    let meta = tables
        .get(&table)
        .ok_or_else(|| AppError::InvalidInput(format!("table '{table}' not found")))?;
    let (rows, truncated) = fetch_root_rows(
        source,
        &attached,
        exec_db,
        meta,
        filter.as_deref(),
        root_limit,
    )
    .await?;
    if truncated {
        walk.push_warning(SubsetWarning::RootTruncated {
            table: table.clone(),
            limit: root_limit,
        });
    }
    walk.add_root_rows(&table, rows)?;
    run_walk(source, &attached, exec_db, &tables, &mut walk, on_rows).await?;
    Ok(Collected {
        result: walk.finish(),
        tables,
        edges,
    })
}

fn preview_of(c: &Collected) -> SubsetPreview {
    let tables = c
        .result
        .tables
        .iter()
        .map(|t| {
            let key_of = |name: &str| {
                t.primary_key.iter().any(|k| k == name)
                    || c.edges.iter().any(|e| {
                        (e.child == t.table && e.child_cols.iter().any(|x| x == name))
                            || (e.parent == t.table && e.parent_cols.iter().any(|x| x == name))
                    })
            };
            SubsetTablePreview {
                table: t.table.clone(),
                rows: t.rows.len() as u64,
                root_rows: t.root_rows,
                child_rows: t.child_rows,
                parent_rows: t.parent_rows,
                columns: t
                    .columns
                    .iter()
                    .map(|n| SubsetColumnInfo {
                        name: n.clone(),
                        key: key_of(n),
                    })
                    .collect(),
            }
        })
        .collect();
    SubsetPreview {
        tables,
        total_rows: c.result.total_rows(),
        cycles: c.result.cycles.clone(),
        warnings: c.result.warnings.clone(),
    }
}

/// 実行せずに、表ごとの抽出件数・循環・上限超過を返す (行は読むが何も書かない)。
pub async fn preview_subset_inner(state: &AppState, req: SubsetRequest) -> Result<SubsetPreview> {
    let source = state
        .get(&req.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(req.source_session_id.clone()))?;
    let collected = collect_subset(&source, &req, |_| {}).await?;
    Ok(preview_of(&collected))
}

/// 抽出の実行前プレビュー (#2241)。書き込みはしない。
#[tauri::command]
pub async fn preview_subset(
    request: SubsetRequest,
    state: State<'_, AppState>,
) -> Result<SubsetPreview> {
    preview_subset_inner(&state, request).await
}

/// 表ごとのマスク計画。列は出力列の並び。
async fn build_mask_plans(
    masks: &[SubsetColumnMask],
    collected: &Collected,
) -> Result<BTreeMap<String, MaskPlan>> {
    let pairs: Vec<(String, String)> = masks
        .iter()
        .map(|m| (m.table.clone(), m.column.clone()))
        .collect();
    check_mask_targets(&pairs, &collected.tables, &collected.edges)?;
    let mut by_table: BTreeMap<String, Vec<ColumnMask>> = BTreeMap::new();
    for m in masks {
        by_table
            .entry(m.table.clone())
            .or_default()
            .push(ColumnMask {
                column: m.column.clone(),
                rule: m.rule.clone(),
            });
    }
    let mut plans = BTreeMap::new();
    for (table, cms) in by_table {
        let Some(spec) = load_mask_spec(Some(cms)).await? else {
            continue;
        };
        let spec = spec.strict();
        let Some(t) = collected.result.tables.iter().find(|t| t.table == table) else {
            // この抽出で行の無い表のマスクは何もしない。
            continue;
        };
        let columns = output_columns(t);
        spec.check_columns(&columns)?;
        plans.insert(table, spec.plan(&columns));
    }
    Ok(plans)
}

fn output_columns(t: &crate::db::subset::SubsetTableRows) -> Vec<Column> {
    t.columns
        .iter()
        .zip(t.column_types.iter())
        .map(|(n, ty)| Column {
            name: n.clone(),
            type_name: ty.clone(),
        })
        .collect()
}

fn masked_rows(plan: Option<&MaskPlan>, rows: &[Vec<Value>]) -> Vec<Vec<Value>> {
    match plan {
        Some(p) => p.apply_rows(rows).into_owned(),
        None => rows.to_vec(),
    }
}

/// INSERT スクリプトの本文を組み立てる。
fn render_script(
    driver: DriverKind,
    collected: &Collected,
    plans: &BTreeMap<String, MaskPlan>,
    existing: ExistingRows,
) -> Result<String> {
    let mut out = String::new();
    out.push_str("-- noobDB subset extract\n");
    for t in &collected.result.tables {
        out.push_str(&format!(
            "-- {}: {} row(s)\n",
            comment_safe(&t.table),
            t.rows.len()
        ));
    }
    for w in &collected.result.warnings {
        if let SubsetWarning::Cycle { tables } = w {
            out.push_str(&format!(
                "-- WARNING: foreign keys form a cycle among: {}\n",
                tables
                    .iter()
                    .map(|t| comment_safe(t))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    let has_cycle = !collected.result.cycles.is_empty();
    if has_cycle {
        out.push_str("-- Insert order cannot satisfy every foreign key; defer or disable FK checks while loading.\n");
        match driver {
            DriverKind::Mysql => out.push_str("SET FOREIGN_KEY_CHECKS=0;\n"),
            DriverKind::Sqlite => out.push_str("PRAGMA foreign_keys=OFF;\n"),
            DriverKind::Postgres => {
                out.push_str("-- PostgreSQL: use DEFERRABLE constraints with SET CONSTRAINTS ALL DEFERRED inside a transaction.\n");
            }
        }
    }
    out.push('\n');
    for t in &collected.result.tables {
        let columns = output_columns(t);
        let conflict = if existing == ExistingRows::Skip && !t.primary_key.is_empty() {
            Some(SqlConflict {
                mode: SqlConflictMode::Skip,
                key_columns: t.primary_key.clone(),
            })
        } else {
            None
        };
        let opts =
            SqlExportOpts::build(Some(driver), Some(t.table.clone()), None).with_conflict(conflict);
        out.push_str(&format!(
            "-- {}\n",
            comment_safe(&quote_ident(driver, &t.table))
        ));
        let mut buf: Vec<u8> = Vec::new();
        write_export_to(
            &mut buf,
            ExportFormat::Sql,
            &columns,
            &t.rows,
            None,
            &opts,
            plans.get(&t.table),
        )?;
        out.push_str(&String::from_utf8_lossy(&buf));
        out.push('\n');
    }
    if has_cycle {
        match driver {
            DriverKind::Mysql => out.push_str("SET FOREIGN_KEY_CHECKS=1;\n"),
            DriverKind::Sqlite => out.push_str("PRAGMA foreign_keys=ON;\n"),
            DriverKind::Postgres => {}
        }
    }
    Ok(out)
}

/// 転送元と転送先が同じデータベースかどうか。セッション ID が違っても、同じプロファイル
/// (または同じ接続先) の同じデータベースなら同一とみなす (自分自身への書き込みを防ぐ)。
fn same_database(
    a: (
        &str,
        Option<&str>,
        &crate::db::DbConnectOptions,
        Option<&str>,
    ),
    b: (
        &str,
        Option<&str>,
        &crate::db::DbConnectOptions,
        Option<&str>,
    ),
) -> bool {
    let (a_id, a_profile, a_opts, a_db) = a;
    let (b_id, b_profile, b_opts, b_db) = b;
    let same_endpoint = a_id == b_id
        || matches!((a_profile, b_profile), (Some(x), Some(y)) if x == y)
        || (a_opts.driver == b_opts.driver
            && a_opts.host == b_opts.host
            && a_opts.port == b_opts.port
            && a_opts.user == b_opts.user
            && a_opts.file_path == b_opts.file_path);
    if !same_endpoint {
        return false;
    }
    let eff = |db: Option<&str>, o: &crate::db::DbConnectOptions| -> String {
        db.filter(|d| !d.is_empty())
            .map(str::to_string)
            .or_else(|| o.database.clone())
            .unwrap_or_default()
    };
    eff(a_db, a_opts) == eff(b_db, b_opts)
}

/// SQL コメント (`-- ...`) に出す名前から制御文字を取り除く。改行を含む表名でコメントを
/// 抜け出して任意の文を差し込まれないようにする。
fn comment_safe(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// 別の接続へ書き込む。書き込み前に、転送先の表・列がすべて揃っていることを確かめる。
async fn write_to_target(
    target: &Session,
    target_database: Option<&str>,
    existing: ExistingRows,
    collected: &Collected,
    plans: &BTreeMap<String, MaskPlan>,
    mut on_progress: impl FnMut(u64),
) -> Result<u64> {
    ensure_transfer_target_writable(target)?;
    let tdb = target_database.filter(|d| !d.is_empty());
    let driver = target.conn.driver_kind();
    let cdb = {
        let r = target.conn.resolve_database(tdb).await;
        if r.is_empty() {
            "main".to_string()
        } else {
            r
        }
    };
    // 書き込み前に全表の列を検査する (途中で足りない表が見つかって中途半端に書かない)。
    for t in &collected.result.tables {
        let cols = target.conn.columns(&cdb, &t.table).await?;
        if cols.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "target table '{}' does not exist; create the tables on the target first",
                t.table
            )));
        }
        if let Some(missing) = t
            .columns
            .iter()
            .find(|c| !cols.iter().any(|x| &x.name == *c))
        {
            return Err(AppError::InvalidInput(format!(
                "target table '{}' has no column '{missing}'",
                t.table
            )));
        }
    }

    let mut written: u64 = 0;
    for t in &collected.result.tables {
        let columns = output_columns(t);
        let rows = masked_rows(plans.get(&t.table), &t.rows);
        let (plan, _) = plan_columns_mapped(&columns, &rows, &[])?;
        check_sqlite_unsigned_range(driver, &plan, &rows)?;
        let names: Vec<String> = plan.iter().map(|c| c.name.clone()).collect();
        let hex = hex_binary_columns(driver, &plan);
        let conflict = if existing == ExistingRows::Skip && !t.primary_key.is_empty() {
            ImportConflict {
                mode: ConflictMode::Skip,
                key_columns: t.primary_key.clone(),
            }
        } else {
            ImportConflict::insert_only()
        };
        conflict.validate(&names)?;
        target
            .conn
            .check_upsert_keys(tdb, &t.table, &names, &conflict)
            .await?;
        for chunk in rows.chunks(WRITE_BATCH) {
            let cells: Vec<Vec<Option<String>>> = chunk
                .iter()
                .map(|row| {
                    plan.iter()
                        .enumerate()
                        .map(|(i, c)| row.get(i).and_then(|v| value_to_cell(driver, &c.ty, v)))
                        .collect()
                })
                .collect();
            target
                .conn
                .import_rows_with_binary(
                    tdb,
                    &t.table,
                    &names,
                    &cells,
                    WRITE_BATCH,
                    &conflict,
                    &hex,
                    |_| Ok(()),
                )
                .await?;
            written += chunk.len() as u64;
            on_progress(written);
        }
    }
    Ok(written)
}

/// 実行の結果。
pub struct SubsetOutcome {
    pub rows: u64,
    pub tables: Vec<SubsetTableCount>,
    pub warnings: Vec<SubsetWarning>,
    pub path: Option<String>,
}

/// Tauri を介さずに抽出と出力を最後まで実行するコア (統合テスト用)。`on_progress` は
/// (フェーズ, 行数)。`counter` は進捗の行数 (キャンセル時に `cancel_stream` が読む)。
pub async fn run_subset_inner(
    state: &AppState,
    req: SubsetRequest,
    output: SubsetOutput,
    masks: Vec<SubsetColumnMask>,
    counter: Arc<AtomicU64>,
    mut on_progress: impl FnMut(&'static str, u64),
) -> Result<SubsetOutcome> {
    let source = state
        .get(&req.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(req.source_session_id.clone()))?;
    // 出力先の検査は、行を読む前に済ませる。
    let target = match &output {
        SubsetOutput::Transfer {
            target_session_id, ..
        } => {
            let t = state
                .get(target_session_id)
                .await
                .ok_or_else(|| AppError::SessionNotFound(target_session_id.clone()))?;
            ensure_transfer_target_writable(&t)?;
            Some(t)
        }
        SubsetOutput::Script { path, .. } => {
            if path.trim().is_empty() {
                return Err(AppError::InvalidInput("save path is empty".into()));
            }
            None
        }
    };
    let counter_c = counter.clone();
    let collected = {
        let mut cb = |n: u64| {
            counter_c.store(n, Ordering::SeqCst);
            on_progress("collect", n);
        };
        collect_subset(&source, &req, &mut cb).await?
    };
    if collected.result.total_rows() == 0 {
        return Err(AppError::InvalidInput(
            "no rows matched the start condition".into(),
        ));
    }
    let plans = build_mask_plans(&masks, &collected).await?;
    let counts: Vec<SubsetTableCount> = collected
        .result
        .tables
        .iter()
        .map(|t| SubsetTableCount {
            table: t.table.clone(),
            rows: t.rows.len() as u64,
        })
        .collect();
    let warnings = collected.result.warnings.clone();
    counter.store(0, Ordering::SeqCst);
    match output {
        SubsetOutput::Transfer {
            target_database,
            existing,
            ..
        } => {
            let Some(target) = target else {
                return Err(AppError::Other("target session missing".into()));
            };
            ensure_transfer_target_writable(&target)?;
            if same_database(
                (
                    &source.id,
                    source.profile_id.as_deref(),
                    &source.connect_options,
                    req.source_database.as_deref(),
                ),
                (
                    &target.id,
                    target.profile_id.as_deref(),
                    &target.connect_options,
                    target_database.as_deref().filter(|d| !d.is_empty()),
                ),
            ) {
                return Err(AppError::InvalidInput(
                    "source and target are the same database".into(),
                ));
            }
            let started = Instant::now();
            let result = write_to_target(
                &target,
                target_database.as_deref(),
                existing,
                &collected,
                &plans,
                |n| {
                    counter.store(n, Ordering::SeqCst);
                    on_progress("write", n);
                },
            )
            .await;
            // 書き込みは複数の表にまたがるので、成功・失敗に関わらずキャッシュを捨てる。
            target.schema_cache.invalidate_all().await;
            target.query_cache.invalidate_all().await;
            let summary = format!(
                "-- subset transfer from session {} (table {}, {} tables)",
                req.source_session_id,
                comment_safe(&req.table),
                counts.len()
            );
            let elapsed = started.elapsed().as_millis() as i64;
            match &result {
                Ok(n) => {
                    record_write_history(
                        &target,
                        summary,
                        target_database.as_deref(),
                        Some(*n as i64),
                        Some(elapsed),
                        None,
                    )
                    .await
                }
                Err(e) => {
                    record_write_history(
                        &target,
                        summary,
                        target_database.as_deref(),
                        None,
                        None,
                        Some(e.to_string()),
                    )
                    .await
                }
            }
            let rows = result?;
            Ok(SubsetOutcome {
                rows,
                tables: counts,
                warnings,
                path: None,
            })
        }
        SubsetOutput::Script { path, existing } => {
            let driver = source.conn.driver_kind();
            let text = render_script(driver, &collected, &plans, existing)?;
            crate::commands::export::write_file_atomically(path.clone(), text.into_bytes()).await?;
            let rows = collected.result.total_rows();
            counter.store(rows, Ordering::SeqCst);
            on_progress("write", rows);
            Ok(SubsetOutcome {
                rows,
                tables: counts,
                warnings,
                path: Some(path),
            })
        }
    }
}

/// 抽出して出力する (#2241)。進捗は `subset-stream:*` イベントで通知し、`cancel_stream` で
/// 中断できる。入力・出力先のガードのエラーは戻り値として即座に返す。
#[tauri::command]
pub async fn run_subset(
    app: AppHandle,
    stream_id: String,
    request: SubsetRequest,
    output: SubsetOutput,
    masks: Vec<SubsetColumnMask>,
    state: State<'_, AppState>,
) -> Result<()> {
    // 早い段階で弾けるものはここで弾く (読み取り専用の転送先・存在しないセッション)。
    state
        .get(&request.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.source_session_id.clone()))?;
    if let SubsetOutput::Transfer {
        target_session_id, ..
    } = &output
    {
        let t = state
            .get(target_session_id)
            .await
            .ok_or_else(|| AppError::SessionNotFound(target_session_id.clone()))?;
        ensure_transfer_target_writable(&t)?;
    }
    let counter = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let counter_for_task = counter.clone();
    let app_for_task = app.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        let Some(state) = app_for_task.try_state::<AppState>() else {
            return;
        };
        let started = Instant::now();
        let emitted = Arc::new(AtomicU64::new(0));
        let emitted_cb = emitted.clone();
        let mut throttle = ProgressThrottle::standard();
        let emit_app = app_for_task.clone();
        let emit_id = stream_id_for_task.clone();
        let result = run_subset_inner(
            state.inner(),
            request,
            output,
            masks,
            counter_for_task.clone(),
            move |phase, rows| {
                if !throttle.ready() {
                    return;
                }
                emitted_cb.store(rows, Ordering::SeqCst);
                let _ = emit_app.emit(
                    EV_SUBSET_PROGRESS,
                    SubsetProgressEvent {
                        stream_id: emit_id.clone(),
                        phase: phase.to_string(),
                        rows,
                    },
                );
            },
        )
        .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(o) => {
                if needs_final_emit(emitted.load(Ordering::SeqCst), o.rows) {
                    let _ = app_for_task.emit(
                        EV_SUBSET_PROGRESS,
                        SubsetProgressEvent {
                            stream_id: stream_id_for_task.clone(),
                            phase: "write".into(),
                            rows: o.rows,
                        },
                    );
                }
                tracing::info!(stream_id = %stream_id_for_task, rows = o.rows, "subset extract complete");
                let _ = app_for_task.emit(
                    EV_SUBSET_DONE,
                    SubsetDoneEvent {
                        stream_id: stream_id_for_task.clone(),
                        rows: o.rows,
                        elapsed_ms,
                        tables: o.tables,
                        warnings: o.warnings,
                        path: o.path,
                    },
                );
            }
            Err(e) => {
                tracing::error!(stream_id = %stream_id_for_task, error = %e, "subset extract failed");
                let _ = app_for_task.emit(
                    EV_SUBSET_ERROR,
                    SubsetErrorEvent {
                        stream_id: stream_id_for_task.clone(),
                        message: e.to_string(),
                        rows: counter_for_task.load(Ordering::SeqCst),
                    },
                );
            }
        }
        state.forget_stream(&stream_id_for_task, token).await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: counter,
                kind: StreamKind::Subset,
                on_cancel: None,
            },
        )
        .await;
    let _ = ready_tx.send(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbConnectOptions;

    fn opts(host: &str, db: Option<&str>) -> DbConnectOptions {
        DbConnectOptions {
            host: host.into(),
            port: 3306,
            user: "u".into(),
            password: String::new(),
            database: db.map(str::to_string),
            driver: DriverKind::Mysql,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
            aws_iam: None,
            sqlite_attachments: Vec::new(),
            read_only: false,
        }
    }

    #[test]
    fn comment_safe_replaces_line_breaks() {
        let name = "t\nDROP TABLE x; --\r";
        let safe = comment_safe(name);
        assert!(!safe.contains('\n') && !safe.contains('\r'));
        assert!(safe.contains("DROP TABLE x"));
    }

    #[test]
    fn same_database_detects_other_session_of_same_profile() {
        let o = opts("h1", Some("a"));
        assert!(same_database(
            ("s1", Some("p"), &o, None),
            ("s2", Some("p"), &o, None)
        ));
        // 同じ接続先でもデータベースが違えば別。
        assert!(!same_database(
            ("s1", Some("p"), &o, None),
            ("s2", Some("p"), &o, Some("b"))
        ));
        // 別プロファイル・別ホストは別。
        let o2 = opts("h2", Some("a"));
        assert!(!same_database(
            ("s1", Some("p"), &o, None),
            ("s2", Some("q"), &o2, None)
        ));
        // プロファイルが違っても同じ接続先の同じ DB なら同一。
        assert!(same_database(
            ("s1", Some("p"), &o, None),
            ("s2", Some("q"), &o, Some("a"))
        ));
    }
}
