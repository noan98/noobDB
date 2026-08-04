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
        restrict_permissions(&path);
        Ok(pool)
    })
    .await
}

/// Best-effort owner-only file permissions (`0600`) on Unix, mirroring the
/// pattern already used for `mysqldump`'s temporary credentials file
/// (`commands::dump`). The captured before/after row payloads can contain
/// arbitrary application data, so this is a defense-in-depth narrowing on top
/// of the OS user-directory permissions the rest of the app's local stores
/// (`history.sqlite`, `profiles.json`, ...) already rely on implicitly — not
/// applied there in this PR, kept scoped to the new store. Never fails
/// startup: a permission-set failure is logged and otherwise ignored.
fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(path = %path.display(), error = %e, "flight recorder: failed to restrict file permissions");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
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

/// Total on-disk size cap (#735 acceptance criteria: "行数・容量上限と
/// ローテーションが機能する"). The row-count cap above bounds *how many*
/// captures are kept; this bounds *how large* the store is allowed to grow,
/// which matters independently because a handful of unusually large
/// before/after images (wide tables, many affected rows near the per-write
/// row cap) can blow past a reasonable disk budget while still being well
/// within `MAX_FLIGHT_RECORDS`.
const MAX_FLIGHT_RECORDER_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB

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

/// Records a new capture and prunes rows past the row-count cap, the
/// `retention_days` age window, and the total on-disk byte cap. Returns the
/// new row's id.
pub async fn record(entry: NewWriteCapture, retention_days: i64) -> Result<i64> {
    record_in(
        pool().await?,
        entry,
        MAX_FLIGHT_RECORDS,
        retention_days,
        MAX_FLIGHT_RECORDER_BYTES,
    )
    .await
}

async fn record_in(
    pool: &SqlitePool,
    entry: NewWriteCapture,
    max_rows: i64,
    retention_days: i64,
    max_bytes: u64,
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
    enforce_byte_cap(pool, max_bytes).await?;
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

/// Approximate on-disk size via `PRAGMA page_count` * `PRAGMA page_size` —
/// works identically for a real file-backed pool and an in-memory (`:memory:`)
/// one, so no extra filesystem access (or the flight recorder's own file
/// path) is needed here.
async fn approx_size_bytes(pool: &SqlitePool) -> Result<u64> {
    let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(pool)
        .await?;
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(pool)
        .await?;
    Ok(page_count.max(0) as u64 * page_size.max(0) as u64)
}

/// Evicts the oldest rows in small batches until the database's estimated
/// on-disk size is back under `max_bytes`, then reclaims the freed space with
/// `VACUUM` (a plain `DELETE` only frees pages for reuse *within* the file;
/// `VACUUM` is what actually shrinks it). Runs after [`enforce_retention`], so
/// this only kicks in when a handful of unusually large captures blow past
/// the byte budget despite being within the row-count cap. Best-effort: a
/// `VACUUM` failure is logged and left for the next successful run rather
/// than failing the capture that triggered it (the capture itself already
/// succeeded by this point).
async fn enforce_byte_cap(pool: &SqlitePool, max_bytes: u64) -> Result<()> {
    if approx_size_bytes(pool).await? <= max_bytes {
        return Ok(());
    }
    // Evict one row at a time (oldest first) rather than in large batches:
    // the whole point of this cap is to bound unusually *large* individual
    // captures, so a fixed batch size larger than the table can (and did, in
    // testing) wipe every row in one shot instead of trimming incrementally.
    // Always leaves at least the single newest row behind — even a lone
    // oversized capture stays queryable — rather than evicting down to zero.
    loop {
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM write_capture")
            .fetch_one(pool)
            .await?;
        if row_count <= 1 {
            break;
        }
        let deleted = sqlx::query(
            "DELETE FROM write_capture
                WHERE id = (SELECT id FROM write_capture ORDER BY id ASC LIMIT 1)",
        )
        .execute(pool)
        .await?
        .rows_affected();
        if deleted == 0 {
            break;
        }
        if approx_size_bytes(pool).await? <= max_bytes {
            break;
        }
    }
    if let Err(e) = sqlx::query("VACUUM").execute(pool).await {
        tracing::warn!(error = %e, "flight recorder: VACUUM after byte-cap eviction failed");
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
        record_in(
            &pool,
            entry("p1", "t1", "2026-01-01T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry("p1", "t2", "2026-01-02T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry("p2", "t3", "2026-01-03T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
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
        let id = record_in(
            &pool,
            entry("p1", "t1", "2026-01-01T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
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
        let id = record_in(
            &pool,
            entry("p1", "t1", "2026-01-01T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
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
                u64::MAX,
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
        record_in(&pool, entry("p1", "old", &old), 100, 30, u64::MAX)
            .await
            .unwrap();
        let recent = chrono::Utc::now().to_rfc3339();
        record_in(&pool, entry("p1", "recent", &recent), 100, 30, u64::MAX)
            .await
            .unwrap();
        let remaining = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].table, "recent");
    }

    #[tokio::test]
    async fn clears_by_profile_and_all() {
        let pool = temp_pool().await;
        record_in(
            &pool,
            entry("p1", "t1", "2026-01-01T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry("p2", "t2", "2026-01-02T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
        .await
        .unwrap();

        let removed = clear_in(&pool, Some("p1")).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(list_in(&pool, None, 100).await.unwrap().len(), 1);

        let removed_all = clear_in(&pool, None).await.unwrap();
        assert_eq!(removed_all, 1);
        assert!(list_in(&pool, None, 100).await.unwrap().is_empty());
    }

    /// A real file-backed pool (unlike `temp_pool`'s `:memory:`), so
    /// `enforce_byte_cap`'s `VACUUM` measurably shrinks something on disk —
    /// exercised by `record_in_evicts_oldest_rows_past_the_byte_cap` below
    /// (#735 review follow-up: the row-count/age caps alone don't bound total
    /// size when individual captures are large).
    async fn temp_file_pool(tag: &str) -> (std::path::PathBuf, SqlitePool) {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "noobdb_flight_recorder_bytecap_{tag}_{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        init_schema(&pool).await.unwrap();
        (path, pool)
    }

    /// A capture entry with a large `before_rows` payload, so a handful of
    /// them are enough to push a real file past a small byte cap without
    /// needing thousands of rows.
    fn big_entry(table: &str, at: &str) -> NewWriteCapture {
        let mut e = entry("p1", table, at);
        let filler = "x".repeat(64 * 1024); // 64 KiB of padding per row
        e.before_rows = vec![vec![Value::Int(1), Value::String(filler)]];
        e
    }

    #[tokio::test]
    async fn record_in_evicts_oldest_rows_past_the_byte_cap() {
        let (path, pool) = temp_file_pool("evict").await;

        for i in 0..10 {
            record_in(
                &pool,
                big_entry(&format!("t{i}"), &format!("2026-01-01T00:00:{i:02}Z")),
                1_000, // row-count cap stays generous — only the byte cap should bind
                0,
                64 * 1024, // 64 KiB — a single row already exceeds this
            )
            .await
            .unwrap();
        }

        let remaining = list_in(&pool, None, 100).await.unwrap();
        assert!(
            remaining.len() < 10,
            "the byte cap should have evicted at least the oldest rows, got {} remaining",
            remaining.len()
        );
        // The newest row must survive (oldest-first eviction).
        assert_eq!(remaining[0].table, "t9");

        let size_after = approx_size_bytes(&pool).await.unwrap();
        drop(pool);
        let _ = std::fs::remove_file(&path);
        // Not a strict assertion on the exact byte count (SQLite's own
        // bookkeeping pages mean it never hits zero), just that VACUUM did
        // meaningfully shrink the file rather than leaving it at "10 rows
        // worth" of freed-but-unreclaimed pages.
        assert!(
            size_after < 10 * 64 * 1024,
            "expected VACUUM to reclaim space, got {size_after} bytes"
        );
    }

    #[tokio::test]
    async fn record_in_leaves_small_payloads_alone_under_the_byte_cap() {
        let (path, pool) = temp_file_pool("noop").await;
        record_in(
            &pool,
            entry("p1", "t1", "2026-01-01T00:00:00Z"),
            100,
            0,
            u64::MAX,
        )
        .await
        .unwrap();
        let remaining = list_in(&pool, None, 100).await.unwrap();
        assert_eq!(
            remaining.len(),
            1,
            "well under the byte cap must not evict anything"
        );
        drop(pool);
        let _ = std::fs::remove_file(&path);
    }
}
