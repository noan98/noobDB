//! スキーマドリフト (#736 / #1260) のローカル専用ストア
//! (`<data_dir>/schema_drift.sqlite`)。
//!
//! `timelapse::store` と同じく初回利用時に遅延オープンし、マイグレーション手順を
//! 持たない (`CREATE TABLE IF NOT EXISTS`)。各関数は `*_in(pool, ...)` に本体を
//! 切り出し、テストはインメモリ SQLite に対して直接呼ぶ。

use std::path::PathBuf;

use serde::Deserialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use tokio::sync::{Mutex, OnceCell};

use super::{
    fingerprint_payload, serialize_payload, GenerationMeta, SnapshotPayload, MAX_GENERATIONS,
    MAX_SNAPSHOT_BYTES,
};
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::history::store::data_dir;

static POOL: OnceCell<SqlitePool> = OnceCell::const_new();

/// 世代の記録 (直前世代との比較 → 追加 → ローテーション) を直列化するロック。
/// 接続時の自動取得と手動取得が同時に走っても、同一内容の世代が 2 つ積まれない
/// ようにする。
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

fn store_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("schema_drift.sqlite"))
}

async fn pool() -> Result<&'static SqlitePool> {
    POOL.get_or_try_init(|| async {
        let path = store_path()?;
        let connect = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(connect)
            .await
            .map_err(|e| {
                tracing::error!(path = %path.display(), error = %e, "schema_drift: failed to open database");
                e
            })?;
        init_schema(&pool).await?;
        Ok(pool)
    })
    .await
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS generation (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id   TEXT NOT NULL,
            captured_at  TEXT NOT NULL,
            driver       TEXT NOT NULL,
            \"database\"   TEXT NOT NULL,
            fingerprint  TEXT NOT NULL,
            table_count  INTEGER NOT NULL,
            omitted      INTEGER NOT NULL,
            payload      TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_schema_drift_profile ON generation(profile_id, id DESC)",
    )
    .execute(pool)
    .await?;
    // #1537: DDL 実行をきっかけに取得した世代に、そのときの SQL を紐づける。既存の DB には
    // 列を足すだけ (SQLite には `ADD COLUMN IF NOT EXISTS` が無いので有無を調べてから足す)。
    let has_trigger_sql: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('generation') WHERE name = 'trigger_sql'",
    )
    .fetch_one(pool)
    .await?;
    if has_trigger_sql == 0 {
        sqlx::query("ALTER TABLE generation ADD COLUMN trigger_sql TEXT")
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// 旧 localStorage 世代 (`src/schemaDrift.ts` の `SchemaGeneration`) の取り込み用の形。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyGeneration {
    pub captured_at: String,
    pub driver: DriverKind,
    pub database: String,
    pub fingerprint: String,
    pub table_count: usize,
    /// 旧ストアの `omitted` は `payload` が `null` かどうかと一致するので読まない。
    pub payload: Option<SnapshotPayload>,
}

/// [`record`] の結果。
#[derive(Debug, Clone)]
pub struct RecordOutcome {
    /// 新しい世代が追加されたか (直前世代と同一フィンガープリントなら false)。
    pub added: bool,
    /// 追加時の直前世代 (初回なら `None`)。変化検知の比較相手。
    pub prev: Option<StoredGeneration>,
}

/// 保存済み世代 1 件 (メタ + ペイロード)。
#[derive(Debug, Clone)]
pub struct StoredGeneration {
    // 前世代の一致判定はフィンガープリントだけを先に読むようにした (#1530) ので、
    // 本体コードは読まない。テストと将来の参照用に保持する。
    #[allow(dead_code)]
    pub meta: GenerationMeta,
    pub payload: Option<SnapshotPayload>,
}

// ── 公開 API (実ストア) ──

/// 世代を記録する。`trigger_sql` は DDL 実行をきっかけにした取得のとき、そのときの SQL
/// (#1537)。接続時・手動の取得では `None`。
pub async fn record(
    profile_id: &str,
    payload: &SnapshotPayload,
    trigger_sql: Option<&str>,
) -> Result<RecordOutcome> {
    let captured_at = chrono::Utc::now().to_rfc3339();
    record_in(
        pool().await?,
        profile_id,
        payload,
        &captured_at,
        MAX_GENERATIONS,
        trigger_sql,
    )
    .await
}

pub async fn list(profile_id: &str) -> Result<Vec<GenerationMeta>> {
    list_in(pool().await?, profile_id).await
}

pub async fn load(profile_id: &str, id: i64) -> Result<Option<StoredGeneration>> {
    load_in(pool().await?, profile_id, id).await
}

pub async fn import_legacy(profile_id: &str, generations: Vec<LegacyGeneration>) -> Result<usize> {
    import_legacy_in(pool().await?, profile_id, generations).await
}

// ── 本体 (プール注入) ──

fn driver_from_wire(name: &str) -> Result<DriverKind> {
    DriverKind::parse(name).ok_or_else(|| {
        AppError::InvalidInput(format!("unknown driver '{name}' in schema drift store"))
    })
}

fn meta_from_row(r: &sqlx::sqlite::SqliteRow) -> Result<GenerationMeta> {
    let id: i64 = r.try_get("id")?;
    let driver: String = r.try_get("driver")?;
    Ok(GenerationMeta {
        id: id.to_string(),
        captured_at: r.try_get("captured_at")?,
        driver: driver_from_wire(&driver)?,
        database: r.try_get("database")?,
        fingerprint: r.try_get("fingerprint")?,
        table_count: r.try_get::<i64, _>("table_count")?.max(0) as usize,
        omitted: r.try_get("omitted")?,
        trigger_sql: r.try_get("trigger_sql")?,
    })
}

async fn list_in(pool: &SqlitePool, profile_id: &str) -> Result<Vec<GenerationMeta>> {
    let rows = sqlx::query(
        "SELECT id, captured_at, driver, \"database\", fingerprint, table_count, omitted, trigger_sql
           FROM generation WHERE profile_id = ? ORDER BY id DESC",
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await?;
    rows.iter().map(meta_from_row).collect()
}

async fn load_in(pool: &SqlitePool, profile_id: &str, id: i64) -> Result<Option<StoredGeneration>> {
    let row = sqlx::query(
        "SELECT id, captured_at, driver, \"database\", fingerprint, table_count, omitted, trigger_sql, payload
           FROM generation WHERE profile_id = ? AND id = ?",
    )
    .bind(profile_id)
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let payload: Option<String> = r.try_get("payload")?;
    Ok(Some(StoredGeneration {
        meta: meta_from_row(&r)?,
        payload: payload.map(|p| serde_json::from_str(&p)).transpose()?,
    }))
}

/// `generation` テーブルへ挿入する 1 行分 (引数の数を抑えるための束ね)。
struct NewRow<'a> {
    captured_at: &'a str,
    driver: DriverKind,
    database: &'a str,
    fingerprint: &'a str,
    table_count: usize,
    /// `None` のときは省略世代 (`omitted = 1`)。
    payload_json: Option<&'a str>,
    /// DDL 実行をきっかけにした取得のときの SQL (#1537)。
    trigger_sql: Option<&'a str>,
}

async fn insert_in(
    conn: &mut sqlx::SqliteConnection,
    profile_id: &str,
    row: NewRow<'_>,
) -> Result<i64> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO generation
            (profile_id, captured_at, driver, \"database\", fingerprint, table_count, omitted, payload, trigger_sql)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(profile_id)
    .bind(row.captured_at)
    .bind(row.driver.as_str())
    .bind(row.database)
    .bind(row.fingerprint)
    .bind(row.table_count as i64)
    .bind(row.payload_json.is_none())
    .bind(row.payload_json)
    .bind(row.trigger_sql)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

async fn rotate_in(
    conn: &mut sqlx::SqliteConnection,
    profile_id: &str,
    max_generations: usize,
) -> Result<()> {
    sqlx::query(
        "DELETE FROM generation WHERE profile_id = ? AND id NOT IN (
            SELECT id FROM generation WHERE profile_id = ? ORDER BY id DESC LIMIT ?
         )",
    )
    .bind(profile_id)
    .bind(profile_id)
    .bind(max_generations.max(1) as i64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// 世代を 1 つ記録する。直前世代とフィンガープリントが同じなら何もしない。追加した
/// らプロファイル単位のローテーションを適用する。直列化サイズが
/// [`MAX_SNAPSHOT_BYTES`] を超えるときはペイロードを省略する (フィンガープリントは
/// 常に全内容から計算するので、省略した世代でも「前回と同一か」の判定は正確)。
async fn record_in(
    pool: &SqlitePool,
    profile_id: &str,
    payload: &SnapshotPayload,
    captured_at: &str,
    max_generations: usize,
    trigger_sql: Option<&str>,
) -> Result<RecordOutcome> {
    let _guard = WRITE_LOCK.lock().await;
    let json = serialize_payload(payload)?;
    let fingerprint = super::fnv1a32(json.as_bytes());
    // 一致判定はフィンガープリントだけで済むので、前世代のペイロード (最大 8 MiB 級の
    // JSON) は不一致で追加するときまでデコードしない (#1530)。
    let prev_head: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, fingerprint FROM generation WHERE profile_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(profile_id)
    .fetch_optional(pool)
    .await?;
    if prev_head.as_ref().is_some_and(|(_, fp)| *fp == fingerprint) {
        return Ok(RecordOutcome {
            added: false,
            prev: None,
        });
    }
    let prev = match prev_head {
        Some((id, _)) => load_in(pool, profile_id, id).await?,
        None => None,
    };
    let omitted = json.len() > MAX_SNAPSHOT_BYTES;
    // 追加と間引きを 1 トランザクションにまとめる (#1534): コミットが 1 回で済み、途中で失敗しても
    // 世代数が上限を超えたまま残らない (どちらも反映されない)。WRITE_LOCK 下なので競合は増えない。
    let mut tx = pool.begin().await?;
    insert_in(
        &mut tx,
        profile_id,
        NewRow {
            captured_at,
            driver: payload.driver,
            database: &payload.database,
            fingerprint: &fingerprint,
            table_count: payload.tables.len(),
            payload_json: (!omitted).then_some(json.as_str()),
            trigger_sql,
        },
    )
    .await?;
    rotate_in(&mut tx, profile_id, max_generations).await?;
    tx.commit().await?;
    Ok(RecordOutcome { added: true, prev })
}

/// 旧 localStorage 世代 (新しい順) を取り込む。ストアに既にこのプロファイルの世代が
/// あるときは何もしない (冪等: 二重取り込みで履歴が重複しない)。フィンガープリントは
/// Rust 側の直列化で計算し直す — そうしないと移行直後の最初のキャプチャが「内容は同じ
/// なのにフィンガープリントが違う」と判定されて余計な世代を積んでしまう。取り込んだ
/// 件数を返す。
async fn import_legacy_in(
    pool: &SqlitePool,
    profile_id: &str,
    generations: Vec<LegacyGeneration>,
) -> Result<usize> {
    let _guard = WRITE_LOCK.lock().await;
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM generation WHERE profile_id = ?")
        .bind(profile_id)
        .fetch_one(pool)
        .await?;
    if existing > 0 {
        return Ok(0);
    }
    let mut imported = 0;
    // 取り込みも 1 トランザクションにする (途中で失敗したら 1 件も入らず、次回やり直せる)。
    let mut tx = pool.begin().await?;
    // ID が時系列順になるよう、古い世代から挿入する。
    for g in generations.iter().take(MAX_GENERATIONS).rev() {
        let (fingerprint, json) = match &g.payload {
            Some(p) => {
                let json = serialize_payload(p)?;
                (
                    fingerprint_payload(p)?,
                    (json.len() <= MAX_SNAPSHOT_BYTES).then_some(json),
                )
            }
            None => (g.fingerprint.clone(), None),
        };
        insert_in(
            &mut tx,
            profile_id,
            NewRow {
                captured_at: &g.captured_at,
                driver: g.driver,
                database: &g.database,
                fingerprint: &fingerprint,
                table_count: g.table_count,
                payload_json: json.as_deref(),
                trigger_sql: None,
            },
        )
        .await?;
        imported += 1;
    }
    tx.commit().await?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::{IndexInfo, TableColumnInfo};
    use crate::schema_drift::SnapshotTable;

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

    fn payload(cols: &[&str]) -> SnapshotPayload {
        SnapshotPayload {
            driver: DriverKind::Sqlite,
            database: "main".into(),
            tables: vec![SnapshotTable {
                name: "t".into(),
                columns: cols
                    .iter()
                    .map(|c| TableColumnInfo {
                        name: c.to_string(),
                        data_type: "INTEGER".into(),
                        nullable: true,
                        key: String::new(),
                        default: None,
                        extra: String::new(),
                        referenced_table: None,
                        referenced_column: None,
                        comment: None,
                    })
                    .collect(),
                indexes: Vec::<IndexInfo>::new(),
            }],
        }
    }

    async fn rec(
        pool: &SqlitePool,
        profile: &str,
        p: &SnapshotPayload,
        max: usize,
    ) -> RecordOutcome {
        record_in(pool, profile, p, "2026-01-01T00:00:00Z", max, None)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn first_capture_has_no_prev_and_identical_capture_adds_nothing() {
        let pool = temp_pool().await;
        let first = rec(&pool, "p", &payload(&["a"]), 20).await;
        assert!(first.added);
        assert!(first.prev.is_none());
        let again = rec(&pool, "p", &payload(&["a"]), 20).await;
        assert!(!again.added);
        assert_eq!(list_in(&pool, "p").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn changed_capture_returns_prev_and_lists_newest_first() {
        let pool = temp_pool().await;
        rec(&pool, "p", &payload(&["a"]), 20).await;
        let second = rec(&pool, "p", &payload(&["a", "b"]), 20).await;
        assert!(second.added);
        let prev = second.prev.expect("prev");
        assert_eq!(prev.payload.expect("payload").tables[0].columns.len(), 1);
        let list = list_in(&pool, "p").await.unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].id.parse::<i64>().unwrap() > list[1].id.parse::<i64>().unwrap());
        // A → B → A は「直前と同じ」ではないので世代が増える。
        assert!(rec(&pool, "p", &payload(&["a"]), 20).await.added);
    }

    #[tokio::test]
    async fn rotation_keeps_only_the_newest_generations_per_profile() {
        let pool = temp_pool().await;
        for i in 0..5 {
            let cols: Vec<String> = (0..=i).map(|n| format!("c{n}")).collect();
            let refs: Vec<&str> = cols.iter().map(String::as_str).collect();
            rec(&pool, "p", &payload(&refs), 3).await;
        }
        rec(&pool, "other", &payload(&["x"]), 3).await;
        let list = list_in(&pool, "p").await.unwrap();
        assert_eq!(list.len(), 3);
        // 最新 (5 列) が先頭。
        let newest = load_in(&pool, "p", list[0].id.parse().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(newest.payload.unwrap().tables[0].columns.len(), 5);
        assert_eq!(list_in(&pool, "other").await.unwrap().len(), 1);
    }

    /// 追加と間引きは 1 トランザクション (#1534): 間引きが失敗したら追加も巻き戻り、
    /// 世代数が上限を超えたまま残らない。
    #[tokio::test]
    async fn failed_rotation_rolls_back_the_insert() {
        let pool = temp_pool().await;
        rec(&pool, "p", &payload(&["a"]), 1).await;
        sqlx::query(
            "CREATE TRIGGER no_delete BEFORE DELETE ON generation \
             BEGIN SELECT RAISE(ABORT, 'rotation blocked'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let err = record_in(
            &pool,
            "p",
            &payload(&["a", "b"]),
            "2026-01-02T00:00:00Z",
            1,
            None,
        )
        .await;
        assert!(err.is_err());
        let list = list_in(&pool, "p").await.unwrap();
        assert_eq!(list.len(), 1, "追加だけが残って上限を超えてはいけない");
        let only = load_in(&pool, "p", list[0].id.parse().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(only.payload.unwrap().tables[0].columns.len(), 1);
    }

    /// #1537: DDL をきっかけにした世代は実行した SQL を持ち、それ以外は `None`。
    #[tokio::test]
    async fn trigger_sql_is_stored_with_the_generation() {
        let pool = temp_pool().await;
        rec(&pool, "p", &payload(&["a"]), 20).await;
        record_in(
            &pool,
            "p",
            &payload(&["a", "b"]),
            "2026-01-02T00:00:00Z",
            20,
            Some("ALTER TABLE t ADD COLUMN b INT"),
        )
        .await
        .unwrap();
        let list = list_in(&pool, "p").await.unwrap();
        assert_eq!(
            list[0].trigger_sql.as_deref(),
            Some("ALTER TABLE t ADD COLUMN b INT")
        );
        assert_eq!(list[1].trigger_sql, None);
        let loaded = load_in(&pool, "p", list[0].id.parse().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            loaded.meta.trigger_sql.as_deref(),
            Some("ALTER TABLE t ADD COLUMN b INT")
        );
    }

    /// #1537: `trigger_sql` 列の無い旧 DB を開くと列が足され、既存の世代はそのまま読める。
    #[tokio::test]
    async fn init_schema_adds_trigger_sql_column_to_an_old_database() {
        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(":memory:"))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE generation (
                id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL,
                captured_at TEXT NOT NULL, driver TEXT NOT NULL, \"database\" TEXT NOT NULL,
                fingerprint TEXT NOT NULL, table_count INTEGER NOT NULL,
                omitted INTEGER NOT NULL, payload TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO generation (profile_id, captured_at, driver, \"database\", fingerprint, table_count, omitted)
             VALUES ('p', '2026-01-01T00:00:00Z', 'sqlite', 'main', 'fp', 1, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        init_schema(&pool).await.unwrap();
        // 2 回目の初期化でも壊れない (冪等)。
        init_schema(&pool).await.unwrap();
        let list = list_in(&pool, "p").await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].trigger_sql, None);
    }

    #[tokio::test]
    async fn load_is_scoped_to_the_profile() {
        let pool = temp_pool().await;
        let out = rec(&pool, "p", &payload(&["a"]), 20).await;
        assert!(out.added);
        let id: i64 = list_in(&pool, "p").await.unwrap()[0].id.parse().unwrap();
        assert!(load_in(&pool, "p", id).await.unwrap().is_some());
        assert!(load_in(&pool, "someone-else", id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn legacy_import_keeps_order_recomputes_fingerprint_and_is_idempotent() {
        let pool = temp_pool().await;
        let newer = payload(&["a", "b"]);
        let older = payload(&["a"]);
        let legacy = |p: &SnapshotPayload, at: &str| LegacyGeneration {
            captured_at: at.into(),
            driver: DriverKind::Sqlite,
            database: "main".into(),
            fingerprint: "legacy-fnv".into(),
            table_count: 1,
            payload: Some(p.clone()),
        };
        // 旧ストアは新しい順。
        let gens = vec![
            legacy(&newer, "2026-02-01T00:00:00Z"),
            legacy(&older, "2026-01-01T00:00:00Z"),
        ];
        assert_eq!(import_legacy_in(&pool, "p", gens.clone()).await.unwrap(), 2);
        assert_eq!(import_legacy_in(&pool, "p", gens).await.unwrap(), 0);
        let list = list_in(&pool, "p").await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].captured_at, "2026-02-01T00:00:00Z");
        assert_eq!(list[0].fingerprint, fingerprint_payload(&newer).unwrap());
        // 移行直後、内容が同じキャプチャは新世代にならない。
        assert!(!rec(&pool, "p", &newer, 20).await.added);
    }

    #[tokio::test]
    async fn legacy_omitted_generation_stays_omitted_without_payload() {
        let pool = temp_pool().await;
        let gens = vec![LegacyGeneration {
            captured_at: "2026-01-01T00:00:00Z".into(),
            driver: DriverKind::Mysql,
            database: "app".into(),
            fingerprint: "deadbeef".into(),
            table_count: 900,
            payload: None,
        }];
        import_legacy_in(&pool, "p", gens).await.unwrap();
        let list = list_in(&pool, "p").await.unwrap();
        assert!(list[0].omitted);
        assert_eq!(list[0].table_count, 900);
        assert_eq!(list[0].fingerprint, "deadbeef");
    }

    #[test]
    fn legacy_generation_parses_the_local_storage_shape() {
        let json = r#"{"id":"drift_x","capturedAt":"2026-01-01T00:00:00.000Z","driver":"mysql",
            "database":"app","fingerprint":"abc","tableCount":1,"omitted":false,
            "payload":{"driver":"mysql","database":"app","tables":[{"name":"t","columns":[
              {"name":"id","data_type":"int","nullable":false,"key":"PRI","default":null,
               "extra":"","referenced_table":null,"referenced_column":null}],
              "indexes":[{"name":"PRIMARY","columns":["id"],"unique":true,"primary":true,"method":"BTREE"}]}]}}"#;
        let g: LegacyGeneration = serde_json::from_str(json).unwrap();
        assert_eq!(g.payload.unwrap().tables[0].indexes.len(), 1);
    }
}
