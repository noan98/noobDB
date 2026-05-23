use std::path::PathBuf;

use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::Row;
use tokio::sync::OnceCell;

use super::{HistoryEntry, NewHistoryEntry};
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "tableX";

/// Lazily-opened connection pool to the local history database. The file lives
/// alongside `profiles.json` in the project data dir and is created on first
/// use so a fresh install doesn't need any migration step.
static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

fn history_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("history.sqlite"))
}

async fn pool() -> Result<&'static SqlitePool> {
    POOL.get_or_try_init(|| async {
        let path = history_path()?;
        let connect = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(connect)
            .await?;
        init_schema(&pool).await?;
        Ok(pool)
    })
    .await
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS query_history (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id    TEXT,
            driver        TEXT NOT NULL,
            \"database\"    TEXT,
            \"sql\"         TEXT NOT NULL,
            \"rows\"        INTEGER,
            rows_affected INTEGER,
            elapsed_ms    INTEGER,
            status        TEXT NOT NULL,
            error         TEXT,
            executed_at   TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_profile_time
            ON query_history(profile_id, executed_at DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record(entry: NewHistoryEntry) -> Result<()> {
    record_in(pool().await?, entry).await
}

async fn record_in(pool: &SqlitePool, entry: NewHistoryEntry) -> Result<()> {
    sqlx::query(
        "INSERT INTO query_history
            (profile_id, driver, \"database\", \"sql\", \"rows\", rows_affected,
             elapsed_ms, status, error, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(entry.profile_id)
    .bind(entry.driver)
    .bind(entry.database)
    .bind(entry.sql)
    .bind(entry.rows)
    .bind(entry.rows_affected)
    .bind(entry.elapsed_ms)
    .bind(entry.status)
    .bind(entry.error)
    .bind(entry.executed_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Lists history newest-first. When `profile_id` is `Some`, only that profile's
/// rows are returned; `search` does a case-insensitive substring match on the
/// SQL text. `limit` caps the number of rows.
pub async fn list(
    profile_id: Option<&str>,
    limit: i64,
    search: Option<&str>,
) -> Result<Vec<HistoryEntry>> {
    list_in(pool().await?, profile_id, limit, search).await
}

async fn list_in(
    pool: &SqlitePool,
    profile_id: Option<&str>,
    limit: i64,
    search: Option<&str>,
) -> Result<Vec<HistoryEntry>> {
    let mut sql = String::from(
        "SELECT id, profile_id, driver, \"database\", \"sql\", \"rows\",
                rows_affected, elapsed_ms, status, error, executed_at
         FROM query_history",
    );
    let mut conds: Vec<&str> = Vec::new();
    if profile_id.is_some() {
        conds.push("profile_id = ?");
    }
    let like = search.map(|s| format!("%{}%", escape_like(s)));
    if like.is_some() {
        conds.push("\"sql\" LIKE ? ESCAPE '\\'");
    }
    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(" AND "));
    }
    // Timestamps are stored as UTC RFC3339, so lexical order is chronological.
    sql.push_str(" ORDER BY executed_at DESC, id DESC LIMIT ?");

    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(pid) = profile_id {
        q = q.bind(pid.to_string());
    }
    if let Some(l) = like {
        q = q.bind(l);
    }
    q = q.bind(limit.max(1));

    let rows: Vec<SqliteRow> = q.fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_entry).collect())
}

/// Deletes history rows. `Some(profile_id)` clears just that profile; `None`
/// clears everything. Returns the number of rows removed.
pub async fn clear(profile_id: Option<&str>) -> Result<u64> {
    clear_in(pool().await?, profile_id).await
}

async fn clear_in(pool: &SqlitePool, profile_id: Option<&str>) -> Result<u64> {
    let affected = match profile_id {
        Some(pid) => {
            sqlx::query("DELETE FROM query_history WHERE profile_id = ?")
                .bind(pid.to_string())
                .execute(pool)
                .await?
                .rows_affected()
        }
        None => sqlx::query("DELETE FROM query_history")
            .execute(pool)
            .await?
            .rows_affected(),
    };
    Ok(affected)
}

fn row_to_entry(r: &SqliteRow) -> HistoryEntry {
    HistoryEntry {
        id: r.try_get("id").unwrap_or_default(),
        profile_id: r.try_get("profile_id").unwrap_or(None),
        driver: r.try_get("driver").unwrap_or_default(),
        database: r.try_get("database").unwrap_or(None),
        sql: r.try_get("sql").unwrap_or_default(),
        rows: r.try_get("rows").unwrap_or(None),
        rows_affected: r.try_get("rows_affected").unwrap_or(None),
        elapsed_ms: r.try_get("elapsed_ms").unwrap_or(None),
        status: r.try_get("status").unwrap_or_default(),
        error: r.try_get("error").unwrap_or(None),
        executed_at: r.try_get("executed_at").unwrap_or_default(),
    }
}

/// Escapes the LIKE wildcards so a user's search text is matched literally.
/// Paired with `ESCAPE '\\'` in the query.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(profile: &str, sql: &str, at: &str) -> NewHistoryEntry {
        NewHistoryEntry {
            profile_id: Some(profile.to_string()),
            driver: "sqlite".to_string(),
            database: None,
            sql: sql.to_string(),
            rows: Some(1),
            rows_affected: None,
            elapsed_ms: Some(5),
            status: "ok".to_string(),
            error: None,
            executed_at: at.to_string(),
        }
    }

    async fn temp_pool() -> SqlitePool {
        // A fresh in-memory database, isolated per test. Pinning a single
        // connection (min == max == 1) keeps the in-memory DB alive across
        // calls instead of being discarded when returned to the pool.
        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(":memory:"))
            .await
            .unwrap();
        init_schema(&pool).await.unwrap();
        pool
    }

    #[test]
    fn escapes_like_wildcards() {
        assert_eq!(escape_like("a_b%c\\d"), "a\\_b\\%c\\\\d");
        assert_eq!(escape_like("plain"), "plain");
    }

    #[tokio::test]
    async fn lists_newest_first_and_filters_by_profile() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "SELECT 1", "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p1", "SELECT 2", "2026-01-02T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p2", "SELECT 3", "2026-01-03T00:00:00Z"))
            .await
            .unwrap();

        let all = list_in(&pool, None, 100, None).await.unwrap();
        assert_eq!(all.len(), 3);
        // Newest executed_at first.
        assert_eq!(all[0].sql, "SELECT 3");

        let p1 = list_in(&pool, Some("p1"), 100, None).await.unwrap();
        assert_eq!(p1.len(), 2);
        assert!(p1.iter().all(|e| e.profile_id.as_deref() == Some("p1")));
    }

    #[tokio::test]
    async fn searches_sql_text_literally() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "SELECT * FROM users", "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p1", "SELECT * FROM orders", "2026-01-02T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p1", "SELECT a_b FROM t", "2026-01-03T00:00:00Z"))
            .await
            .unwrap();

        let hits = list_in(&pool, None, 100, Some("users")).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].sql, "SELECT * FROM users");

        // `_` must be matched literally, not as a wildcard.
        let underscore = list_in(&pool, None, 100, Some("a_b")).await.unwrap();
        assert_eq!(underscore.len(), 1);
        assert_eq!(underscore[0].sql, "SELECT a_b FROM t");
    }

    #[tokio::test]
    async fn clears_by_profile_and_all() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "SELECT 1", "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p2", "SELECT 2", "2026-01-02T00:00:00Z"))
            .await
            .unwrap();

        let removed = clear_in(&pool, Some("p1")).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(list_in(&pool, None, 100, None).await.unwrap().len(), 1);

        let removed_all = clear_in(&pool, None).await.unwrap();
        assert_eq!(removed_all, 1);
        assert!(list_in(&pool, None, 100, None).await.unwrap().is_empty());
    }
}
