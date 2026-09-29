//! タスク実行ログの永続化 (#730)。`history/store.rs` (`history.sqlite`) と同じ
//! sqlx SQLite パターンだが、ファイルを分けて **クエリ履歴を汚さない**
//! (`task_runs.sqlite`)。プールは初回利用時に遅延オープンし、テーブルは
//! `CREATE TABLE IF NOT EXISTS` で用意するのでマイグレーション手順は不要。

use std::path::PathBuf;

use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::Row;
use tokio::sync::OnceCell;

use super::{AssertionRunRecord, NewAssertionResult, NewTaskRun, TaskRun};
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

fn runs_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("task_runs.sqlite"))
}

async fn pool() -> Result<&'static SqlitePool> {
    POOL.get_or_try_init(|| async {
        let path = runs_path()?;
        let connect = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(connect)
            .await
            .map_err(|e| {
                tracing::error!(path = %path.display(), error = %e, "task_runs: failed to open database");
                e
            })?;
        init_schema(&pool).await.map_err(|e| {
            tracing::error!(error = %e, "task_runs: failed to initialize schema");
            e
        })?;
        Ok(pool)
    })
    .await
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS task_runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id      TEXT NOT NULL,
            started_at   TEXT NOT NULL,
            finished_at  TEXT NOT NULL,
            status       TEXT NOT NULL,
            error        TEXT,
            output_path  TEXT,
            \"rows\"       INTEGER,
            bytes        INTEGER,
            elapsed_ms   INTEGER NOT NULL,
            catch_up     INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_task_runs_task_time
            ON task_runs(task_id, started_at DESC)",
    )
    .execute(pool)
    .await?;
    // #1170: アサーション実行タスクの 1 アサーションごとの合否。既存の DB には
    // 単に新テーブルが増えるだけ (`task_runs` のスキーマは変えない)。
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS assertion_runs (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id        TEXT NOT NULL,
            run_started_at TEXT NOT NULL,
            assertion_id   TEXT NOT NULL,
            assertion_name TEXT NOT NULL,
            passed         INTEGER NOT NULL,
            observed       INTEGER,
            error          TEXT,
            elapsed_ms     INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_assertion_runs_assertion_time
            ON assertion_runs(assertion_id, run_started_at DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// `assertion_runs` の保持上限。1 実行で複数行入るので `task_runs` より大きく取る。
const MAX_ASSERTION_RUN_ROWS: i64 = 20_000;

/// 1 回の実行が出した各アサーションの結果をまとめて記録する。
pub async fn record_assertion_results(
    task_id: &str,
    run_started_at: &str,
    results: Vec<NewAssertionResult>,
) -> Result<()> {
    record_assertion_results_in(
        pool().await?,
        task_id,
        run_started_at,
        results,
        MAX_ASSERTION_RUN_ROWS,
    )
    .await
}

async fn record_assertion_results_in(
    pool: &SqlitePool,
    task_id: &str,
    run_started_at: &str,
    results: Vec<NewAssertionResult>,
    max_rows: i64,
) -> Result<()> {
    if results.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for r in results {
        sqlx::query(
            "INSERT INTO assertion_runs
                (task_id, run_started_at, assertion_id, assertion_name,
                 passed, observed, error, elapsed_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(task_id.to_string())
        .bind(run_started_at.to_string())
        .bind(r.assertion_id)
        .bind(r.assertion_name)
        .bind(r.passed)
        .bind(r.observed)
        .bind(r.error)
        .bind(r.elapsed_ms)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "DELETE FROM assertion_runs
            WHERE id NOT IN (
                SELECT id FROM assertion_runs ORDER BY id DESC LIMIT ?
            )",
    )
    .bind(max_rows.max(1))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// アサーション実行の履歴を新しい順に返す。`task_id` / `assertion_id` で絞り込める。
pub async fn list_assertion_runs(
    task_id: Option<&str>,
    assertion_id: Option<&str>,
    limit: i64,
) -> Result<Vec<AssertionRunRecord>> {
    list_assertion_runs_in(pool().await?, task_id, assertion_id, limit).await
}

async fn list_assertion_runs_in(
    pool: &SqlitePool,
    task_id: Option<&str>,
    assertion_id: Option<&str>,
    limit: i64,
) -> Result<Vec<AssertionRunRecord>> {
    let mut sql = String::from(
        "SELECT id, task_id, run_started_at, assertion_id, assertion_name,
                passed, observed, error, elapsed_ms
         FROM assertion_runs WHERE 1 = 1",
    );
    if task_id.is_some() {
        sql.push_str(" AND task_id = ?");
    }
    if assertion_id.is_some() {
        sql.push_str(" AND assertion_id = ?");
    }
    sql.push_str(" ORDER BY run_started_at DESC, id DESC LIMIT ?");
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(id) = task_id {
        q = q.bind(id.to_string());
    }
    if let Some(id) = assertion_id {
        q = q.bind(id.to_string());
    }
    q = q.bind(limit.max(1));
    let rows: Vec<SqliteRow> = q.fetch_all(pool).await?;
    Ok(rows
        .iter()
        .map(|r| AssertionRunRecord {
            id: r.try_get("id").unwrap_or_default(),
            task_id: r.try_get("task_id").unwrap_or_default(),
            run_started_at: r.try_get("run_started_at").unwrap_or_default(),
            assertion_id: r.try_get("assertion_id").unwrap_or_default(),
            assertion_name: r.try_get("assertion_name").unwrap_or_default(),
            passed: r.try_get::<i64, _>("passed").unwrap_or(0) != 0,
            observed: r.try_get("observed").unwrap_or(None),
            error: r.try_get("error").unwrap_or(None),
            elapsed_ms: r.try_get("elapsed_ms").unwrap_or_default(),
        })
        .collect())
}

/// Retention cap, same rationale/shape as `history::store::MAX_HISTORY_ROWS`
/// (#822): the run log behaves like a ring buffer so long-lived installs don't
/// grow this file unbounded.
const MAX_TASK_RUN_ROWS: i64 = 5_000;

pub async fn record(entry: NewTaskRun) -> Result<i64> {
    record_in_with_cap(pool().await?, entry, MAX_TASK_RUN_ROWS).await
}

async fn record_in_with_cap(pool: &SqlitePool, entry: NewTaskRun, max_rows: i64) -> Result<i64> {
    let result = sqlx::query(
        "INSERT INTO task_runs
            (task_id, started_at, finished_at, status, error, output_path,
             \"rows\", bytes, elapsed_ms, catch_up)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(entry.task_id)
    .bind(entry.started_at)
    .bind(entry.finished_at)
    .bind(entry.status)
    .bind(entry.error)
    .bind(entry.output_path)
    .bind(entry.rows)
    .bind(entry.bytes)
    .bind(entry.elapsed_ms)
    .bind(entry.catch_up)
    .execute(pool)
    .await?;
    let id = result.last_insert_rowid();
    enforce_retention(pool, max_rows).await?;
    Ok(id)
}

async fn enforce_retention(pool: &SqlitePool, max_rows: i64) -> Result<()> {
    sqlx::query(
        "DELETE FROM task_runs
            WHERE id NOT IN (
                SELECT id FROM task_runs ORDER BY id DESC LIMIT ?
            )",
    )
    .bind(max_rows.max(1))
    .execute(pool)
    .await?;
    Ok(())
}

/// Lists runs newest-first. `task_id = Some` narrows to a single task;
/// `limit` caps the number of rows.
pub async fn list(task_id: Option<&str>, limit: i64) -> Result<Vec<TaskRun>> {
    list_in(pool().await?, task_id, limit).await
}

async fn list_in(pool: &SqlitePool, task_id: Option<&str>, limit: i64) -> Result<Vec<TaskRun>> {
    let mut sql = String::from(
        "SELECT id, task_id, started_at, finished_at, status, error, output_path,
                \"rows\", bytes, elapsed_ms, catch_up
         FROM task_runs",
    );
    if task_id.is_some() {
        sql.push_str(" WHERE task_id = ?");
    }
    sql.push_str(" ORDER BY started_at DESC, id DESC LIMIT ?");

    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(id) = task_id {
        q = q.bind(id.to_string());
    }
    q = q.bind(limit.max(1));

    let rows: Vec<SqliteRow> = q.fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_run).collect())
}

/// Deletes run log rows. `Some(task_id)` clears just that task's history;
/// `None` clears everything. Returns the number of rows removed.
pub async fn clear(task_id: Option<&str>) -> Result<u64> {
    clear_in(pool().await?, task_id).await
}

async fn clear_in(pool: &SqlitePool, task_id: Option<&str>) -> Result<u64> {
    let affected = match task_id {
        Some(id) => {
            sqlx::query("DELETE FROM assertion_runs WHERE task_id = ?")
                .bind(id.to_string())
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM task_runs WHERE task_id = ?")
                .bind(id.to_string())
                .execute(pool)
                .await?
                .rows_affected()
        }
        None => {
            sqlx::query("DELETE FROM assertion_runs")
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM task_runs")
                .execute(pool)
                .await?
                .rows_affected()
        }
    };
    Ok(affected)
}

fn row_to_run(r: &SqliteRow) -> TaskRun {
    TaskRun {
        id: r.try_get("id").unwrap_or_default(),
        task_id: r.try_get("task_id").unwrap_or_default(),
        started_at: r.try_get("started_at").unwrap_or_default(),
        finished_at: r.try_get("finished_at").unwrap_or_default(),
        status: r.try_get("status").unwrap_or_default(),
        error: r.try_get("error").unwrap_or(None),
        output_path: r.try_get("output_path").unwrap_or(None),
        rows: r.try_get("rows").unwrap_or(None),
        bytes: r.try_get("bytes").unwrap_or(None),
        elapsed_ms: r.try_get("elapsed_ms").unwrap_or_default(),
        catch_up: r.try_get::<i64, _>("catch_up").unwrap_or(0) != 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(task: &str, status: &str, at: &str) -> NewTaskRun {
        NewTaskRun {
            task_id: task.to_string(),
            started_at: at.to_string(),
            finished_at: at.to_string(),
            status: status.to_string(),
            error: None,
            output_path: Some("/tmp/out.csv".to_string()),
            rows: Some(3),
            bytes: Some(100),
            elapsed_ms: 5,
            catch_up: false,
        }
    }

    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(":memory:"))
            .await
            .unwrap();
        init_schema(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn records_and_lists_newest_first_filtered_by_task() {
        let pool = temp_pool().await;
        record_in_with_cap(&pool, entry("t1", "ok", "2026-01-01T00:00:00Z"), 100)
            .await
            .unwrap();
        record_in_with_cap(&pool, entry("t1", "error", "2026-01-02T00:00:00Z"), 100)
            .await
            .unwrap();
        record_in_with_cap(&pool, entry("t2", "ok", "2026-01-03T00:00:00Z"), 100)
            .await
            .unwrap();

        let all = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].task_id, "t2");

        let t1_only = list_in(&pool, Some("t1"), 100).await.unwrap();
        assert_eq!(t1_only.len(), 2);
        assert!(t1_only.iter().all(|r| r.task_id == "t1"));
        assert_eq!(t1_only[0].status, "error");
    }

    #[tokio::test]
    async fn clears_by_task_and_all() {
        let pool = temp_pool().await;
        record_in_with_cap(&pool, entry("t1", "ok", "2026-01-01T00:00:00Z"), 100)
            .await
            .unwrap();
        record_in_with_cap(&pool, entry("t2", "ok", "2026-01-02T00:00:00Z"), 100)
            .await
            .unwrap();

        assert_eq!(clear_in(&pool, Some("t1")).await.unwrap(), 1);
        assert_eq!(list_in(&pool, None, 100).await.unwrap().len(), 1);
        assert_eq!(clear_in(&pool, None).await.unwrap(), 1);
        assert!(list_in(&pool, None, 100).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn record_evicts_oldest_rows_past_the_cap() {
        let pool = temp_pool().await;
        for i in 0..5 {
            record_in_with_cap(
                &pool,
                entry("t1", "ok", &format!("2026-01-01T00:00:{i:02}Z")),
                3,
            )
            .await
            .unwrap();
        }
        let remaining = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(remaining.len(), 3);
    }

    fn result(id: &str, passed: bool, observed: Option<i64>) -> NewAssertionResult {
        NewAssertionResult {
            assertion_id: id.to_string(),
            assertion_name: format!("name-{id}"),
            passed,
            observed,
            error: None,
            elapsed_ms: 3,
        }
    }

    #[tokio::test]
    async fn assertion_results_round_trip_filter_and_clear_with_task() {
        let pool = temp_pool().await;
        record_assertion_results_in(
            &pool,
            "t1",
            "2026-01-01T00:00:00Z",
            vec![result("a1", true, Some(0)), result("a2", false, Some(7))],
            100,
        )
        .await
        .unwrap();
        record_assertion_results_in(
            &pool,
            "t2",
            "2026-01-02T00:00:00Z",
            vec![result("a1", false, None)],
            100,
        )
        .await
        .unwrap();

        let all = list_assertion_runs_in(&pool, None, None, 100)
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].task_id, "t2");
        assert!(!all[0].passed);
        assert_eq!(all[0].observed, None);

        let a1 = list_assertion_runs_in(&pool, None, Some("a1"), 100)
            .await
            .unwrap();
        assert_eq!(a1.len(), 2);
        let t1_a2 = list_assertion_runs_in(&pool, Some("t1"), Some("a2"), 100)
            .await
            .unwrap();
        assert_eq!(t1_a2.len(), 1);
        assert_eq!(t1_a2[0].observed, Some(7));

        clear_in(&pool, Some("t1")).await.unwrap();
        assert_eq!(
            list_assertion_runs_in(&pool, None, None, 100)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn assertion_results_respect_retention_cap() {
        let pool = temp_pool().await;
        for i in 0..4 {
            record_assertion_results_in(
                &pool,
                "t1",
                &format!("2026-01-01T00:00:{i:02}Z"),
                vec![result("a1", true, Some(0))],
                2,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            list_assertion_runs_in(&pool, None, None, 100)
                .await
                .unwrap()
                .len(),
            2
        );
    }
}
