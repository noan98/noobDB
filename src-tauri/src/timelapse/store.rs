//! テーブル・タイムラプス (#739) のローカル専用ストア
//! (`<data_dir>/table_timelapse.sqlite`)。
//!
//! `flight_recorder::store` と同じく初回利用時に遅延オープンし、マイグレーション
//! 手順を持たない (`CREATE TABLE IF NOT EXISTS`)。各関数は `*_in(pool, ...)` に
//! 本体を切り出し、テストはインメモリ SQLite に対して直接呼ぶ (実データ
//! ディレクトリに触れない)。

use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use tokio::sync::{Mutex, OnceCell};

use super::{fingerprint, GenerationMeta, Snapshot, TableWatch, MAX_TOTAL_BYTES};
use crate::db::types::Value;
use crate::error::{AppError, Result};
use crate::history::store::data_dir;

static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

/// 世代の記録 (直前世代との比較 → 追加 → ローテーション) を直列化するロック。
/// 接続時の自動取得と手動更新が同時に走っても、同一内容の世代が 2 つ積まれない
/// ようにする。
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

fn store_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("table_timelapse.sqlite"))
}

async fn pool() -> Result<&'static SqlitePool> {
    POOL.get_or_try_init(|| async {
        let path = store_path()?;
        let connect = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(connect)
            .await
            .map_err(|e| {
                tracing::error!(path = %path.display(), error = %e, "timelapse: failed to open database");
                e
            })?;
        init_schema(&pool).await?;
        restrict_permissions(&path);
        Ok(pool)
    })
    .await
}

/// Unix ではファイルを所有者のみ (`0600`) に絞る。スナップショットは実データの
/// ローカルコピーなので `flight_recorder.sqlite` と同じ多層防御を掛ける。失敗しても
/// 起動は止めない (ログのみ)。
fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(path = %path.display(), error = %e, "timelapse: failed to restrict file permissions");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS watch (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id  TEXT NOT NULL,
            driver      TEXT NOT NULL,
            \"database\"  TEXT NOT NULL,
            table_name  TEXT NOT NULL,
            active      INTEGER NOT NULL DEFAULT 1,
            partial     INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            UNIQUE (profile_id, \"database\", table_name)
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS generation (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id     INTEGER NOT NULL REFERENCES watch(id) ON DELETE CASCADE,
            captured_at  TEXT NOT NULL,
            fingerprint  TEXT NOT NULL,
            columns      TEXT NOT NULL,
            column_types TEXT NOT NULL,
            primary_key  TEXT NOT NULL,
            rows_json    TEXT NOT NULL,
            row_count    INTEGER NOT NULL,
            truncated    INTEGER NOT NULL,
            bytes        INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_generation_watch ON generation(watch_id, id DESC)")
        .execute(pool)
        .await?;
    Ok(())
}

/// 自動取得の対象 (アクティブなウォッチ) 1 件。
#[derive(Debug, Clone)]
pub struct WatchTarget {
    pub id: i64,
    pub database: String,
    pub table: String,
}

/// 保存済み世代の中身 (差分計算用)。
#[derive(Debug, Clone)]
pub struct StoredGeneration {
    pub watch_id: i64,
    pub driver: String,
    pub table: String,
    pub captured_at: String,
    pub snapshot: Snapshot,
}

// ── 公開 API (実ストア) ──

pub async fn upsert_watch(
    profile_id: &str,
    driver: &str,
    database: &str,
    table: &str,
    partial: bool,
) -> Result<i64> {
    upsert_watch_in(pool().await?, profile_id, driver, database, table, partial).await
}

pub async fn list_watches(profile_id: &str) -> Result<Vec<TableWatch>> {
    list_watches_in(pool().await?, profile_id).await
}

pub async fn active_watches(profile_id: &str) -> Result<Vec<WatchTarget>> {
    active_watches_in(pool().await?, profile_id).await
}

pub async fn record_generation(
    watch_id: i64,
    snapshot: &Snapshot,
    max_generations: usize,
) -> Result<bool> {
    let captured_at = chrono::Utc::now().to_rfc3339();
    record_generation_in(
        pool().await?,
        watch_id,
        snapshot,
        &captured_at,
        max_generations,
        MAX_TOTAL_BYTES,
    )
    .await
}

pub async fn load_generation(id: i64) -> Result<StoredGeneration> {
    load_generation_in(pool().await?, id).await
}

pub async fn unwatch(watch_id: i64, delete_data: bool) -> Result<()> {
    unwatch_in(pool().await?, watch_id, delete_data).await
}

pub async fn clear_all() -> Result<u64> {
    clear_all_in(pool().await?).await
}

// ── 本体 (プール注入) ──

async fn upsert_watch_in(
    pool: &SqlitePool,
    profile_id: &str,
    driver: &str,
    database: &str,
    table: &str,
    partial: bool,
) -> Result<i64> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO watch (profile_id, driver, \"database\", table_name, active, partial, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (profile_id, \"database\", table_name)
         DO UPDATE SET active = 1, partial = excluded.partial, driver = excluded.driver
         RETURNING id",
    )
    .bind(profile_id)
    .bind(driver)
    .bind(database)
    .bind(table)
    .bind(partial)
    .bind(chrono::Utc::now().to_rfc3339())
    .fetch_one(pool)
    .await?;
    Ok(id)
}

async fn list_watches_in(pool: &SqlitePool, profile_id: &str) -> Result<Vec<TableWatch>> {
    let rows = sqlx::query(
        "SELECT id, profile_id, driver, \"database\", table_name, active, partial, created_at
           FROM watch WHERE profile_id = ? ORDER BY \"database\", table_name",
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let id: i64 = r.try_get("id")?;
        let gens = sqlx::query(
            "SELECT id, captured_at, row_count, truncated, bytes
               FROM generation WHERE watch_id = ? ORDER BY id DESC",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let mut generations = Vec::with_capacity(gens.len());
        for g in gens {
            generations.push(GenerationMeta {
                id: g.try_get("id")?,
                captured_at: g.try_get("captured_at")?,
                row_count: g.try_get::<i64, _>("row_count")?.max(0) as usize,
                truncated: g.try_get("truncated")?,
                bytes: g.try_get::<i64, _>("bytes")?.max(0) as u64,
            });
        }
        out.push(TableWatch {
            id,
            profile_id: r.try_get("profile_id")?,
            driver: r.try_get("driver")?,
            database: r.try_get("database")?,
            table: r.try_get("table_name")?,
            active: r.try_get("active")?,
            partial: r.try_get("partial")?,
            created_at: r.try_get("created_at")?,
            generations,
        });
    }
    Ok(out)
}

async fn active_watches_in(pool: &SqlitePool, profile_id: &str) -> Result<Vec<WatchTarget>> {
    let rows = sqlx::query(
        "SELECT id, \"database\", table_name FROM watch
          WHERE profile_id = ? AND active = 1 ORDER BY id",
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(WatchTarget {
                id: r.try_get("id")?,
                database: r.try_get("database")?,
                table: r.try_get("table_name")?,
            })
        })
        .collect()
}

/// 世代を 1 つ記録する。直前世代とフィンガープリントが同じなら何もせず `false`。
/// 追加したらウォッチ単位の世代数ローテーションと全体の容量上限を適用して `true`。
async fn record_generation_in(
    pool: &SqlitePool,
    watch_id: i64,
    snapshot: &Snapshot,
    captured_at: &str,
    max_generations: usize,
    max_total_bytes: u64,
) -> Result<bool> {
    let _guard = WRITE_LOCK.lock().await;
    let rows_json = serde_json::to_string(&snapshot.rows)?;
    let fp = fingerprint(&snapshot.columns, &rows_json);
    let last: Option<String> = sqlx::query_scalar(
        "SELECT fingerprint FROM generation WHERE watch_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(watch_id)
    .fetch_optional(pool)
    .await?;
    if last.as_deref() == Some(fp.as_str()) {
        return Ok(false);
    }
    let columns = serde_json::to_string(&snapshot.columns)?;
    let column_types = serde_json::to_string(&snapshot.column_types)?;
    let primary_key = serde_json::to_string(&snapshot.primary_key)?;
    let bytes = (rows_json.len() + columns.len() + column_types.len() + primary_key.len()) as i64;
    sqlx::query(
        "INSERT INTO generation
            (watch_id, captured_at, fingerprint, columns, column_types, primary_key,
             rows_json, row_count, truncated, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(watch_id)
    .bind(captured_at)
    .bind(&fp)
    .bind(columns)
    .bind(column_types)
    .bind(primary_key)
    .bind(rows_json)
    .bind(snapshot.rows.len() as i64)
    .bind(snapshot.truncated)
    .bind(bytes)
    .execute(pool)
    .await?;

    // ウォッチ単位のローテーション (新しい順に max_generations 件を残す)。
    sqlx::query(
        "DELETE FROM generation WHERE watch_id = ? AND id NOT IN (
            SELECT id FROM generation WHERE watch_id = ? ORDER BY id DESC LIMIT ?
         )",
    )
    .bind(watch_id)
    .bind(watch_id)
    .bind(max_generations.max(1) as i64)
    .execute(pool)
    .await?;

    enforce_total_bytes(pool, max_total_bytes).await?;
    Ok(true)
}

async fn total_bytes(pool: &SqlitePool) -> Result<u64> {
    let total: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(bytes), 0) FROM generation")
        .fetch_one(pool)
        .await?;
    Ok(total.max(0) as u64)
}

/// 全ウォッチ合計の保存量が上限を超えていれば、古い世代から 1 件ずつ削除する。
/// 各ウォッチの**最新世代は削除しない** (次回取得時の「同一なら増やさない」比較と、
/// 最低限の閲覧のため)。
async fn enforce_total_bytes(pool: &SqlitePool, max_total_bytes: u64) -> Result<()> {
    let mut evicted = false;
    while total_bytes(pool).await? > max_total_bytes {
        let deleted = sqlx::query(
            "DELETE FROM generation WHERE id = (
                SELECT id FROM generation
                 WHERE id NOT IN (SELECT MAX(id) FROM generation GROUP BY watch_id)
                 ORDER BY id ASC LIMIT 1
             )",
        )
        .execute(pool)
        .await?
        .rows_affected();
        if deleted == 0 {
            break;
        }
        evicted = true;
    }
    if evicted {
        vacuum(pool).await;
    }
    Ok(())
}

async fn vacuum(pool: &SqlitePool) {
    if let Err(e) = sqlx::query("VACUUM").execute(pool).await {
        tracing::warn!(error = %e, "timelapse: VACUUM failed");
    }
}

async fn load_generation_in(pool: &SqlitePool, id: i64) -> Result<StoredGeneration> {
    let r = sqlx::query(
        "SELECT g.watch_id, g.captured_at, g.columns, g.column_types, g.primary_key,
                g.rows_json, g.truncated, w.driver, w.table_name
           FROM generation g JOIN watch w ON w.id = g.watch_id
          WHERE g.id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::InvalidInput(format!("timelapse generation {id} not found")))?;
    let columns: Vec<String> = serde_json::from_str(&r.try_get::<String, _>("columns")?)?;
    let column_types: Vec<String> = serde_json::from_str(&r.try_get::<String, _>("column_types")?)?;
    let primary_key: Vec<String> = serde_json::from_str(&r.try_get::<String, _>("primary_key")?)?;
    let rows: Vec<Vec<Value>> = serde_json::from_str(&r.try_get::<String, _>("rows_json")?)?;
    Ok(StoredGeneration {
        watch_id: r.try_get("watch_id")?,
        driver: r.try_get("driver")?,
        table: r.try_get("table_name")?,
        captured_at: r.try_get("captured_at")?,
        snapshot: Snapshot {
            columns,
            column_types,
            primary_key,
            rows,
            truncated: r.try_get("truncated")?,
        },
    })
}

/// ウォッチを解除する。`delete_data` なら世代ごと削除し、そうでなければ自動取得の
/// 対象から外すだけ (保存済み世代は閲覧できるまま残る)。
async fn unwatch_in(pool: &SqlitePool, watch_id: i64, delete_data: bool) -> Result<()> {
    if delete_data {
        sqlx::query("DELETE FROM generation WHERE watch_id = ?")
            .bind(watch_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM watch WHERE id = ?")
            .bind(watch_id)
            .execute(pool)
            .await?;
        vacuum(pool).await;
    } else {
        sqlx::query("UPDATE watch SET active = 0 WHERE id = ?")
            .bind(watch_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// 全ウォッチ・全世代を削除する (設定画面の一括削除)。削除した世代数を返す。
async fn clear_all_in(pool: &SqlitePool) -> Result<u64> {
    let n = sqlx::query("DELETE FROM generation")
        .execute(pool)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM watch").execute(pool).await?;
    vacuum(pool).await;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn snap(price: i64) -> Snapshot {
        Snapshot {
            columns: vec!["id".into(), "price".into()],
            column_types: vec!["INTEGER".into(), "INTEGER".into()],
            primary_key: vec!["id".into()],
            rows: vec![vec![Value::Int(1), Value::Int(price)]],
            truncated: false,
        }
    }

    async fn record(pool: &SqlitePool, w: i64, s: &Snapshot, max_gen: usize) -> bool {
        record_generation_in(pool, w, s, "2026-01-01T00:00:00Z", max_gen, MAX_TOTAL_BYTES)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn identical_content_does_not_add_a_generation() {
        let pool = temp_pool().await;
        let w = upsert_watch_in(&pool, "p", "sqlite", "main", "fees", false)
            .await
            .unwrap();
        assert!(record(&pool, w, &snap(100), 10).await);
        assert!(!record(&pool, w, &snap(100), 10).await);
        assert!(record(&pool, w, &snap(200), 10).await);
        // A → B → A は「直前と同じ」ではないので世代が増える。
        assert!(record(&pool, w, &snap(100), 10).await);
        let watches = list_watches_in(&pool, "p").await.unwrap();
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0].generations.len(), 3);
    }

    #[tokio::test]
    async fn generations_rotate_per_watch() {
        let pool = temp_pool().await;
        let w = upsert_watch_in(&pool, "p", "sqlite", "main", "fees", false)
            .await
            .unwrap();
        let other = upsert_watch_in(&pool, "p", "sqlite", "main", "flags", false)
            .await
            .unwrap();
        record(&pool, other, &snap(1), 3).await;
        for price in 0..6 {
            record(&pool, w, &snap(price), 3).await;
        }
        let watches = list_watches_in(&pool, "p").await.unwrap();
        let fees = watches.iter().find(|x| x.table == "fees").unwrap();
        let flags = watches.iter().find(|x| x.table == "flags").unwrap();
        assert_eq!(fees.generations.len(), 3);
        assert_eq!(flags.generations.len(), 1);
        // 新しい順に並び、残っているのは最新 3 世代。
        let newest = load_generation_in(&pool, fees.generations[0].id)
            .await
            .unwrap();
        assert_eq!(newest.snapshot.rows[0][1], Value::Int(5));
    }

    #[tokio::test]
    async fn total_byte_cap_evicts_oldest_but_keeps_latest_per_watch() {
        let pool = temp_pool().await;
        let a = upsert_watch_in(&pool, "p", "sqlite", "main", "a", false)
            .await
            .unwrap();
        let b = upsert_watch_in(&pool, "p", "sqlite", "main", "b", false)
            .await
            .unwrap();
        for price in 0..4 {
            record_generation_in(&pool, a, &snap(price), "t", 10, u64::MAX)
                .await
                .unwrap();
        }
        // 極小の上限で b を記録 → a の古い世代は消えるが、a・b の最新世代は残る。
        record_generation_in(&pool, b, &snap(9), "t", 10, 1)
            .await
            .unwrap();
        let watches = list_watches_in(&pool, "p").await.unwrap();
        for w in &watches {
            assert_eq!(w.generations.len(), 1, "{}", w.table);
        }
        let latest_a = load_generation_in(&pool, watches[0].generations[0].id)
            .await
            .unwrap();
        assert_eq!(latest_a.snapshot.rows[0][1], Value::Int(3));
    }

    #[tokio::test]
    async fn unwatch_keeps_or_deletes_data_and_clear_all_wipes_everything() {
        let pool = temp_pool().await;
        let a = upsert_watch_in(&pool, "p", "sqlite", "main", "a", false)
            .await
            .unwrap();
        let b = upsert_watch_in(&pool, "p", "sqlite", "main", "b", false)
            .await
            .unwrap();
        record(&pool, a, &snap(1), 10).await;
        record(&pool, b, &snap(1), 10).await;

        unwatch_in(&pool, a, false).await.unwrap();
        let watches = list_watches_in(&pool, "p").await.unwrap();
        let wa = watches.iter().find(|w| w.id == a).unwrap();
        assert!(!wa.active);
        assert_eq!(wa.generations.len(), 1);
        let active = active_watches_in(&pool, "p").await.unwrap();
        assert_eq!(active.iter().map(|w| w.id).collect::<Vec<_>>(), vec![b]);

        // 再登録で再アクティブ化され、同じ ID を使い続ける。
        let again = upsert_watch_in(&pool, "p", "sqlite", "main", "a", true)
            .await
            .unwrap();
        assert_eq!(again, a);

        unwatch_in(&pool, b, true).await.unwrap();
        let watches = list_watches_in(&pool, "p").await.unwrap();
        assert!(watches.iter().all(|w| w.id != b));

        assert_eq!(clear_all_in(&pool).await.unwrap(), 1);
        assert!(list_watches_in(&pool, "p").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn watches_are_scoped_per_profile_and_load_round_trips() {
        let pool = temp_pool().await;
        let w = upsert_watch_in(&pool, "p1", "postgres", "db", "t", false)
            .await
            .unwrap();
        upsert_watch_in(&pool, "p2", "postgres", "db", "t", false)
            .await
            .unwrap();
        record(&pool, w, &snap(7), 10).await;
        let p1 = list_watches_in(&pool, "p1").await.unwrap();
        assert_eq!(p1.len(), 1);
        let gen = load_generation_in(&pool, p1[0].generations[0].id)
            .await
            .unwrap();
        assert_eq!(gen.watch_id, w);
        assert_eq!(gen.driver, "postgres");
        assert_eq!(gen.table, "t");
        assert_eq!(gen.snapshot, snap(7));
        assert!(load_generation_in(&pool, 9999).await.is_err());
    }
}
