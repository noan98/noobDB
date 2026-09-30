//! 実行計画ウォッチ (#743 / #1260) のローカル専用ストア (`<data_dir>/plan_watch.sqlite`)。
//!
//! `timelapse::store` と同じく初回利用時に遅延オープンし、マイグレーション手順を
//! 持たない (`CREATE TABLE IF NOT EXISTS`)。各関数は `*_in(pool, ...)` に本体を
//! 切り出し、テストはインメモリ SQLite に対して直接呼ぶ。保存するのは EXPLAIN の
//! 計画ペイロード (実データは含まない) のみ。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use tokio::sync::{Mutex, OnceCell};

use super::{ops_from_payload, plan_fingerprint, PayloadKind, MAX_GENERATIONS};
use crate::error::{AppError, Result};
use crate::history::store::data_dir;

static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

/// 世代の記録 (直前世代との比較 → 追加 → ローテーション) を直列化するロック。
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

fn store_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("plan_watch.sqlite"))
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
                tracing::error!(path = %path.display(), error = %e, "plan_watch: failed to open database");
                e
            })?;
        init_schema(&pool).await?;
        Ok(pool)
    })
    .await
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS watch (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id  TEXT NOT NULL,
            snippet_id  TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            UNIQUE (profile_id, snippet_id)
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS generation (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id      INTEGER NOT NULL REFERENCES watch(id) ON DELETE CASCADE,
            captured_at   TEXT NOT NULL,
            driver        TEXT NOT NULL,
            payload_kind  TEXT NOT NULL,
            payload       TEXT NOT NULL,
            fingerprint   TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_plan_generation_watch ON generation(watch_id, id DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// 保存済みの計画 1 世代 (フロントの `PlanGeneration` と同じ camelCase)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGeneration {
    /// ストア内の世代 ID (ワイヤでは文字列)。取り込み時の入力では使わない。
    #[serde(default)]
    pub id: String,
    /// 取得時刻 (RFC 3339 / ISO 8601)。
    pub captured_at: String,
    /// `mysql` / `postgres` / `sqlite`。
    pub driver: String,
    pub payload_kind: PayloadKind,
    pub payload: String,
    /// 構造フィンガープリント (dedupe 用)。取り込み時は Rust 側で計算し直す。
    #[serde(default)]
    pub fingerprint: String,
}

/// ウォッチ登録 1 件と、その世代 (新しい順)。エントリの存在 = ウォッチ登録済み。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    pub snippet_id: String,
    pub generations: Vec<PlanGeneration>,
}

/// [`record`] の結果。
#[derive(Debug, Clone, PartialEq)]
pub struct RecordOutcome {
    /// 新しい世代として追加されたか (未ウォッチ・同一計画なら false)。
    pub added: bool,
    /// 追加時の直前世代 (初回取得なら `None`)。変化検知の比較相手。
    pub prev: Option<PlanGeneration>,
}

// ── 公開 API (実ストア) ──

pub async fn list(profile_id: &str) -> Result<Vec<WatchEntry>> {
    list_in(pool().await?, profile_id).await
}

pub async fn watched_ids(profile_id: &str) -> Result<Vec<String>> {
    watched_ids_in(pool().await?, profile_id).await
}

pub async fn set_watched(profile_id: &str, snippet_id: &str, watched: bool) -> Result<()> {
    set_watched_in(pool().await?, profile_id, snippet_id, watched).await
}

pub async fn record(
    profile_id: &str,
    snippet_id: &str,
    driver: &str,
    payload_kind: PayloadKind,
    payload: &str,
    fingerprint: &str,
) -> Result<RecordOutcome> {
    let captured_at = chrono::Utc::now().to_rfc3339();
    record_in(
        pool().await?,
        profile_id,
        snippet_id,
        NewGeneration {
            captured_at: &captured_at,
            driver,
            payload_kind,
            payload,
            fingerprint,
        },
        MAX_GENERATIONS,
    )
    .await
}

/// 削除したスニペットのウォッチと世代を全プロファイルから取り除く。削除した
/// ウォッチ数を返す。
pub async fn delete_snippet(snippet_id: &str) -> Result<u64> {
    delete_snippet_in(pool().await?, snippet_id).await
}

pub async fn import_legacy(profile_id: &str, watches: Vec<WatchEntry>) -> Result<usize> {
    import_legacy_in(pool().await?, profile_id, watches).await
}

// ── 本体 (プール注入) ──

struct NewGeneration<'a> {
    captured_at: &'a str,
    driver: &'a str,
    payload_kind: PayloadKind,
    payload: &'a str,
    fingerprint: &'a str,
}

fn generation_from_row(r: &sqlx::sqlite::SqliteRow) -> Result<PlanGeneration> {
    let id: i64 = r.try_get("id")?;
    let kind: String = r.try_get("payload_kind")?;
    Ok(PlanGeneration {
        id: id.to_string(),
        captured_at: r.try_get("captured_at")?,
        driver: r.try_get("driver")?,
        payload_kind: PayloadKind::parse(&kind)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown plan payload kind '{kind}'")))?,
        payload: r.try_get("payload")?,
        fingerprint: r.try_get("fingerprint")?,
    })
}

async fn list_in(pool: &SqlitePool, profile_id: &str) -> Result<Vec<WatchEntry>> {
    let watches = sqlx::query("SELECT id, snippet_id FROM watch WHERE profile_id = ? ORDER BY id")
        .bind(profile_id)
        .fetch_all(pool)
        .await?;
    // 世代は 1 クエリでまとめて取り、ウォッチごとに振り分ける (N+1 を避ける)。
    let gens = sqlx::query(
        "SELECT g.watch_id AS watch_id, g.id AS id, g.captured_at AS captured_at,
                g.driver AS driver, g.payload_kind AS payload_kind,
                g.payload AS payload, g.fingerprint AS fingerprint
           FROM generation g JOIN watch w ON w.id = g.watch_id
          WHERE w.profile_id = ? ORDER BY g.id DESC",
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await?;
    let mut by_watch: std::collections::HashMap<i64, Vec<PlanGeneration>> =
        std::collections::HashMap::new();
    for g in &gens {
        by_watch
            .entry(g.try_get("watch_id")?)
            .or_default()
            .push(generation_from_row(g)?);
    }
    watches
        .iter()
        .map(|w| {
            let id: i64 = w.try_get("id")?;
            Ok(WatchEntry {
                snippet_id: w.try_get("snippet_id")?,
                generations: by_watch.remove(&id).unwrap_or_default(),
            })
        })
        .collect()
}

async fn watched_ids_in(pool: &SqlitePool, profile_id: &str) -> Result<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT snippet_id FROM watch WHERE profile_id = ? ORDER BY id")
            .bind(profile_id)
            .fetch_all(pool)
            .await?,
    )
}

/// ウォッチの登録 / 解除。解除時は蓄積した世代ごと削除する (実データ由来の計画 JSON を
/// ローカルに残さない)。登録済みへの登録、未登録への解除は何もしない。
async fn set_watched_in(
    pool: &SqlitePool,
    profile_id: &str,
    snippet_id: &str,
    watched: bool,
) -> Result<()> {
    let _guard = WRITE_LOCK.lock().await;
    if watched {
        sqlx::query(
            "INSERT OR IGNORE INTO watch (profile_id, snippet_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(profile_id)
        .bind(snippet_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
    } else {
        sqlx::query("DELETE FROM watch WHERE profile_id = ? AND snippet_id = ?")
            .bind(profile_id)
            .bind(snippet_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn watch_id_in(pool: &SqlitePool, profile_id: &str, snippet_id: &str) -> Result<Option<i64>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM watch WHERE profile_id = ? AND snippet_id = ?")
            .bind(profile_id)
            .bind(snippet_id)
            .fetch_optional(pool)
            .await?,
    )
}

async fn insert_generation_in(
    pool: &SqlitePool,
    watch_id: i64,
    g: &NewGeneration<'_>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO generation (watch_id, captured_at, driver, payload_kind, payload, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(watch_id)
    .bind(g.captured_at)
    .bind(g.driver)
    .bind(g.payload_kind.as_str())
    .bind(g.payload)
    .bind(g.fingerprint)
    .execute(pool)
    .await?;
    Ok(())
}

/// 取得した計画を世代として記録する。未ウォッチのスニペット (更新中に解除された
/// ものを含む) には何もしない。最新世代とフィンガープリントが同一なら世代を増やさず、
/// 異なるときだけ追加して `max_generations` でローテーションする。
async fn record_in(
    pool: &SqlitePool,
    profile_id: &str,
    snippet_id: &str,
    generation: NewGeneration<'_>,
    max_generations: usize,
) -> Result<RecordOutcome> {
    let _guard = WRITE_LOCK.lock().await;
    let Some(watch_id) = watch_id_in(pool, profile_id, snippet_id).await? else {
        return Ok(RecordOutcome {
            added: false,
            prev: None,
        });
    };
    let prev = sqlx::query(
        "SELECT id, captured_at, driver, payload_kind, payload, fingerprint
           FROM generation WHERE watch_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(watch_id)
    .fetch_optional(pool)
    .await?
    .map(|r| generation_from_row(&r))
    .transpose()?;
    if prev
        .as_ref()
        .is_some_and(|p| p.fingerprint == generation.fingerprint)
    {
        return Ok(RecordOutcome {
            added: false,
            prev: None,
        });
    }
    insert_generation_in(pool, watch_id, &generation).await?;
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
    Ok(RecordOutcome { added: true, prev })
}

async fn delete_snippet_in(pool: &SqlitePool, snippet_id: &str) -> Result<u64> {
    let _guard = WRITE_LOCK.lock().await;
    let res = sqlx::query("DELETE FROM watch WHERE snippet_id = ?")
        .bind(snippet_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// 旧 localStorage のウォッチ (世代は新しい順) を取り込む。既にストアでウォッチ済みの
/// スニペットは触らない (冪等)。フィンガープリントは Rust 側の正規化で計算し直す —
/// そうしないと移行直後の最初の更新が「内容は同じなのにフィンガープリントが違う」と
/// 判定されて余計な世代を積んでしまう。取り込んだウォッチ数を返す。
async fn import_legacy_in(
    pool: &SqlitePool,
    profile_id: &str,
    watches: Vec<WatchEntry>,
) -> Result<usize> {
    let _guard = WRITE_LOCK.lock().await;
    let mut imported = 0;
    for w in watches {
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO watch (profile_id, snippet_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(profile_id)
        .bind(&w.snippet_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await?
        .rows_affected();
        if inserted == 0 {
            continue;
        }
        let Some(watch_id) = watch_id_in(pool, profile_id, &w.snippet_id).await? else {
            continue;
        };
        // ID が時系列順になるよう、古い世代から挿入する。
        for g in w.generations.iter().take(MAX_GENERATIONS).rev() {
            let fingerprint =
                plan_fingerprint(&ops_from_payload(&g.driver, g.payload_kind, &g.payload));
            insert_generation_in(
                pool,
                watch_id,
                &NewGeneration {
                    captured_at: &g.captured_at,
                    driver: &g.driver,
                    payload_kind: g.payload_kind,
                    payload: &g.payload,
                    fingerprint: &fingerprint,
                },
            )
            .await?;
        }
        imported += 1;
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        init_schema(&pool).await.unwrap();
        pool
    }

    async fn rec(
        pool: &SqlitePool,
        profile: &str,
        snippet: &str,
        fp: &str,
        max: usize,
    ) -> RecordOutcome {
        record_in(
            pool,
            profile,
            snippet,
            NewGeneration {
                captured_at: "2026-01-01T00:00:00Z",
                driver: "mysql",
                payload_kind: PayloadKind::Json,
                payload: "{}",
                fingerprint: fp,
            },
            max,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn unwatched_snippets_record_nothing() {
        let pool = temp_pool().await;
        let out = rec(&pool, "p", "s1", "a", 20).await;
        assert!(!out.added);
        assert!(list_in(&pool, "p").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn identical_fingerprint_does_not_add_and_change_returns_prev() {
        let pool = temp_pool().await;
        set_watched_in(&pool, "p", "s1", true).await.unwrap();
        let first = rec(&pool, "p", "s1", "a", 20).await;
        assert!(first.added);
        assert!(first.prev.is_none());
        assert!(!rec(&pool, "p", "s1", "a", 20).await.added);
        let changed = rec(&pool, "p", "s1", "b", 20).await;
        assert!(changed.added);
        assert_eq!(changed.prev.map(|p| p.fingerprint), Some("a".to_string()));
        // A → B → A は「直前と同じ」ではないので世代が増える。
        assert!(rec(&pool, "p", "s1", "a", 20).await.added);
        let listed = list_in(&pool, "p").await.unwrap();
        assert_eq!(listed[0].generations.len(), 3);
        assert_eq!(listed[0].generations[0].fingerprint, "a");
    }

    #[tokio::test]
    async fn rotation_keeps_the_newest_generations_per_watch() {
        let pool = temp_pool().await;
        set_watched_in(&pool, "p", "s1", true).await.unwrap();
        set_watched_in(&pool, "p", "s2", true).await.unwrap();
        for i in 0..5 {
            rec(&pool, "p", "s1", &format!("f{i}"), 3).await;
        }
        rec(&pool, "p", "s2", "only", 3).await;
        let listed = list_in(&pool, "p").await.unwrap();
        assert_eq!(listed[0].snippet_id, "s1");
        let fps: Vec<&str> = listed[0]
            .generations
            .iter()
            .map(|g| g.fingerprint.as_str())
            .collect();
        assert_eq!(fps, ["f4", "f3", "f2"]);
        assert_eq!(listed[1].generations.len(), 1);
    }

    #[tokio::test]
    async fn watch_registration_is_idempotent_and_unwatch_drops_generations() {
        let pool = temp_pool().await;
        set_watched_in(&pool, "p", "s1", true).await.unwrap();
        set_watched_in(&pool, "p", "s1", true).await.unwrap();
        rec(&pool, "p", "s1", "a", 20).await;
        assert_eq!(watched_ids_in(&pool, "p").await.unwrap(), ["s1"]);
        set_watched_in(&pool, "p", "s1", false).await.unwrap();
        set_watched_in(&pool, "p", "never", false).await.unwrap();
        assert!(list_in(&pool, "p").await.unwrap().is_empty());
        // 世代も連鎖削除されている (再登録しても空から始まる)。
        set_watched_in(&pool, "p", "s1", true).await.unwrap();
        assert!(list_in(&pool, "p").await.unwrap()[0].generations.is_empty());
    }

    #[tokio::test]
    async fn watches_are_scoped_to_the_profile_and_snippet_delete_cascades_everywhere() {
        let pool = temp_pool().await;
        for profile in ["p1", "p2"] {
            set_watched_in(&pool, profile, "shared", true)
                .await
                .unwrap();
            set_watched_in(&pool, profile, "keep", true).await.unwrap();
            rec(&pool, profile, "shared", "a", 20).await;
        }
        assert_eq!(delete_snippet_in(&pool, "shared").await.unwrap(), 2);
        for profile in ["p1", "p2"] {
            assert_eq!(watched_ids_in(&pool, profile).await.unwrap(), ["keep"]);
        }
        let gens: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generation")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(gens, 0, "世代も連鎖削除される");
    }

    fn legacy_gen(at: &str, payload: &str) -> PlanGeneration {
        PlanGeneration {
            id: "plan_x".into(),
            captured_at: at.into(),
            driver: "mysql".into(),
            payload_kind: PayloadKind::Json,
            payload: payload.into(),
            fingerprint: "legacy".into(),
        }
    }

    #[tokio::test]
    async fn legacy_import_keeps_order_recomputes_fingerprint_and_skips_existing() {
        let pool = temp_pool().await;
        let newer = r#"{"query_block":{"table":{"table_name":"t","access_type":"ALL"}}}"#;
        let older =
            r#"{"query_block":{"table":{"table_name":"t","access_type":"ref","key":"ix"}}}"#;
        let entry = WatchEntry {
            snippet_id: "s1".into(),
            generations: vec![
                legacy_gen("2026-02-01T00:00:00Z", newer),
                legacy_gen("2026-01-01T00:00:00Z", older),
            ],
        };
        // 世代なしのウォッチ (登録だけ) も取り込まれる。
        let bare = WatchEntry {
            snippet_id: "s2".into(),
            generations: vec![],
        };
        assert_eq!(
            import_legacy_in(&pool, "p", vec![entry.clone(), bare])
                .await
                .unwrap(),
            2
        );
        assert_eq!(import_legacy_in(&pool, "p", vec![entry]).await.unwrap(), 0);
        let listed = list_in(&pool, "p").await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].generations.len(), 2);
        assert_eq!(listed[0].generations[0].captured_at, "2026-02-01T00:00:00Z");
        let expected = plan_fingerprint(&ops_from_payload("mysql", PayloadKind::Json, newer));
        assert_eq!(listed[0].generations[0].fingerprint, expected);
        // 移行直後、同じ計画の更新は新世代にならない。
        assert!(!rec(&pool, "p", "s1", &expected, 20).await.added);
    }

    #[test]
    fn legacy_entry_parses_the_local_storage_shape() {
        let json = r#"{"snippetId":"abc","generations":[{"id":"plan_1","capturedAt":"2026-01-01T00:00:00.000Z",
            "driver":"sqlite","payloadKind":"sqliteRows","payload":"[[2,0,\"SCAN t\"]]","fingerprint":"[]"}]}"#;
        let e: WatchEntry = serde_json::from_str(json).unwrap();
        assert_eq!(e.generations[0].payload_kind, PayloadKind::SqliteRows);
    }
}
