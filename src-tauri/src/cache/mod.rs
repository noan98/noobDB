//! Schema Cache (#1097): 接続 (`Session`) 単位のスキーマ introspection キャッシュ。
//!
//! ## 設計方針
//!
//! - **所有者は Rust 側のみ。** `Session` が `SchemaCache` を直接持ち、フロント
//!   (React state) 側では同じデータをキャッシュしない — 二重キャッシュによる
//!   ズレを避ける (#1093 Epic 方針)。フロントは今まで通り `list_tables` 等の
//!   IPC を毎回呼ぶだけでよく、キャッシュのヒット/ミスは完全に透過的。
//! - **接続単位の分離は `Session` の所有構造で保証する。** `SchemaCache` は
//!   `Session` のフィールドとして存在し、`Session` は `AppState.sessions` に
//!   `SessionId` をキーとして 1 対 1 で紐づく。別セッションの `SchemaCache` へ
//!   到達する経路は存在しないため、「接続をまたいだキャッシュ汚染」はそもそも
//!   型として起こり得ない (キーに session_id を含める設計ではなく、キャッシュの
//!   インスタンスそのものをセッションごとに分ける設計)。
//! - **`reconnect` は必ず新しい `Session` (≒新しい `SchemaCache`) を作る。**
//!   `commands::connection::reconnect_inner` は既存の接続をその場で書き換える
//!   のではなく、新しい `Connection` を開いてから `Session` ごと差し替える
//!   (`AppState::replace`)。したがって再接続後のキャッシュは常に空から始まり、
//!   「接続再確立時のキャッシュ有効性」は自明に保たれる (stale を持ち越す経路が
//!   存在しない)。
//! - **invalidate (無効化) の条件は 3 つ**:
//!   1. 明示的 Refresh — `refresh_schema_cache` IPC (`commands::schema`) を
//!      フロントのスキーマツリー更新ボタンから呼ぶ。
//!   2. DDL 相当の SQL 実行 — `commands::query::{run_query, run_query_transaction,
//!      run_in_transaction}` が実行前の SQL を [`crate::db::sql_may_change_schema`]
//!      で判定し、該当すれば実行後にこのセッションのキャッシュを丸ごと invalidate
//!      する。同一トランザクション内の 1 文でも DDL 相当なら全体を invalidate
//!      する (どのテーブルが変わったかを SQL から正確に特定するパーサは持たない
//!      ため、テーブル単位ではなく接続単位で丸ごと破棄する — 過剰破棄は「次の
//!      1 回だけ再取得が走る」だけで安全側、見逃しの方が stale 表示という実害に
//!      直結するため、fail-closed に倒す)。
//!   3. スキーマ同期の適用 — `commands::sync::apply_sync_sql` はコマンドの目的
//!      自体が「対象のスキーマをソースに合わせて変更する」ことなので、SQL の
//!      内容を判定せず常に invalidate する。
//! - **TTL は最終防御線。** 上記 3 条件は noobDB 経由の変更を確実に捕捉するが、
//!   同じ DB に対して別クライアント (別セッション・別アプリ) が同時にスキーマを
//!   変更するケースまでは捕捉できない。[`DEFAULT_TTL`] 経過後は無条件に再取得
//!   させることで、この種の見逃しが無期限に残り続けないようにする。
//! - **保存する値に秘密情報は含まれない。** テーブル名・カラム名・型・PK/FK・
//!   インデックス定義など非秘密のメタデータのみで、パスワード/パスフレーズは
//!   そもそもこの型に流れ込まない (`db::types` の各構造体を参照)。キャッシュは
//!   プロセスのメモリ上にのみ存在し、ディスクへは一切書かない — プロセス終了・
//!   切断・Refresh のいずれでも消える。
//!
//! ## Query Result Cache について
//!
//! 本 Issue (#1097) は Schema Cache と Query Result Cache を「独立して段階導入
//! する」ことを明記している。本 PR では Schema Cache のみを実装し、Query Result
//! Cache には着手しない (方針は上記ドキュメントコメントと PR 本文を参照)。

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::db::types::{
    ForeignKey, IndexInfo, SchemaObject, TableColumnInfo, TableRowIdentity, TableSchema,
};
use crate::error::Result;

/// キャッシュエントリの既定 TTL (#1097)。DDL / 明示 Refresh による invalidate が
/// 主たる鮮度保証だが、それらを経由しない外部要因 (別クライアントによる変更) に
/// 対する最終防御線として、時間経過でも必ず陳腐化させる。
const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);

/// キャッシュ 1 kind (例: `tables`) あたりの最大エントリ数。非常に多くの DB /
/// テーブルを持つサーバに接続しても無制限に増え続けないための防御的な上限。
/// 超過したら該当 kind を丸ごと clear してから挿入する — 部分的な LRU 追い出しは
/// 実装せず単純さを優先する (超過は極端なケースでのみ起こり、通常のブラウジング
/// では発生しない)。
const DEFAULT_MAX_ENTRIES_PER_KIND: usize = 500;

struct CacheEntry<V> {
    value: V,
    inserted_at: Instant,
}

impl<V> CacheEntry<V> {
    fn fresh(value: V) -> Self {
        Self {
            value,
            inserted_at: Instant::now(),
        }
    }

    fn is_expired(&self, ttl: Duration) -> bool {
        self.inserted_at.elapsed() >= ttl
    }
}

/// キーを持たないスロット (`databases()` のように接続全体で 1 件しかないもの)
/// の get-or-fetch。ロックを保持したまま `fetch` を `.await` しない
/// (読み取りロックは値の有無だけ見て即座に解放し、書き込みロックは fetch 完了後
/// に短時間だけ取る) — 同時に複数の呼び出しがミスした場合、fetch が重複して
/// 走ることがあるが (single-flight 化はしていない)、結果は最後の書き込みが残る
/// だけで正しさには影響しない、既知の割り切り。
async fn get_or_fetch_single<V, F, Fut>(
    slot: &RwLock<Option<CacheEntry<V>>>,
    ttl: Duration,
    fetch: F,
) -> Result<V>
where
    V: Clone,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<V>>,
{
    {
        let guard = slot.read().await;
        if let Some(entry) = guard.as_ref() {
            if !entry.is_expired(ttl) {
                return Ok(entry.value.clone());
            }
        }
    }
    let value = fetch().await?;
    *slot.write().await = Some(CacheEntry::fresh(value.clone()));
    Ok(value)
}

/// キー付きスロット (`tables(db)` / `columns(db, table)` など) の get-or-fetch。
/// ロックの扱いは [`get_or_fetch_single`] と同じ方針。
async fn get_or_fetch<K, V, F, Fut>(
    map: &RwLock<HashMap<K, CacheEntry<V>>>,
    key: K,
    ttl: Duration,
    max_entries: usize,
    fetch: F,
) -> Result<V>
where
    K: Eq + Hash + Clone,
    V: Clone,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<V>>,
{
    {
        let guard = map.read().await;
        if let Some(entry) = guard.get(&key) {
            if !entry.is_expired(ttl) {
                return Ok(entry.value.clone());
            }
        }
    }
    let value = fetch().await?;
    {
        let mut guard = map.write().await;
        if guard.len() >= max_entries && !guard.contains_key(&key) {
            tracing::debug!(
                max_entries,
                "schema cache: kind exceeded its entry cap, clearing before insert"
            );
            guard.clear();
        }
        guard.insert(key, CacheEntry::fresh(value.clone()));
    }
    Ok(value)
}

/// `(database, table)` の複合キー。`columns` / `row_identity` / `list_indexes`
/// で共有する。
type TableKey = (String, String);

/// 1 kind 分のキー付きスロット。`clippy::type_complexity` 対策の型エイリアス —
/// 実体は変えず名前を付けているだけ。
type Slot<K, V> = RwLock<HashMap<K, CacheEntry<V>>>;

/// セッション (接続) 単位のスキーマ introspection キャッシュ。フィールドは
/// `commands::schema` の各 IPC ハンドラと 1 対 1 対応する。キャッシュしない
/// もの (意図的なスコープ縮小):
///
/// - `get_object_definition` (DDL 本文) — 単一オブジェクトを都度取得する
///   Inspector 用途で、スキーマ全体を舐める他の introspection ほど重複呼び出し
///   の頻度が高くない。
/// - `table_row_estimates` / `table_sizes` — DDL ではなく DML (行の増減) で
///   絶えず変化する統計値。スキーマ変更時の invalidate だけでは鮮度を保証でき
///   ず、キャッシュすると「サイズ/行数が古いまま」という誤解を招きやすいため
///   スコープ外とする (Issue #1097 が列挙する対象 — テーブル/カラム/PK/FK/
///   index/view・routine — にも含まれない)。
pub struct SchemaCache {
    ttl: Duration,
    max_entries_per_kind: usize,
    databases: RwLock<Option<CacheEntry<Vec<String>>>>,
    tables: Slot<String, Vec<String>>,
    columns: Slot<TableKey, Vec<TableColumnInfo>>,
    row_identity: Slot<TableKey, TableRowIdentity>,
    schema_overview: Slot<String, Vec<TableSchema>>,
    foreign_keys: Slot<String, Vec<ForeignKey>>,
    schema_objects: Slot<String, Vec<SchemaObject>>,
    list_indexes: Slot<TableKey, Vec<IndexInfo>>,
}

impl Default for SchemaCache {
    fn default() -> Self {
        Self::new(DEFAULT_TTL, DEFAULT_MAX_ENTRIES_PER_KIND)
    }
}

impl SchemaCache {
    /// テスト用に TTL / 容量上限を差し替えられるコンストラクタ。本体コードは
    /// 常に `SchemaCache::default()` (= `Session` 生成時) を使う。
    fn new(ttl: Duration, max_entries_per_kind: usize) -> Self {
        Self {
            ttl,
            max_entries_per_kind,
            databases: RwLock::new(None),
            tables: RwLock::new(HashMap::new()),
            columns: RwLock::new(HashMap::new()),
            row_identity: RwLock::new(HashMap::new()),
            schema_overview: RwLock::new(HashMap::new()),
            foreign_keys: RwLock::new(HashMap::new()),
            schema_objects: RwLock::new(HashMap::new()),
            list_indexes: RwLock::new(HashMap::new()),
        }
    }

    pub async fn databases<F, Fut>(&self, fetch: F) -> Result<Vec<String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<String>>>,
    {
        get_or_fetch_single(&self.databases, self.ttl, fetch).await
    }

    pub async fn tables<F, Fut>(&self, database: &str, fetch: F) -> Result<Vec<String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<String>>>,
    {
        get_or_fetch(
            &self.tables,
            database.to_string(),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    pub async fn columns<F, Fut>(
        &self,
        database: &str,
        table: &str,
        fetch: F,
    ) -> Result<Vec<TableColumnInfo>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<TableColumnInfo>>>,
    {
        get_or_fetch(
            &self.columns,
            (database.to_string(), table.to_string()),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    pub async fn row_identity<F, Fut>(
        &self,
        database: &str,
        table: &str,
        fetch: F,
    ) -> Result<TableRowIdentity>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<TableRowIdentity>>,
    {
        get_or_fetch(
            &self.row_identity,
            (database.to_string(), table.to_string()),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    pub async fn schema_overview<F, Fut>(
        &self,
        database: &str,
        fetch: F,
    ) -> Result<Vec<TableSchema>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<TableSchema>>>,
    {
        get_or_fetch(
            &self.schema_overview,
            database.to_string(),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    pub async fn foreign_keys<F, Fut>(&self, database: &str, fetch: F) -> Result<Vec<ForeignKey>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<ForeignKey>>>,
    {
        get_or_fetch(
            &self.foreign_keys,
            database.to_string(),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    pub async fn schema_objects<F, Fut>(
        &self,
        database: &str,
        fetch: F,
    ) -> Result<Vec<SchemaObject>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<SchemaObject>>>,
    {
        get_or_fetch(
            &self.schema_objects,
            database.to_string(),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    pub async fn list_indexes<F, Fut>(
        &self,
        database: &str,
        table: &str,
        fetch: F,
    ) -> Result<Vec<IndexInfo>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<IndexInfo>>>,
    {
        get_or_fetch(
            &self.list_indexes,
            (database.to_string(), table.to_string()),
            self.ttl,
            self.max_entries_per_kind,
            fetch,
        )
        .await
    }

    /// このセッションのスキーマキャッシュを丸ごと無効化する。呼び出し元:
    /// - `commands::schema::refresh_schema_cache` (明示的 Refresh)
    /// - `commands::query::{run_query_inner, run_query_transaction_inner,
    ///   run_in_transaction}` (DDL 相当の SQL 実行後。
    ///   [`crate::db::sql_may_change_schema`] 参照)
    /// - `commands::sync::apply_sync_sql_inner` (スキーマ同期の適用後、常に)
    pub async fn invalidate_all(&self) {
        *self.databases.write().await = None;
        self.tables.write().await.clear();
        self.columns.write().await.clear();
        self.row_identity.write().await.clear();
        self.schema_overview.write().await.clear();
        self.foreign_keys.write().await.clear();
        self.schema_objects.write().await.clear();
        self.list_indexes.write().await.clear();
        tracing::debug!("schema cache invalidated");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn test_cache() -> SchemaCache {
        SchemaCache::new(Duration::from_secs(300), 500)
    }

    /// 同一キーへの 2 回目の呼び出しはキャッシュヒットし、`fetch` が再実行され
    /// ないこと (= 重複 introspection が削減されること、受け入れ条件 1)。
    #[tokio::test]
    async fn tables_hits_cache_on_second_call() {
        let cache = test_cache();
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let calls = calls.clone();
            let result = cache
                .tables("mydb", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["t1".to_string(), "t2".to_string()])
                })
                .await
                .unwrap();
            assert_eq!(result, vec!["t1".to_string(), "t2".to_string()]);
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "fetch は最初の 1 回だけ走り、以後はキャッシュから返るはず"
        );
    }

    /// 異なるキー (データベース名 / テーブル名) はそれぞれ独立してキャッシュ
    /// される — 同一接続内でも DB/テーブルが違えば混ざらないこと。
    #[tokio::test]
    async fn different_keys_are_cached_independently() {
        let cache = test_cache();

        let a = cache
            .tables("db_a", || async { Ok(vec!["a1".to_string()]) })
            .await
            .unwrap();
        let b = cache
            .tables("db_b", || async { Ok(vec!["b1".to_string()]) })
            .await
            .unwrap();

        assert_eq!(a, vec!["a1".to_string()]);
        assert_eq!(b, vec!["b1".to_string()]);

        // 再度 db_a を引いても db_b の値と混ざらないこと (キャッシュから返る
        // ため fetch は呼ばれない = 呼ばれたら b1 を返すクロージャにしておき、
        // 混入していれば失敗する)。
        let a_again = cache
            .tables("db_a", || async { Ok(vec!["WRONG".to_string()]) })
            .await
            .unwrap();
        assert_eq!(a_again, vec!["a1".to_string()]);
    }

    /// `columns` はテーブル単位でキャッシュされ、DB は同じでもテーブルが
    /// 違えば別エントリになること。
    #[tokio::test]
    async fn columns_are_keyed_by_database_and_table() {
        let cache = test_cache();
        let col = |name: &str| TableColumnInfo {
            name: name.to_string(),
            data_type: "text".to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
        };

        let t1 = cache
            .columns("db", "t1", || async { Ok(vec![col("id")]) })
            .await
            .unwrap();
        let t2 = cache
            .columns("db", "t2", || async { Ok(vec![col("name")]) })
            .await
            .unwrap();

        assert_eq!(t1[0].name, "id");
        assert_eq!(t2[0].name, "name");
    }

    /// 受け入れ条件 2: Refresh (= `invalidate_all`) を挟むと、その後の呼び出し
    /// は必ず `fetch` を再実行する (stale なキャッシュ値を返さない)。
    #[tokio::test]
    async fn invalidate_all_forces_refetch() {
        let cache = test_cache();
        let calls = Arc::new(AtomicUsize::new(0));

        let fetch = |calls: Arc<AtomicUsize>, tables: Vec<&'static str>| {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(tables.into_iter().map(str::to_string).collect())
            }
        };

        let before = cache
            .tables("db", || fetch(calls.clone(), vec!["old_table"]))
            .await
            .unwrap();
        assert_eq!(before, vec!["old_table".to_string()]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Refresh 相当: 明示的に invalidate してから再取得する。
        cache.invalidate_all().await;

        let after = cache
            .tables("db", || {
                fetch(calls.clone(), vec!["old_table", "new_table"])
            })
            .await
            .unwrap();
        assert_eq!(
            after,
            vec!["old_table".to_string(), "new_table".to_string()]
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "invalidate 後は必ず fetch が再実行されること"
        );
    }

    /// `invalidate_all` はすべての kind (databases / tables / columns /
    /// row_identity / schema_overview / foreign_keys / schema_objects /
    /// list_indexes) を一斉にクリアすること。1 種類だけ消し忘れるリグレッションを
    /// 防ぐ。
    #[tokio::test]
    async fn invalidate_all_clears_every_kind() {
        let cache = test_cache();

        let _ = cache
            .databases(|| async { Ok(vec!["d".to_string()]) })
            .await;
        let _ = cache
            .tables("d", || async { Ok(vec!["t".to_string()]) })
            .await;
        let _ = cache
            .columns("d", "t", || async {
                Ok(vec![TableColumnInfo {
                    name: "c".to_string(),
                    data_type: "int".to_string(),
                    nullable: false,
                    key: String::new(),
                    default: None,
                    extra: String::new(),
                    referenced_table: None,
                    referenced_column: None,
                }])
            })
            .await;
        let _ = cache
            .row_identity("d", "t", || async {
                Ok(TableRowIdentity {
                    strategy: "primary_key".to_string(),
                    hidden_column: None,
                })
            })
            .await;
        let _ = cache
            .schema_overview("d", || async {
                Ok(vec![TableSchema {
                    name: "t".to_string(),
                    columns: vec!["c".to_string()],
                }])
            })
            .await;
        let _ = cache
            .foreign_keys("d", || async {
                Ok(vec![ForeignKey {
                    table: "t".to_string(),
                    column: "c".to_string(),
                    referenced_table: "t2".to_string(),
                    referenced_column: Some("id".to_string()),
                    constraint_name: Some("fk".to_string()),
                }])
            })
            .await;
        let _ = cache
            .schema_objects("d", || async {
                Ok(vec![SchemaObject {
                    kind: "view".to_string(),
                    name: "v".to_string(),
                    id: None,
                }])
            })
            .await;
        let _ = cache
            .list_indexes("d", "t", || async {
                Ok(vec![IndexInfo {
                    name: "idx".to_string(),
                    columns: vec!["c".to_string()],
                    unique: false,
                    primary: false,
                    method: None,
                }])
            })
            .await;

        cache.invalidate_all().await;

        assert!(cache.databases.read().await.is_none());
        assert!(cache.tables.read().await.is_empty());
        assert!(cache.columns.read().await.is_empty());
        assert!(cache.row_identity.read().await.is_empty());
        assert!(cache.schema_overview.read().await.is_empty());
        assert!(cache.foreign_keys.read().await.is_empty());
        assert!(cache.schema_objects.read().await.is_empty());
        assert!(cache.list_indexes.read().await.is_empty());
    }

    /// TTL が経過したエントリはヒットとみなさず再取得すること (最終防御線が
    /// 実際に機能することの回帰テスト)。
    #[tokio::test]
    async fn expired_entry_is_refetched() {
        let cache = SchemaCache::new(Duration::from_millis(20), 500);
        let calls = Arc::new(AtomicUsize::new(0));

        {
            let calls = calls.clone();
            cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["t".to_string()])
                })
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(40)).await;

        {
            let calls = calls.clone();
            cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["t".to_string()])
                })
                .await
                .unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "TTL 経過後は再度 fetch が走ること"
        );
    }

    /// 容量上限を超えたら、そのキャッシュ kind は次の挿入前に丸ごとクリアされる
    /// こと (無制限に増え続けないための防御を確認する)。
    #[tokio::test]
    async fn exceeding_capacity_clears_the_kind_before_inserting() {
        let cache = SchemaCache::new(Duration::from_secs(300), 2);

        cache
            .tables("db1", || async { Ok(vec!["t1".to_string()]) })
            .await
            .unwrap();
        cache
            .tables("db2", || async { Ok(vec!["t2".to_string()]) })
            .await
            .unwrap();
        assert_eq!(cache.tables.read().await.len(), 2);

        // 3 件目の挿入で容量 (2) を超えるため、丸ごとクリアしてから db3 だけが
        // 残る。
        cache
            .tables("db3", || async { Ok(vec!["t3".to_string()]) })
            .await
            .unwrap();
        let map = cache.tables.read().await;
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("db3"));
    }

    /// `fetch` がエラーを返したときはキャッシュへ何も書き込まれず、次回呼び出し
    /// でも再取得が試みられること (エラーを誤ってキャッシュしない)。
    #[tokio::test]
    async fn fetch_error_is_not_cached() {
        let cache = test_cache();
        let calls = Arc::new(AtomicUsize::new(0));

        {
            let calls = calls.clone();
            let err = cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err(crate::error::AppError::InvalidInput("boom".into()))
                })
                .await;
            assert!(err.is_err());
        }

        {
            let calls = calls.clone();
            let ok = cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["recovered".to_string()])
                })
                .await
                .unwrap();
            assert_eq!(ok, vec!["recovered".to_string()]);
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "エラー後も再取得が走ること"
        );
    }
}
