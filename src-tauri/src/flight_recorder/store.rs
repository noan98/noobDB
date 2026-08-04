use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::Row;
use tokio::sync::OnceCell;

use super::{NewWriteCapture, WriteCaptureRecord, WriteCaptureSummary};
use crate::db::types::Value;
use crate::db::WriteKind;
use crate::error::{AppError, Result};
use crate::history::store::data_dir;

/// Lazily-opened connection pool to the local flight-recorder database. The
/// file lives alongside `profiles.json` / `history.sqlite` in the project
/// data dir and is created on first use so a fresh install doesn't need any
/// migration step (same pattern as `history::store`).
static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

fn flight_recorder_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("flight_recorder.sqlite"))
}

async fn pool() -> Result<&'static SqlitePool> {
    POOL.get_or_try_init(|| async {
        let path = flight_recorder_path()?;
        let connect = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(connect)
            .await
            .map_err(|e| {
                tracing::error!(path = %path.display(), error = %e, "flight recorder: failed to open database");
                e
            })?;
        init_schema(&pool).await.map_err(|e| {
            tracing::error!(error = %e, "flight recorder: failed to initialize schema");
            e
        })?;
        Ok(pool)
    })
    .await
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS write_capture (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id    TEXT,
            driver        TEXT NOT NULL,
            \"database\"    TEXT,
            table_name    TEXT NOT NULL,
            kind          TEXT NOT NULL,
            \"sql\"         TEXT NOT NULL,
            primary_key   TEXT NOT NULL,
            columns       TEXT NOT NULL,
            column_types  TEXT NOT NULL,
            before_rows   TEXT NOT NULL,
            after_rows    TEXT NOT NULL,
            rows_affected INTEGER NOT NULL,
            captured_at   TEXT NOT NULL,
            undone        INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_flight_profile_time
            ON write_capture(profile_id, captured_at DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Row-count retention cap, mirroring `history::store::MAX_HISTORY_ROWS`: a
/// ring buffer across all profiles combined, oldest evicted first.
const MAX_FLIGHT_RECORDS: i64 = 10_000;

fn kind_to_str(kind: WriteKind) -> &'static str {
    match kind {
        WriteKind::Insert => "insert",
        WriteKind::Update => "update",
        WriteKind::Delete => "delete",
        WriteKind::Other => "other",
    }
}

fn kind_from_str(s: &str) -> WriteKind {
    match s {
        "insert" => WriteKind::Insert,
        "update" => WriteKind::Update,
        "delete" => WriteKind::Delete,
        _ => WriteKind::Other,
    }
}

/// Records a new capture and prunes rows past the row-count cap and the
/// `retention_days` age window. Returns the new row's id.
pub async fn record(entry: NewWriteCapture, retention_days: i64) -> Result<i64> {
    record_in(pool().await?, entry, MAX_FLIGHT_RECORDS, retention_days).await
}

async fn record_in(
    pool: &SqlitePool,
    entry: NewWriteCapture,
    max_rows: i64,
    retention_days: i64,
) -> Result<i64> {
    let primary_key = serde_json::to_string(&entry.primary_key)?;
    let columns = serde_json::to_string(&entry.columns)?;
    let column_types = serde_json::to_string(&entry.column_types)?;
    let before_rows = serde_json::to_string(&entry.before_rows)?;
    let after_rows = serde_json::to_string(&entry.after_rows)?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO write_capture
            (profile_id, driver, \"database\", table_name, kind, \"sql\", primary_key,
             columns, column_types, before_rows, after_rows, rows_affected, captured_at, undone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         RETURNING id",
    )
    .bind(entry.profile_id)
    .bind(entry.driver)
    .bind(entry.database)
    .bind(entry.table)
    .bind(kind_to_str(entry.kind))
    .bind(entry.sql)
    .bind(primary_key)
    .bind(columns)
    .bind(column_types)
    .bind(before_rows)
    .bind(after_rows)
    .bind(entry.rows_affected)
    .bind(entry.captured_at)
    .fetch_one(pool)
    .await?;

    enforce_retention(pool, max_rows, retention_days).await?;
    Ok(id)
}

/// Evicts rows past `max_rows` (by insertion order, like history) and rows
/// older than `retention_days` (adjustable per-call so callers can pass the
/// user's configured retention period). `retention_days <= 0` disables the
/// age-based prune (row-count cap still applies).
async fn enforce_retention(pool: &SqlitePool, max_rows: i64, retention_days: i64) -> Result<()> {
    sqlx::query(
        "DELETE FROM write_capture
            WHERE id NOT IN (
                SELECT id FROM write_capture ORDER BY id DESC LIMIT ?
            )",
    )
    .bind(max_rows.max(1))
    .execute(pool)
    .await?;

    if retention_days > 0 {
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
        sqlx::query("DELETE FROM write_capture WHERE captured_at < ?")
            .bind(cutoff)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Lists captures newest-first, optionally scoped to a profile.
pub async fn list(profile_id: Option<&str>, limit: i64) -> Result<Vec<WriteCaptureSummary>> {
    list_in(pool().await?, profile_id, limit).await
}

async fn list_in(
    pool: &SqlitePool,
    profile_id: Option<&str>,
    limit: i64,
) -> Result<Vec<WriteCaptureSummary>> {
    let mut sql = String::from(
        "SELECT id, profile_id, driver, \"database\", table_name, kind, \"sql\",
                rows_affected, captured_at, undone
         FROM write_capture",
    );
    if profile_id.is_some() {
        sql.push_str(" WHERE profile_id = ?");
    }
    sql.push_str(" ORDER BY captured_at DESC, id DESC LIMIT ?");

    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(pid) = profile_id {
        q = q.bind(pid.to_string());
    }
    q = q.bind(limit.max(1));

    let rows: Vec<SqliteRow> = q.fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_summary).collect())
}

/// Fetches one full record (including row payloads) by id, or `None` if it
/// doesn't exist.
pub async fn get(id: i64) -> Result<Option<WriteCaptureRecord>> {
    get_in(pool().await?, id).await
}

async fn get_in(pool: &SqlitePool, id: i64) -> Result<Option<WriteCaptureRecord>> {
    let row: Option<SqliteRow> = sqlx::query(
        "SELECT id, profile_id, driver, \"database\", table_name, kind, \"sql\", primary_key,
                columns, column_types, before_rows, after_rows, rows_affected, captured_at, undone
         FROM write_capture WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_record).transpose()
}

/// Marks a record as undone (idempotent).
pub async fn mark_undone(id: i64) -> Result<()> {
    mark_undone_in(pool().await?, id).await
}

async fn mark_undone_in(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("UPDATE write_capture SET undone = 1 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Deletes captures. `Some(profile_id)` clears just that profile; `None`
/// clears everything. Returns the number of rows removed.
pub async fn clear(profile_id: Option<&str>) -> Result<u64> {
    clear_in(pool().await?, profile_id).await
}

async fn clear_in(pool: &SqlitePool, profile_id: Option<&str>) -> Result<u64> {
    let affected = match profile_id {
        Some(pid) => sqlx::query("DELETE FROM write_capture WHERE profile_id = ?")
            .bind(pid.to_string())
            .execute(pool)
            .await?
            .rows_affected(),
        None => sqlx::query("DELETE FROM write_capture")
            .execute(pool)
            .await?
            .rows_affected(),
    };
    Ok(affected)
}

fn row_to_summary(r: &SqliteRow) -> WriteCaptureSummary {
    WriteCaptureSummary {
        id: r.try_get("id").unwrap_or_default(),
        profile_id: r.try_get("profile_id").unwrap_or(None),
        driver: r.try_get("driver").unwrap_or_default(),
        database: r.try_get("database").unwrap_or(None),
        table: r.try_get("table_name").unwrap_or_default(),
        kind: kind_from_str(&r.try_get::<String, _>("kind").unwrap_or_default()),
        sql: r.try_get("sql").unwrap_or_default(),
        rows_affected: r.try_get("rows_affected").unwrap_or_default(),
        captured_at: r.try_get("captured_at").unwrap_or_default(),
        undone: r.try_get::<i64, _>("undone").unwrap_or_default() != 0,
    }
}

fn row_to_record(r: SqliteRow) -> Result<WriteCaptureRecord> {
    let primary_key: Vec<String> = serde_json::from_str(&r.try_get::<String, _>("primary_key")?)?;
    let columns: Vec<String> = serde_json::from_str(&r.try_get::<String, _>("columns")?)?;
    let column_types: Vec<String> = serde_json::from_str(&r.try_get::<String, _>("column_types")?)?;
    let before_rows: Vec<Vec<Value>> =
        serde_json::from_str(&r.try_get::<String, _>("before_rows")?)?;
    let after_rows: Vec<Vec<Value>> = serde_json::from_str(&r.try_get::<String, _>("after_rows")?)?;
    Ok(WriteCaptureRecord {
        id: r.try_get("id")?,
        profile_id: r.try_get("profile_id")?,
        driver: r.try_get("driver")?,
        database: r.try_get("database")?,
        table: r.try_get("table_name")?,
        kind: kind_from_str(&r.try_get::<String, _>("kind")?),
        sql: r.try_get("sql")?,
        primary_key,
        columns,
        column_types,
        before_rows,
        after_rows,
        rows_affected: r.try_get("rows_affected")?,
        captured_at: r.try_get("captured_at")?,
        undone: r.try_get::<i64, _>("undone")? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(profile: &str, table: &str, at: &str) -> NewWriteCapture {
        NewWriteCapture {
            profile_id: Some(profile.to_string()),
            driver: "sqlite".to_string(),
            database: None,
            table: table.to_string(),
            kind: WriteKind::Update,
            sql: format!("UPDATE {table} SET a=1 WHERE id=1"),
            primary_key: vec!["id".to_string()],
            columns: vec!["id".to_string(), "a".to_string()],
            column_types: vec!["INTEGER".to_string(), "INTEGER".to_string()],
            before_rows: vec![vec![Value::Int(1), Value::Int(0)]],
            after_rows: vec![vec![Value::Int(1), Value::Int(1)]],
            rows_affected: 1,
            captured_at: at.to_string(),
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
    async fn records_and_lists_newest_first_scoped_by_profile() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "t1", "2026-01-01T00:00:00Z"), 100, 0)
            .await
            .unwrap();
        record_in(&pool, entry("p1", "t2", "2026-01-02T00:00:00Z"), 100, 0)
            .await
            .unwrap();
        record_in(&pool, entry("p2", "t3", "2026-01-03T00:00:00Z"), 100, 0)
            .await
            .unwrap();

        let all = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].table, "t3");

        let p1 = list_in(&pool, Some("p1"), 100).await.unwrap();
        assert_eq!(p1.len(), 2);
    }

    #[tokio::test]
    async fn round_trips_full_record_including_row_payloads() {
        let pool = temp_pool().await;
        let id = record_in(&pool, entry("p1", "t1", "2026-01-01T00:00:00Z"), 100, 0)
            .await
            .unwrap();
        let record = get_in(&pool, id).await.unwrap().unwrap();
        assert_eq!(record.table, "t1");
        assert_eq!(record.kind, WriteKind::Update);
        assert_eq!(record.before_rows, vec![vec![Value::Int(1), Value::Int(0)]]);
        assert_eq!(record.after_rows, vec![vec![Value::Int(1), Value::Int(1)]]);
        assert!(!record.undone);
    }

    #[tokio::test]
    async fn get_returns_none_for_missing_id() {
        let pool = temp_pool().await;
        assert!(get_in(&pool, 999).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mark_undone_flips_the_flag() {
        let pool = temp_pool().await;
        let id = record_in(&pool, entry("p1", "t1", "2026-01-01T00:00:00Z"), 100, 0)
            .await
            .unwrap();
        mark_undone_in(&pool, id).await.unwrap();
        let record = get_in(&pool, id).await.unwrap().unwrap();
        assert!(record.undone);
    }

    #[tokio::test]
    async fn record_in_evicts_oldest_rows_past_the_cap() {
        let pool = temp_pool().await;
        for i in 0..5 {
            record_in(
                &pool,
                entry("p1", &format!("t{i}"), &format!("2026-01-01T00:00:{i:02}Z")),
                3,
                0,
            )
            .await
            .unwrap();
        }
        let remaining = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(remaining.len(), 3);
        let tables: Vec<&str> = remaining.iter().map(|e| e.table.as_str()).collect();
        assert!(!tables.contains(&"t0"));
        assert!(!tables.contains(&"t1"));
    }

    #[tokio::test]
    async fn record_in_evicts_rows_older_than_retention_days() {
        let pool = temp_pool().await;
        let old = (chrono::Utc::now() - chrono::Duration::days(90)).to_rfc3339();
        record_in(&pool, entry("p1", "old", &old), 100, 30)
            .await
            .unwrap();
        let recent = chrono::Utc::now().to_rfc3339();
        record_in(&pool, entry("p1", "recent", &recent), 100, 30)
            .await
            .unwrap();
        let remaining = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].table, "recent");
    }

    #[tokio::test]
    async fn clears_by_profile_and_all() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "t1", "2026-01-01T00:00:00Z"), 100, 0)
            .await
            .unwrap();
        record_in(&pool, entry("p2", "t2", "2026-01-02T00:00:00Z"), 100, 0)
            .await
            .unwrap();

        let removed = clear_in(&pool, Some("p1")).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(list_in(&pool, None, 100).await.unwrap().len(), 1);

        let removed_all = clear_in(&pool, None).await.unwrap();
        assert_eq!(removed_all, 1);
        assert!(list_in(&pool, None, 100).await.unwrap().is_empty());
    }
}
