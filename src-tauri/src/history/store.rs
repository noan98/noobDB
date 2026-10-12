use std::path::PathBuf;

use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::Row;
use std::sync::atomic::{AtomicI64, Ordering};
use tokio::sync::OnceCell;

use super::{HistoryEntry, NewHistoryEntry};
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

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

/// Unix では、まだ無ければ 0600 の空ファイルを作る。失敗は握り潰す (best-effort)。
fn precreate_private(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path);
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 既存ファイルも含めて所有者のみ (0600) にする (Unix)。起動は妨げない。
fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(path = %path.display(), error = %e, "history: failed to restrict file permissions");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

async fn pool() -> Result<&'static SqlitePool> {
    POOL.get_or_try_init(|| async {
        let path = history_path()?;
        // 履歴にはユーザが実行した SQL 全文が残るため、作成直後から所有者のみ (0600) に
        // する。SQLite に作らせると umask 次第で他ユーザに読める窓ができるので、
        // 空ファイルを先に 0600 で作っておく (SQLite は空ファイルを新規 DB として扱う)。
        precreate_private(&path);
        let connect = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(connect)
            .await
            .map_err(|e| {
                tracing::error!(path = %path.display(), error = %e, "history: failed to open database");
                e
            })?;
        init_schema(&pool).await.map_err(|e| {
            tracing::error!(error = %e, "history: failed to initialize schema");
            e
        })?;
        restrict_permissions(&path);
        // 保存済みの保持日数を取り込む (読めなければ無効のまま)。
        if let Ok(days) = load_retention_days(&pool).await {
            RETENTION_DAYS.store(days, Ordering::Relaxed);
        }
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
    // 履歴自体の設定 (今は保持日数だけ)。フロントの設定ストアではなくここに持つので、
    // 履歴を書く Rust 側の全経路が同じ値を参照でき、起動直後の同期も要らない (#1539)。
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS history_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// 期間ベースの保持日数 (#1539)。0 は無効 (行数上限だけが効く) で既定。
/// `flight_recorder` の `retention_days` と同じ意味で、範囲は 0..=[`MAX_RETENTION_DAYS`]。
/// プロセス内キャッシュで、`pool()` の初期化時に `history_settings` から読み込む。
static RETENTION_DAYS: AtomicI64 = AtomicI64::new(0);

/// 保持日数の上限 (約 10 年)。フロントの `MAX_FLIGHT_RECORDER_RETENTION_DAYS` と揃える。
pub const MAX_RETENTION_DAYS: i64 = 3_650;

const RETENTION_KEY: &str = "retention_days";

async fn load_retention_days(pool: &SqlitePool) -> Result<i64> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM history_settings WHERE key = ?")
        .bind(RETENTION_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(v.and_then(|s| s.trim().parse::<i64>().ok())
        .map(|d| d.clamp(0, MAX_RETENTION_DAYS))
        .unwrap_or(0))
}

/// 現在の保持日数 (0 = 無効)。
pub async fn retention_days() -> Result<i64> {
    pool().await?;
    Ok(RETENTION_DAYS.load(Ordering::Relaxed))
}

/// 保持日数を保存し、すぐに期限切れの行を削除する。削除した行数を返す。
/// 範囲外は `InvalidInput`。
pub async fn set_retention_days(days: i64) -> Result<u64> {
    if !(0..=MAX_RETENTION_DAYS).contains(&days) {
        return Err(AppError::InvalidInput(format!(
            "retention days must be between 0 and {MAX_RETENTION_DAYS}"
        )));
    }
    let pool = pool().await?;
    store_retention_days(pool, days).await?;
    RETENTION_DAYS.store(days, Ordering::Relaxed);
    prune_expired(pool, days).await
}

async fn store_retention_days(pool: &SqlitePool, days: i64) -> Result<()> {
    sqlx::query(
        "INSERT INTO history_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(RETENTION_KEY)
    .bind(days.to_string())
    .execute(pool)
    .await?;
    Ok(())
}

/// Retention cap (#822): history behaves like a ring buffer capped at this many
/// rows across all profiles combined. Bounds disk usage for long-lived
/// installs without needing a manual "clear history" habit. Oldest rows (by
/// insertion order, i.e. `id`) are evicted first. Chosen generously so normal
/// day-to-day usage keeps months of history before anything is dropped.
const MAX_HISTORY_ROWS: i64 = 10_000;

pub async fn record(entry: NewHistoryEntry) -> Result<()> {
    record_in(pool().await?, entry).await
}

async fn record_in(pool: &SqlitePool, entry: NewHistoryEntry) -> Result<()> {
    record_in_with_policy(
        pool,
        entry,
        MAX_HISTORY_ROWS,
        RETENTION_DAYS.load(Ordering::Relaxed),
    )
    .await
}

/// Same as `record_in` but with an explicit retention cap, so tests can
/// exercise the real insert-then-evict path without inserting 10,000+ rows.
#[cfg(test)]
async fn record_in_with_cap(
    pool: &SqlitePool,
    entry: NewHistoryEntry,
    max_rows: i64,
) -> Result<()> {
    record_in_with_policy(pool, entry, max_rows, 0).await
}

/// 行数上限と保持日数の両方を指定して挿入する (テスト用に値を差し替えられる)。
async fn record_in_with_policy(
    pool: &SqlitePool,
    entry: NewHistoryEntry,
    max_rows: i64,
    retention_days: i64,
) -> Result<()> {
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
    enforce_retention(pool, max_rows).await?;
    prune_expired(pool, retention_days).await?;
    Ok(())
}

/// `retention_days` 日より古い行を削除する (0 以下は何もしない)。削除した行数を返す。
/// 毎回の挿入で呼ばれるので、まず最古の行 (`id` 最小) が期限切れかだけを調べ、
/// 期限切れが無ければ全件走査しない。`executed_at` は RFC3339 (`+00:00`・小数桁可変)
/// なので、文字列比較ではなく `julianday` で時刻として比べる。解釈できない値の行は残す。
async fn prune_expired(pool: &SqlitePool, retention_days: i64) -> Result<u64> {
    if retention_days <= 0 {
        return Ok(0);
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
    // 時刻として解釈できない行 (`julianday` が NULL) は飛ばして、解釈できる最古の行を見る。
    // 先頭の壊れた行で判定が止まり、永久に削除されなくなるのを防ぐ。
    let oldest_expired: Option<i64> = sqlx::query_scalar(
        "SELECT julianday(executed_at) < julianday(?) FROM query_history
          WHERE julianday(executed_at) IS NOT NULL ORDER BY id LIMIT 1",
    )
    .bind(&cutoff)
    .fetch_optional(pool)
    .await?;
    if oldest_expired != Some(1) {
        return Ok(0);
    }
    let affected =
        sqlx::query("DELETE FROM query_history WHERE julianday(executed_at) < julianday(?)")
            .bind(&cutoff)
            .execute(pool)
            .await?
            .rows_affected();
    Ok(affected)
}

/// Deletes the oldest rows (by `id`, i.e. insertion order) beyond `max_rows`.
/// Cheap even run on every insert: `id` is the primary key, so the inner
/// `ORDER BY id DESC LIMIT` is an index-only scan bounded by `max_rows`.
async fn enforce_retention(pool: &SqlitePool, max_rows: i64) -> Result<()> {
    sqlx::query(
        "DELETE FROM query_history
            WHERE id NOT IN (
                SELECT id FROM query_history ORDER BY id DESC LIMIT ?
            )",
    )
    .bind(max_rows.max(1))
    .execute(pool)
    .await?;
    Ok(())
}

/// Lists history newest-first. When `profile_id` is `Some`, only that profile's
/// rows are returned; `search` does a case-insensitive substring match on the
/// SQL text. `status` filters to `"ok"` or `"error"` exactly. `from`/`to` are
/// RFC3339 timestamp bounds (inclusive) compared lexically against
/// `executed_at`, matching the storage format. `limit` caps the number of rows.
#[allow(clippy::too_many_arguments)]
pub async fn list(
    profile_id: Option<&str>,
    limit: i64,
    search: Option<&str>,
    status: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<HistoryEntry>> {
    list_in(pool().await?, profile_id, limit, search, status, from, to).await
}

/// 範囲境界を、SQL 側の `strftime('%Y-%m-%dT%H:%M:%f', executed_at)` と同じ固定形式
/// (UTC・ミリ秒) へ揃える。保存側は `+00:00` 付き・小数桁可変、フロントの境界は
/// `…000Z` と形式が違い、文字列のまま比較すると同一ミリ秒の境界がずれるため。
/// 解釈できない値はそのまま返す (結果が空になるだけ)。
fn normalize_bound(s: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(s) {
        Ok(dt) => dt
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%dT%H:%M:%S%.3f")
            .to_string(),
        Err(_) => s.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn list_in(
    pool: &SqlitePool,
    profile_id: Option<&str>,
    limit: i64,
    search: Option<&str>,
    status: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<HistoryEntry>> {
    // 一覧には SQL 全文を載せない (#1256)。要約に必要な先頭だけを substr で取り、
    // 全文の長さは length() で得る。
    let mut sql = format!(
        "SELECT id, profile_id, driver, \"database\",
                substr(\"sql\", 1, {PREVIEW_FETCH_CHARS}) AS sql_head,
                length(\"sql\") AS sql_len, \"rows\",
                rows_affected, elapsed_ms, status, error, executed_at
         FROM query_history"
    );
    let mut conds: Vec<&str> = Vec::new();
    if profile_id.is_some() {
        conds.push("profile_id = ?");
    }
    let like = search.map(|s| format!("%{}%", escape_like(s)));
    if like.is_some() {
        conds.push("\"sql\" LIKE ? ESCAPE '\\'");
    }
    if status.is_some() {
        conds.push("status = ?");
    }
    // 保存形式は `+00:00` 付き・小数桁可変の RFC3339、フロントの境界は `…000Z` で、
    // 文字列のままでは同一ミリ秒の境界がずれる。両側を `strftime` / `normalize_bound`
    // で UTC ミリ秒の固定形式に揃えて比較する (ORDER BY は保存形式の辞書順のまま)。
    if from.is_some() {
        conds.push("strftime('%Y-%m-%dT%H:%M:%f', executed_at) >= ?");
    }
    if to.is_some() {
        conds.push("strftime('%Y-%m-%dT%H:%M:%f', executed_at) <= ?");
    }
    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(" AND "));
    }
    sql.push_str(" ORDER BY executed_at DESC, id DESC LIMIT ?");

    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(pid) = profile_id {
        q = q.bind(pid.to_string());
    }
    if let Some(l) = like {
        q = q.bind(l);
    }
    if let Some(s) = status {
        q = q.bind(s.to_string());
    }
    if let Some(f) = from {
        q = q.bind(normalize_bound(f));
    }
    if let Some(t) = to {
        q = q.bind(normalize_bound(t));
    }
    q = q.bind(limit.max(1));

    let rows: Vec<SqliteRow> = q.fetch_all(pool).await?;
    let mut entries = Vec::with_capacity(rows.len());
    for r in &rows {
        let mut entry = row_to_entry(r);
        // 取得した先頭が途中で切れていて、畳んだ結果が上限に満たない (= 空白だらけの
        // SQL) ときだけ、正確な要約のために全文を取り直す。通常は発生しない。
        let head_chars = r
            .try_get::<String, _>("sql_head")
            .map(|h| h.chars().count() as i64)
            .unwrap_or(0);
        if entry.sql_len > head_chars
            && entry.sql_preview.chars().count() <= super::SQL_PREVIEW_CHARS
        {
            if let Some(full) = get_sql_in(pool, entry.id).await? {
                entry.sql_preview = super::sql_preview(&full);
            }
        }
        entries.push(entry);
    }
    Ok(entries)
}

/// 要約のために SQL の先頭から読む最大文字数。要約は空白を畳んだ先頭
/// [`super::SQL_PREVIEW_CHARS`] 文字なので、畳みで縮んでも足りる余裕を見て 4 倍読む。
const PREVIEW_FETCH_CHARS: usize = super::SQL_PREVIEW_CHARS * 4;

/// 履歴 1 件の SQL 全文を返す (`get_history_sql`)。無ければ `None`。
pub async fn get_sql(id: i64) -> Result<Option<String>> {
    get_sql_in(pool().await?, id).await
}

async fn get_sql_in(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<SqliteRow> = sqlx::query("SELECT \"sql\" FROM query_history WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|r| r.try_get::<String, _>("sql").ok()))
}

/// `profile_id` の直近の実行 SQL 全文を新しい順に返す (↑/↓ 履歴ナビ・コマンド
/// パレット用、#1256)。一覧 (`list`) と違い要約ではなく全文だが、メタデータを
/// 運ばないぶん軽い。`profile_id` が `None` なら全プロファイル。
pub async fn list_sqls(profile_id: Option<&str>, limit: i64) -> Result<Vec<String>> {
    list_sqls_in(pool().await?, profile_id, limit).await
}

async fn list_sqls_in(
    pool: &SqlitePool,
    profile_id: Option<&str>,
    limit: i64,
) -> Result<Vec<String>> {
    let sql = if profile_id.is_some() {
        "SELECT \"sql\" FROM query_history WHERE profile_id = ?
         ORDER BY executed_at DESC, id DESC LIMIT ?"
    } else {
        "SELECT \"sql\" FROM query_history ORDER BY executed_at DESC, id DESC LIMIT ?"
    };
    let mut q = sqlx::query(sql);
    if let Some(pid) = profile_id {
        q = q.bind(pid.to_string());
    }
    let rows: Vec<SqliteRow> = q.bind(limit.max(1)).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .map(|r| r.try_get::<String, _>("sql").unwrap_or_default())
        .collect())
}

/// Deletes history rows. `Some(profile_id)` clears just that profile; `None`
/// clears everything. Returns the number of rows removed.
pub async fn clear(profile_id: Option<&str>) -> Result<u64> {
    clear_in(pool().await?, profile_id).await
}

async fn clear_in(pool: &SqlitePool, profile_id: Option<&str>) -> Result<u64> {
    let affected = match profile_id {
        Some(pid) => sqlx::query("DELETE FROM query_history WHERE profile_id = ?")
            .bind(pid.to_string())
            .execute(pool)
            .await?
            .rows_affected(),
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
        sql_preview: super::sql_preview(&r.try_get::<String, _>("sql_head").unwrap_or_default()),
        sql_len: r.try_get("sql_len").unwrap_or_default(),
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

        let all = list_in(&pool, None, 100, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        // Newest executed_at first.
        assert_eq!(all[0].sql_preview, "SELECT 3");

        let p1 = list_in(&pool, Some("p1"), 100, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(p1.len(), 2);
        assert!(p1.iter().all(|e| e.profile_id.as_deref() == Some("p1")));
    }

    #[tokio::test]
    async fn searches_sql_text_literally() {
        let pool = temp_pool().await;
        record_in(
            &pool,
            entry("p1", "SELECT * FROM users", "2026-01-01T00:00:00Z"),
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry("p1", "SELECT * FROM orders", "2026-01-02T00:00:00Z"),
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry("p1", "SELECT a_b FROM t", "2026-01-03T00:00:00Z"),
        )
        .await
        .unwrap();

        let hits = list_in(&pool, None, 100, Some("users"), None, None, None)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].sql_preview, "SELECT * FROM users");

        // `_` must be matched literally, not as a wildcard.
        let underscore = list_in(&pool, None, 100, Some("a_b"), None, None, None)
            .await
            .unwrap();
        assert_eq!(underscore.len(), 1);
        assert_eq!(underscore[0].sql_preview, "SELECT a_b FROM t");
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
        assert_eq!(
            list_in(&pool, None, 100, None, None, None, None)
                .await
                .unwrap()
                .len(),
            1
        );

        let removed_all = clear_in(&pool, None).await.unwrap();
        assert_eq!(removed_all, 1);
        assert!(list_in(&pool, None, 100, None, None, None, None)
            .await
            .unwrap()
            .is_empty());
    }

    fn entry_with_status(profile: &str, sql: &str, at: &str, status: &str) -> NewHistoryEntry {
        let mut e = entry(profile, sql, at);
        e.status = status.to_string();
        e
    }

    #[tokio::test]
    async fn filters_by_status() {
        let pool = temp_pool().await;
        record_in(
            &pool,
            entry_with_status("p1", "SELECT 1", "2026-01-01T00:00:00Z", "ok"),
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry_with_status("p1", "SELECT 2", "2026-01-02T00:00:00Z", "error"),
        )
        .await
        .unwrap();
        record_in(
            &pool,
            entry_with_status("p1", "SELECT 3", "2026-01-03T00:00:00Z", "ok"),
        )
        .await
        .unwrap();

        let ok_only = list_in(&pool, None, 100, None, Some("ok"), None, None)
            .await
            .unwrap();
        assert_eq!(ok_only.len(), 2);
        assert!(ok_only.iter().all(|e| e.status == "ok"));

        let err_only = list_in(&pool, None, 100, None, Some("error"), None, None)
            .await
            .unwrap();
        assert_eq!(err_only.len(), 1);
        assert_eq!(err_only[0].sql_preview, "SELECT 2");
    }

    #[tokio::test]
    async fn filters_by_date_range() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "SELECT 1", "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p1", "SELECT 2", "2026-01-05T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p1", "SELECT 3", "2026-01-10T00:00:00Z"))
            .await
            .unwrap();

        // Inclusive lower bound only.
        let from_only = list_in(
            &pool,
            None,
            100,
            None,
            None,
            Some("2026-01-05T00:00:00Z"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(from_only.len(), 2);
        assert!(from_only.iter().all(|e| e.sql_preview != "SELECT 1"));

        // Inclusive upper bound only.
        let to_only = list_in(
            &pool,
            None,
            100,
            None,
            None,
            None,
            Some("2026-01-05T00:00:00Z"),
        )
        .await
        .unwrap();
        assert_eq!(to_only.len(), 2);
        assert!(to_only.iter().all(|e| e.sql_preview != "SELECT 3"));

        // Both bounds narrow to the single row in between (inclusive on the
        // exact boundary value too).
        let both = list_in(
            &pool,
            None,
            100,
            None,
            None,
            Some("2026-01-05T00:00:00Z"),
            Some("2026-01-05T00:00:00Z"),
        )
        .await
        .unwrap();
        assert_eq!(both.len(), 1);
        assert_eq!(both[0].sql_preview, "SELECT 2");
    }

    #[tokio::test]
    async fn record_in_evicts_oldest_rows_past_the_cap() {
        let pool = temp_pool().await;
        // Exercise the real record path (insert-then-evict) with a small cap
        // instead of the production 10_000, so the test stays fast.
        for i in 0..5 {
            record_in_with_cap(
                &pool,
                entry(
                    "p1",
                    &format!("SELECT {i}"),
                    &format!("2026-01-01T00:00:{i:02}Z"),
                ),
                3,
            )
            .await
            .unwrap();
        }

        let remaining = list_in(&pool, None, 100, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 3);
        let sqls: Vec<&str> = remaining.iter().map(|e| e.sql_preview.as_str()).collect();
        // The two oldest (by insertion order / id) were evicted; the three
        // most recently inserted survive.
        assert!(!sqls.contains(&"SELECT 0"));
        assert!(!sqls.contains(&"SELECT 1"));
        assert!(sqls.contains(&"SELECT 2"));
        assert!(sqls.contains(&"SELECT 3"));
        assert!(sqls.contains(&"SELECT 4"));
    }

    #[tokio::test]
    async fn record_in_never_evicts_when_under_the_cap() {
        let pool = temp_pool().await;
        for i in 0..3 {
            record_in_with_cap(
                &pool,
                entry(
                    "p1",
                    &format!("SELECT {i}"),
                    &format!("2026-01-01T00:00:{i:02}Z"),
                ),
                10,
            )
            .await
            .unwrap();
        }
        let remaining = list_in(&pool, None, 100, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 3);
    }
    #[tokio::test]
    async fn list_returns_a_collapsed_preview_and_the_full_length_not_the_body() {
        let pool = temp_pool().await;
        let body = format!("SELECT\n  {}\nFROM t", "col, ".repeat(2000));
        record_in(&pool, entry("p1", &body, "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        let got = list_in(&pool, None, 10, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        // 先頭 400 文字に畳まれ、末尾は省略記号。
        assert_eq!(
            got[0].sql_preview.chars().count(),
            super::super::SQL_PREVIEW_CHARS + 1
        );
        assert!(got[0].sql_preview.starts_with("SELECT col, col,"));
        assert!(got[0].sql_preview.ends_with('…'));
        assert_eq!(got[0].sql_len, body.chars().count() as i64);
    }

    #[tokio::test]
    async fn preview_of_a_whitespace_heavy_sql_is_still_exact() {
        let pool = temp_pool().await;
        // 先頭 4 倍ぶんの読み出しがほぼ空白で埋まっても、要約は正確 (全文を取り直す)。
        let body = format!("SELECT{}1", " ".repeat(PREVIEW_FETCH_CHARS + 50));
        record_in(&pool, entry("p1", &body, "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        let got = list_in(&pool, None, 10, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(got[0].sql_preview, "SELECT 1");
    }

    #[tokio::test]
    async fn get_sql_and_list_sqls_return_full_text() {
        let pool = temp_pool().await;
        let long = format!("SELECT {}", "x".repeat(5000));
        record_in(&pool, entry("p1", &long, "2026-01-01T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p1", "SELECT 2", "2026-01-02T00:00:00Z"))
            .await
            .unwrap();
        record_in(&pool, entry("p2", "SELECT 3", "2026-01-03T00:00:00Z"))
            .await
            .unwrap();
        let listed = list_in(&pool, Some("p1"), 10, None, None, None, None)
            .await
            .unwrap();
        let old = listed.iter().find(|e| e.sql_len > 5000).unwrap();
        assert_eq!(
            get_sql_in(&pool, old.id).await.unwrap().as_deref(),
            Some(long.as_str())
        );
        assert_eq!(get_sql_in(&pool, 9999).await.unwrap(), None);

        let sqls = list_sqls_in(&pool, Some("p1"), 10).await.unwrap();
        assert_eq!(sqls, vec!["SELECT 2".to_string(), long]);
        assert_eq!(
            list_sqls_in(&pool, None, 1).await.unwrap(),
            vec!["SELECT 3"]
        );
    }

    // 保存形式 (`+00:00`・小数桁可変) とフロントの境界 (`…000Z`) が違っても、
    // 同一ミリ秒の境界は両端とも含まれ、直後のサブミリ秒は to に含まれない。
    #[tokio::test]
    async fn date_bounds_compare_across_formats() {
        let pool = temp_pool().await;
        record_in(&pool, entry("p1", "SELECT 1", "2026-01-05T00:00:00+00:00"))
            .await
            .unwrap();
        record_in(
            &pool,
            entry("p1", "SELECT 2", "2026-01-05T00:00:00.123456+00:00"),
        )
        .await
        .unwrap();

        let from = list_in(
            &pool,
            None,
            100,
            None,
            None,
            Some("2026-01-05T00:00:00.000Z"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(from.len(), 2);

        let to = list_in(
            &pool,
            None,
            100,
            None,
            None,
            None,
            Some("2026-01-05T00:00:00.000Z"),
        )
        .await
        .unwrap();
        assert_eq!(to.len(), 1);
        assert_eq!(to[0].sql_preview, "SELECT 1");
    }

    #[tokio::test]
    async fn retention_days_prunes_old_rows_on_insert() {
        let pool = temp_pool().await;
        let now = chrono::Utc::now();
        let old = (now - chrono::Duration::days(40)).to_rfc3339();
        let recent = (now - chrono::Duration::days(5)).to_rfc3339();
        // 保持日数 0 (無効) の間は古い行も残る。
        record_in_with_policy(&pool, entry("p", "old", &old), 100, 0)
            .await
            .unwrap();
        record_in_with_policy(&pool, entry("p", "recent", &recent), 100, 0)
            .await
            .unwrap();
        assert_eq!(
            list_in(&pool, None, 10, None, None, None, None)
                .await
                .unwrap()
                .len(),
            2
        );
        // 30 日にして挿入すると 40 日前の行だけが消える。
        record_in_with_policy(&pool, entry("p", "new", &now.to_rfc3339()), 100, 30)
            .await
            .unwrap();
        let rows = list_in(&pool, None, 10, None, None, None, None)
            .await
            .unwrap();
        let sqls: Vec<_> = rows.iter().map(|r| r.sql_preview.as_str()).collect();
        assert_eq!(sqls, vec!["new", "recent"]);
    }

    #[tokio::test]
    async fn prune_expired_returns_deleted_count_and_keeps_unparsable_rows() {
        let pool = temp_pool().await;
        let now = chrono::Utc::now();
        for (sql, at) in [
            // 先頭が解釈できない行でも、後ろの期限切れの行は消える。
            ("z", "garbage".to_string()),
            ("a", (now - chrono::Duration::days(100)).to_rfc3339()),
            ("b", (now - chrono::Duration::days(99)).to_rfc3339()),
            ("c", "not-a-date".to_string()),
            ("d", now.to_rfc3339()),
        ] {
            record_in_with_policy(&pool, entry("p", sql, &at), 100, 0)
                .await
                .unwrap();
        }
        assert_eq!(prune_expired(&pool, 0).await.unwrap(), 0, "0 は無効");
        assert_eq!(prune_expired(&pool, 30).await.unwrap(), 2);
        assert_eq!(
            prune_expired(&pool, 30).await.unwrap(),
            0,
            "2 回目は何も消さない"
        );
        let left = list_in(&pool, None, 10, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(left.len(), 3);
    }

    #[tokio::test]
    async fn retention_setting_round_trips_through_history_settings() {
        let pool = temp_pool().await;
        assert_eq!(load_retention_days(&pool).await.unwrap(), 0);
        store_retention_days(&pool, 45).await.unwrap();
        store_retention_days(&pool, 60).await.unwrap();
        assert_eq!(load_retention_days(&pool).await.unwrap(), 60);
        // 範囲外の保存値は丸める。
        store_retention_days(&pool, 999_999).await.unwrap();
        assert_eq!(
            load_retention_days(&pool).await.unwrap(),
            MAX_RETENTION_DAYS
        );
    }
}
