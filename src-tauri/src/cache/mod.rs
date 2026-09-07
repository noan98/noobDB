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
use std::sync::atomic::{AtomicU64, Ordering};
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
///
/// **`generation` による invalidate との競合防止 (PR #1101 レビュー指摘)。**
/// ロックを解放して `fetch` を `.await` している間に、その接続の他の操作が
/// `invalidate_all()` を呼んで `generation` をインクリメントすることがある
/// (例: この fetch が DDL 実行前に始まった introspection で、DDL 完了後に
/// 結果が返ってくる場合)。この場合 fetch 自体は成功しても、その結果はもはや
/// 最新のスキーマ状態を反映していない可能性があるため、**呼び出し元へは返すが
/// cache へは書き込まない**。fetch 開始前後で `generation` を比較するだけの
/// 単純な仕組みで、fetch 中ずっと書き込みロックを握る (= introspection 中に
/// 他の操作をブロックする) 方式は採らない。
async fn get_or_fetch_single<V, F, Fut>(
    slot: &RwLock<Option<CacheEntry<V>>>,
    ttl: Duration,
    generation: &AtomicU64,
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
    let generation_before_fetch = generation.load(Ordering::SeqCst);
    let value = fetch().await?;
    {
        // generation の再チェックは **write lock を取得した後**に行う。
        // `invalidate_all()` は generation のインクリメントを各スロットの
        // write lock 取得より必ず先に行うため (invalidate_all の実装参照)、
        // ここで lock を取得できた時点で generation の最新値を確実に読める —
        // チェックとロック取得の間に invalidate が割り込む隙間を作らない
        // (チェックしてからロックを取る順序だと、その隙間で invalidate が
        // 完了してしまい stale な結果を書き戻す余地が残る)。
        let mut guard = slot.write().await;
        if generation.load(Ordering::SeqCst) == generation_before_fetch {
            *guard = Some(CacheEntry::fresh(value.clone()));
        } else {
            tracing::debug!(
                "schema cache: dropping a fetch result that raced with invalidate_all (stale generation)"
            );
        }
    }
    Ok(value)
}

/// キー付きスロット (`tables(db)` / `columns(db, table)` など) の get-or-fetch。
/// ロックの扱い・`generation` による invalidate との競合防止は
/// [`get_or_fetch_single`] と同じ方針。
async fn get_or_fetch<K, V, F, Fut>(
    map: &RwLock<HashMap<K, CacheEntry<V>>>,
    key: K,
    ttl: Duration,
    max_entries: usize,
    generation: &AtomicU64,
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
    let generation_before_fetch = generation.load(Ordering::SeqCst);
    let value = fetch().await?;
    {
        // generation の再チェックは **write lock を取得した後**に行う。
        // 理由は [`get_or_fetch_single`] のコメント参照。
        let mut guard = map.write().await;
        if generation.load(Ordering::SeqCst) == generation_before_fetch {
            if guard.len() >= max_entries && !guard.contains_key(&key) {
                tracing::debug!(
                    max_entries,
                    "schema cache: kind exceeded its entry cap, clearing before insert"
                );
                guard.clear();
            }
            guard.insert(key, CacheEntry::fresh(value.clone()));
        } else {
            tracing::debug!(
                "schema cache: dropping a fetch result that raced with invalidate_all (stale generation)"
            );
        }
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
    /// invalidate 世代カウンタ (PR #1101 レビュー指摘への対応)。
    /// `invalidate_all()` のたびにインクリメントし、各 fetch はロック解放中
    /// (= DB introspection 中) にこの値が変わっていないかを完了後に確認する
    /// ことで、「invalidate と競合した古い fetch 結果が cache に書き戻される」
    /// ことを防ぐ。kind 単位・キー単位の invalidate は現状存在しないが、将来
    /// 追加されても全体で 1 つのカウンタを共有する設計なので同じ仕組みで守れる
    /// (無関係な kind の fetch まで巻き込んで捨てる過剰破棄はあり得るが、
    /// 「次の 1 回だけ再取得が走る」だけで安全側 — invalidate_all 自体の
    /// 「丸ごと破棄」という既存方針と同じ割り切り)。
    generation: AtomicU64,
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
            generation: AtomicU64::new(0),
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
        get_or_fetch_single(&self.databases, self.ttl, &self.generation, fetch).await
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
            &self.generation,
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
            &self.generation,
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
            &self.generation,
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
            &self.generation,
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
            &self.generation,
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
            &self.generation,
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
            &self.generation,
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
    ///
    /// `generation` のインクリメントを各スロットの write lock 取得より**必ず
    /// 先に**行う (PR #1101 レビュー指摘への対応)。`get_or_fetch[_single]` は
    /// 対象スロットの write lock を取得した**後**に generation を再チェックする
    /// ため、この順序を守る限り「fetch がロック解放中に invalidate と競合し、
    /// 古い結果が cache に書き戻ってしまう」ことはない — invalidate 側と
    /// fetch 側のどちらが先にロックを取得しても、fetch 側は必ず最新の
    /// generation を見た上で書き込むかどうかを判断できる。
    pub async fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
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

    /// レビュー指摘 (PR #1101): `invalidate_all()` と fetch の競合。
    ///
    /// `get_or_fetch` はキャッシュミス後の DB introspection 中はロックを解放
    /// している (意図的な設計 — fetch 中に他の操作をブロックしない)。そのため
    /// 「fetch 開始 → (ロック解放中に) DDL 実行 → invalidate_all() → 古い fetch
    /// が完了 → 古い結果を cache に insert」という順序が起こり得て、
    /// invalidate 直後にもかかわらず stale な結果が cache に舞い戻ってしまう。
    ///
    /// fetch クロージャの中で直接 `invalidate_all()` を呼ぶことで、この競合を
    /// sleep なしで決定的に再現する — 「fetch の実行中に invalidate が完了する」
    /// という状況そのものを、タイミングに頼らず組み立てられるため。
    #[tokio::test]
    async fn invalidate_during_fetch_does_not_resurrect_the_stale_value() {
        let cache = test_cache();

        // fetch がまだ cache へ書き込む前に invalidate_all() が完了するケースを
        // 直接組み立てる。fetch 自体は成功して stale な値を返す — DDL 実行前に
        // 読み始めた古い introspection が、DDL 完了後になって結果を返してくる
        // のと同じ形。
        let stale = cache
            .tables("db", || async {
                cache.invalidate_all().await;
                Ok(vec!["stale".to_string()])
            })
            .await
            .unwrap();
        // 呼び出し元への返り値自体は、fetch した時点では正しい結果なので
        // stale のままでよい — invalidate との競合が守るべきは「cache に
        // 書き戻さない」ことだけ。
        assert_eq!(stale, vec!["stale".to_string()]);

        // invalidate 後の cache に古い値が残っていないこと — 次の呼び出しで
        // 必ず fetch が再実行されること (再実行されなければ "stale" が
        // キャッシュから返ってきてしまう = このテストが検出したい stale 表示)。
        let calls = Arc::new(AtomicUsize::new(0));
        let fresh = {
            let calls = calls.clone();
            cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["fresh".to_string()])
                })
                .await
                .unwrap()
        };
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "invalidate と競合した古い fetch の結果が cache に居座ってはいけない"
        );
        assert_eq!(fresh, vec!["fresh".to_string()]);
    }

    /// 上と同じ競合を `get_or_fetch_single` (`databases()`) 側でも固定する。
    #[tokio::test]
    async fn invalidate_during_fetch_does_not_resurrect_the_stale_databases_value() {
        let cache = test_cache();

        let stale = cache
            .databases(|| async {
                cache.invalidate_all().await;
                Ok(vec!["stale_db".to_string()])
            })
            .await
            .unwrap();
        assert_eq!(stale, vec!["stale_db".to_string()]);

        let calls = Arc::new(AtomicUsize::new(0));
        let fresh = {
            let calls = calls.clone();
            cache
                .databases(|| async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["fresh_db".to_string()])
                })
                .await
                .unwrap()
        };
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "invalidate と競合した古い fetch の結果が cache に居座ってはいけない"
        );
        assert_eq!(fresh, vec!["fresh_db".to_string()]);
    }

    /// レビュー指摘 (PR #1101) の再現手順そのものを、2 つの独立したタスクを
    /// 実際に並行実行させる形で固定する (`oneshot` channel による決定的な
    /// 同期 — sleep でのタイミング依存は使わない)。オーナーが列挙した 5 ステップ
    /// をそれぞれ明示的に検証する:
    ///
    /// 1. fetch 開始 (DB introspection 相当を開始し、ロックを解放して待機に入る)
    /// 2. `invalidate_all()` 実行 (fetch がまだ進行中のうちに完了させる)
    /// 3. fetch 完了 (invalidate 完了の合図を受けてから古い値を返す)
    /// 4. fetch 結果が cache に登録されていないことを確認 (内部状態を直接検査)
    /// 5. 次回アクセスで最新 schema が取得されることを確認 (再取得が実際に走る)
    #[tokio::test]
    async fn concurrent_invalidate_during_an_in_flight_fetch_does_not_resurrect_stale_value() {
        let cache = Arc::new(test_cache());

        // fetch が「DB introspection を開始した」ことをテスト側へ知らせる合図と、
        // テスト側が「invalidate_all() を完了した」ことを fetch へ知らせる合図。
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (invalidated_tx, invalidated_rx) = tokio::sync::oneshot::channel::<()>();

        // --- 1. fetch 開始: 別タスクとして spawn し、実際に並行実行させる ---
        let cache_for_fetch = cache.clone();
        let fetch_task = tokio::spawn(async move {
            cache_for_fetch
                .tables("db", move || async move {
                    // read lock は既に get_or_fetch 内で解放済み (このクロージャに
                    // 入っている時点で「ロック解放中の DB introspection」中)。
                    started_tx
                        .send(())
                        .expect("test still waiting on started_rx");
                    // invalidate_all() が完了するまで、ここで実際に待機する —
                    // sleep ではなく channel 受信によるタイミング非依存の同期。
                    invalidated_rx.await.expect("invalidated_tx must fire");
                    Ok(vec!["stale".to_string()])
                })
                .await
        });

        // fetch が開始する (= ロックを解放して introspection に入る) のを待つ。
        started_rx.await.expect("fetch task must signal start");

        // --- 2. invalidate_all() 実行: fetch がまだ進行中のうちに完了させる ---
        cache.invalidate_all().await;
        invalidated_tx
            .send(())
            .expect("fetch task must still be awaiting the signal");

        // --- 3. fetch 完了 ---
        let stale = fetch_task
            .await
            .expect("fetch task must not panic")
            .expect("fetch itself must succeed");
        // 呼び出し元への返り値自体は、fetch した時点では正しい結果なので
        // stale のままでよい — invalidate との競合が守るべきは cache への
        // 書き込みだけ。
        assert_eq!(stale, vec!["stale".to_string()]);

        // --- 4. fetch 結果が cache に登録されていないことを確認 ---
        assert!(
            cache.tables.read().await.is_empty(),
            "invalidate と競合した fetch の結果が cache に書き戻ってはいけない"
        );

        // --- 5. 次回アクセスで最新 schema が取得されることを確認 ---
        let calls = Arc::new(AtomicUsize::new(0));
        let fresh = {
            let calls = calls.clone();
            cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["fresh".to_string()])
                })
                .await
                .unwrap()
        };
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "cache に stale な値が残っていなければ、次のアクセスで必ず再取得が走るはず"
        );
        assert_eq!(fresh, vec!["fresh".to_string()]);
    }
}
