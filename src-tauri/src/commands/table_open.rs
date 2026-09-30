//! テーブルを開く処理の IPC 集約 (#1263)。
//!
//! 以前はフロント (`resolveTableOpen`) が `describe_table` → (PK 無しなら)
//! `table_row_identity` → 初回 SELECT の組み立て → `table_row_estimates`
//! (DB 全体) を直列に呼んでいた。ここでは列・行識別・行数推定を Rust 内で
//! 並行取得し、初回 SELECT の SQL も Rust の識別子クオートで組み立てて
//! 1 IPC で返す。ストリーム実行 (`run_query_stream`) 自体は既存経路のまま。

use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use tauri::State;

use crate::db::sync::quote_ident;
use crate::db::types::{TableColumnInfo, TableRowIdentity};
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session};

/// 行数推定は装飾的な付随情報。最初の行が出るまでの時間を延ばさないよう、
/// 列の取得より極端に遅いときは待たずに `None` で返す。
const ESTIMATE_TIMEOUT: Duration = Duration::from_millis(1500);
/// 復元時に同時に開くテーブル数の上限。
const OPEN_CONCURRENCY: usize = 8;

/// テーブルを開いた結果。
#[derive(Debug, Clone, Serialize)]
pub struct OpenTableResult {
    /// ページネーションの土台になる `SELECT *[, rowid|ctid] FROM ...` (LIMIT なし)。
    pub base: String,
    /// 初回実行する SQL (`base` + ` LIMIT <limit>`)。
    pub sql: String,
    pub columns: Vec<TableColumnInfo>,
    /// PK が解決できないときだけ取得する行識別フォールバック。取得失敗も `None`。
    pub row_identity: Option<TableRowIdentity>,
    /// 行数推定。`with_estimate` が偽・未対応・統計なし・タイムアウトは `None`。
    pub row_estimate: Option<i64>,
}

/// `open_tables` の 1 件分。`result` と `error` はどちらか一方だけが入る。
#[derive(Debug, Clone, Serialize)]
pub struct OpenTableEntry {
    pub database: String,
    pub table: String,
    pub result: Option<OpenTableResult>,
    pub error: Option<String>,
}

/// テーブルを開くときの初回 `SELECT` (LIMIT なし) を組み立てる。
///
/// `hidden_column` は PK の無いテーブルで行を特定するための疑似列
/// (SQLite `rowid` / PostgreSQL `ctid`) で、結果列として返るよう末尾に足す。
/// SQLite は名前空間が 1 つなので DB 修飾を付けない。フロントの
/// `qualifiedTableSql` (`sqlDialect.ts`) と同一の SQL を返す
/// (`src/__tests__/fixtures/tableSelectSql.json` の共有ゴールデンで固定)。
pub fn table_select_sql(
    driver: DriverKind,
    database: &str,
    table: &str,
    hidden_column: Option<&str>,
) -> String {
    let extra = match hidden_column {
        Some(c) if !c.is_empty() => format!(", {c}"),
        _ => String::new(),
    };
    match driver {
        DriverKind::Sqlite => format!("SELECT *{extra} FROM {}", quote_ident(driver, table)),
        DriverKind::Mysql | DriverKind::Postgres => format!(
            "SELECT *{extra} FROM {}.{}",
            quote_ident(driver, database),
            quote_ident(driver, table)
        ),
    }
}

/// 行識別フォールバックが隠し疑似列を要求しているときだけ、その列名を返す。
fn hidden_column_of(identity: &Option<TableRowIdentity>) -> Option<&str> {
    let id = identity.as_ref()?;
    if id.strategy == "rowid" || id.strategy == "ctid" {
        id.hidden_column.as_deref()
    } else {
        None
    }
}

fn has_primary_key(columns: &[TableColumnInfo]) -> bool {
    columns.iter().any(|c| c.key.eq_ignore_ascii_case("PRI"))
}

pub(crate) async fn open_table_inner(
    session: &Session,
    database: &str,
    table: &str,
    limit: u64,
    with_estimate: bool,
) -> Result<OpenTableResult> {
    let conn = &session.conn;
    let cache = &session.schema_cache;
    // 列 → (PK 無しのときだけ) 行識別は依存があるので 1 本の future にまとめ、
    // 独立な行数推定と `join!` で並行させる。
    let schema = async {
        let columns = cache
            .columns(database, table, || conn.columns(database, table))
            .await?;
        let identity = if has_primary_key(&columns) {
            None
        } else {
            cache
                .row_identity(database, table, || conn.row_identity(database, table))
                .await
                .ok()
        };
        Ok::<_, AppError>((columns, identity))
    };
    let estimate = async {
        if !with_estimate {
            return None;
        }
        match tokio::time::timeout(ESTIMATE_TIMEOUT, conn.table_row_estimate(database, table)).await
        {
            Ok(Ok(est)) => est,
            _ => None,
        }
    };
    let (schema, row_estimate) = tokio::join!(schema, estimate);
    let (columns, row_identity) = schema?;
    let base = table_select_sql(
        conn.driver_kind(),
        database,
        table,
        hidden_column_of(&row_identity),
    );
    let sql = format!("{base} LIMIT {limit}");
    Ok(OpenTableResult {
        base,
        sql,
        columns,
        row_identity,
        row_estimate,
    })
}

/// テーブルタブを開くのに必要な情報 (列・行識別・初回 SELECT・行数推定) を
/// 1 回で返す (#1263)。列の取得失敗はエラー、行識別・行数推定の失敗は
/// `None` で続行する (従来のフロントの挙動と同じ)。読み取り専用の introspection。
#[tauri::command]
pub async fn open_table(
    session_id: String,
    database: String,
    table: String,
    limit: u64,
    with_estimate: bool,
    state: State<'_, AppState>,
) -> Result<OpenTableResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    open_table_inner(&session, &database, &table, limit, with_estimate).await
}

pub(crate) async fn open_tables_inner(
    session: &Session,
    tables: Vec<(String, String)>,
    limit: u64,
) -> Vec<OpenTableEntry> {
    let stream = stream::iter(tables)
        .map(|(database, table)| async move {
            match open_table_inner(session, &database, &table, limit, false).await {
                Ok(result) => OpenTableEntry {
                    database,
                    table,
                    result: Some(result),
                    error: None,
                },
                Err(e) => OpenTableEntry {
                    database,
                    table,
                    result: None,
                    error: Some(e.to_string()),
                },
            }
        })
        .buffered(OPEN_CONCURRENCY);
    futures_util::pin_mut!(stream);
    let mut out = Vec::new();
    while let Some(entry) = stream.next().await {
        out.push(entry);
    }
    out
}

/// セッション復元用の一括版 (#1263)。`tables` の各 `(データベース, テーブル)` を
/// `open_table` と同じ内容で並行に解決し、要求順に返す。テーブルごとの失敗は
/// `error` に入れて他のテーブルには影響させない (呼び出し側が「存在しない
/// テーブルのタブをクエリタブへ降格」する判断に使う)。行数推定は取得しない。
#[tauri::command]
pub async fn open_tables(
    session_id: String,
    tables: Vec<(String, String)>,
    limit: u64,
    state: State<'_, AppState>,
) -> Result<Vec<OpenTableEntry>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    Ok(open_tables_inner(&session, tables, limit).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        driver: String,
        database: String,
        table: String,
        hidden: Option<String>,
        expected: String,
    }

    /// フロント (`sqlDialect.test.ts`) と共有するゴールデン。
    #[test]
    fn table_select_sql_matches_shared_golden_vectors() {
        let raw = include_str!("../../../src/__tests__/fixtures/tableSelectSql.json");
        let vectors: Vec<Vector> = serde_json::from_str(raw).expect("fixture parses");
        assert!(!vectors.is_empty());
        for v in vectors {
            let driver = match v.driver.as_str() {
                "mysql" => DriverKind::Mysql,
                "postgres" => DriverKind::Postgres,
                "sqlite" => DriverKind::Sqlite,
                other => panic!("unknown driver {other}"),
            };
            assert_eq!(
                table_select_sql(driver, &v.database, &v.table, v.hidden.as_deref()),
                v.expected,
                "{} {}.{} {:?}",
                v.driver,
                v.database,
                v.table,
                v.hidden
            );
        }
    }

    fn identity(strategy: &str, hidden: Option<&str>) -> Option<TableRowIdentity> {
        Some(TableRowIdentity {
            strategy: strategy.to_string(),
            hidden_column: hidden.map(str::to_string),
        })
    }

    #[test]
    fn hidden_column_only_for_rowid_and_ctid() {
        assert_eq!(
            hidden_column_of(&identity("rowid", Some("rowid"))),
            Some("rowid")
        );
        assert_eq!(
            hidden_column_of(&identity("ctid", Some("ctid"))),
            Some("ctid")
        );
        assert_eq!(hidden_column_of(&identity("all_columns", None)), None);
        assert_eq!(hidden_column_of(&identity("rowid", None)), None);
        assert_eq!(hidden_column_of(&None), None);
    }
}
