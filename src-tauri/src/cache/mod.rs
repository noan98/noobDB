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
//! ## single-flight (同時ミスの合流、#1107)
//!
//! 同一キーへの呼び出しが同時にミスしたとき、実際に `fetch` (DB introspection /
//! クエリ実行) を走らせるのは最初の 1 呼び出し (リーダー) だけで、残りはその
//! 結末を待つ (接続直後にスキーマ関連の UI が一斉に立ち上がる場面で、同じ
//! introspection が重複して走らないようにする)。Schema Cache の全 kind と
//! Query Result Cache が同じ実装 ([`KeyedCache::get_or_fetch`]) を共有する。
//!
//! - **fetch 中はロックを保持しない。** in-flight 表は `std::sync::Mutex` で、
//!   表の参照・更新の瞬間だけ取り、`.await` を跨いで保持しない。結末の配布は
//!   `tokio::sync::watch` で行う (#1101 レビュー方針: introspection 中に他の
//!   操作をブロックしない)。
//! - **generation (#1105) と整合させる。** 合流できるのは fetch 開始時点と
//!   同じ世代の呼び出しだけ。待ち合わせ中に `invalidate_all()` が走ったら、
//!   待機者は共有結果を受け取らずに新しい世代でやり直す (stale を掴まない)。
//!   リーダー自身の返り値と「cache へは書かない」挙動は従来どおり。
//! - **エラー**: キャッシュしない。待機者は自分の fetch を 1 回だけ直接実行する
//!   (エラーの `kind` を保つため、リーダーのエラーは複製しない)。
//! - **キャンセル (future の drop)・パニック**: リーダーのガードの `Drop` が
//!   in-flight 表を片付け、結末を送らないまま送信側が閉じるので、待機者は
//!   永久には待たずにやり直す (1 人が新しいリーダーになり、残りはそこへ合流)。
//!
//! ## Query Result Cache
//!
//! Schema Cache とは別の、実行結果 (行データそのもの) を対象にしたキャッシュ。
//! 行データは Schema (テーブル/カラム定義) と違って**機微データそのもの**であり、
//! かつ書き込みによって Schema よりずっと頻繁に陳腐化するため、Schema Cache より
//! ずっと保守的に — 「限定的に導入」する (Issue #1097 本文の方針どおり)。
//!
//! ### 対象 (何をキャッシュするか)
//!
//! - **[`crate::commands::query::run_query`] (非ストリーミング経路) だけ。**
//!   ストリーミング経路 (`run_query_stream`) は行を貯めずに小さなチャンクへ
//!   分割して流すのが設計上の利点であり、そこへ「結果セット全体を保持する」
//!   キャッシュを持ち込むと、大量データを無制限に保持しないという Epic #1093
//!   の方針と正面から衝突する。streaming 経路はキャッシュを読み書きしない
//!   (書き込みが起きた場合の invalidate だけは受け取る — 後述)。
//! - **[`crate::db::is_read_only_sql_for`] で読み取り専用と判定できる SQL のみ。**
//!   書き込み文をキャッシュするのは無意味 (結果は rows_affected のみで再利用の
//!   価値がない) かつ危険 (再実行の副作用を握りつぶすことになる) なので、
//!   [`QueryResultCache::get_or_fetch`] は書き込み文に対してはキャッシュへ
//!   一切触れず `fetch` を素通しする。
//! - **行数・バイト数のどちらかが上限を超える結果はキャッシュしない**
//!   ([`DEFAULT_QUERY_MAX_ROWS`] / [`DEFAULT_QUERY_MAX_BYTES`])。呼び出し元へは
//!   結果をそのまま返すが、キャッシュへの insert だけをスキップする — 大量結果を
//!   「キャッシュのために」余分にメモリへ複製し続けることを避ける (Epic #1093)。
//!
//! ### 効果が確認できるユースケース
//!
//! テーブルブラウズのページング (`App.tsx` の `goToPageInTab`) は、既に表示した
//! ページへ戻ると**同一の SQL 文字列** (同じ `LIMIT`/`OFFSET`、同じ
//! ORDER/FILTER) を `api.runQuery` 経由で再実行する — フロント側はページの
//! 内容をキャッシュしておらず、都度サーバへ問い合わせる設計になっているため、
//! 「同一クエリの再表示」という Issue が挙げるユースケースがまさにここに実在する
//! (影響行数プリフライトの COUNT (`usePreflightImpact`) は編集のたびに SQL 自体が
//! 変わるため対象外 — 再実行が同一クエリになる保証がない)。この 1 経路のために
//! 導入するので、TTL・容量とも小さく抑える (下記)。
//!
//! ### キー設計
//!
//! `(database, sql)` の組。`sql` は正規化せず実行時の文字列と完全一致でのみ
//! ヒットする — わずかな表記ゆれ (空白の増減など) でミスしても「再実行が走る
//! だけ」で安全だが、逆に異なる意味の SQL を同一視するリスクはゼロにできる。
//! `database` を含めるのは、同じ SQL でもアクティブな DB コンテキストが違えば
//! (未修飾のテーブル参照などで) 結果が変わりうるため。auto-limit の適用有無は
//! `run_query` 自体が LIMIT を注入しない (ストリーミング経路専用の機能) ので
//! キーに含める必要がない。
//!
//! ### invalidate 条件 (Schema Cache より広い)
//!
//! Schema Cache は DDL だけを見れば足りたが、Query Result Cache は **DML でも
//! stale になる**。判定は [`crate::db::is_read_only_sql_for`] を正とする —
//! DDL/DML を問わず「読み取り専用でない」と判定された SQL が成功したら、その
//! セッションの Query Result Cache を丸ごと invalidate する。書き込みが起こり
//! うる経路を洗い出すと:
//!
//! 1. [`crate::commands::query::run_query_inner`] — 単文実行。
//! 2. [`crate::commands::query::run_query_transaction_inner`] — 一括実行。
//!    束ねた文のいずれか 1 つでも書き込みなら丸ごと invalidate。
//! 3. [`crate::commands::query::run_in_transaction_inner`] — 明示トランザクション
//!    内の 1 文。COMMIT を待たず即時 invalidate する (Schema Cache と同じ
//!    fail-closed の理由 — ROLLBACK されれば「次の 1 回だけ無駄な再取得」という
//!    安全側のコストで済む)。
//! 4. `spawn_query_stream` (`run_query_stream` の非 capture 経路) — ストリーミング
//!    実行自体はキャッシュを読み書きしないが、書き込み文をここ経由で実行できる
//!    以上、他の経路がキャッシュした結果を stale にしうるため invalidate だけは行う。
//! 5. `spawn_captured_write` / [`crate::commands::flight_recorder::run_captured_write_inner`]
//!    — DML フライトレコーダのキャプチャ付き書き込み (INSERT/UPDATE/DELETE)。
//!    Undo (`undo_flight_record_inner`) は 2. の
//!    `run_query_transaction_inner` を再利用するので個別の対応は不要。
//! 6. [`crate::commands::sync::apply_sync_sql_inner`] — スキーマ同期・データ同期
//!    の適用。目的自体が対象を書き換えることなので常に invalidate。
//! 7. [`crate::commands::sandbox::sandbox_advance_base_inner`] — サンドボックスの
//!    base スナップショット (shadow テーブル) への書き込み。ライブテーブルの
//!    データ自体は変えないが、shadow テーブルを直接 SELECT すれば見えるため
//!    安全側で invalidate する。
//! 8. `commands::import::spawn_import` (CSV/JSON インポート) — バルク書き込み。
//! 9. [`crate::commands::local::register_local_table_inner`] /
//!    [`crate::commands::local::drop_local_table_inner`] — ローカル横断クエリ
//!    (#740) のローカルセッション自身のテーブルへの登録/削除。
//!
//! 逆に **invalidate しない**と判断したもの:
//!
//! - [`crate::commands::privileges::apply_privilege_sql_inner`] — GRANT/REVOKE/
//!   CREATE USER/DROP USER/ALTER PASSWORD はユーザ・権限を変えるだけで、
//!   テーブルの行データには一切影響しない (Schema Cache も同じ理由で対象外に
//!   している既存コメント参照)。
//! - `commands::diff` / サンドボックスの diff 系コマンド — 比較のための
//!   `SELECT` のみで、書き込みは発生しない。
//!
//! 判断に迷う場合は Schema Cache と同じく**安全側 (invalidate する)** に倒す —
//! 過剰な破棄は「次の 1 回だけ再取得が走る」コストに留まるが、見逃しは stale
//! データによる誤操作という実害に直結するため。
//!
//! ### TTL・容量上限
//!
//! - **TTL は [`DEFAULT_QUERY_TTL`] (30 秒)。** Schema Cache (5 分) よりずっと
//!   短い — 行データはスキーマ構造よりずっと変わりやすく、かつ noobDB を経由
//!   しない書き込み (別クライアント・別ツール・他ユーザ) は上記の invalidate
//!   条件では一切捕捉できないため、「同一クエリの再表示」という短時間の
//!   ユースケースを満たす範囲でできるだけ短く取る。
//! - **エントリあたり [`DEFAULT_QUERY_MAX_ROWS`] 行 / [`DEFAULT_QUERY_MAX_BYTES`]
//!   バイトを超える結果はキャッシュしない。**
//! - **セッションあたり最大 [`DEFAULT_QUERY_MAX_ENTRIES`] 件。** Schema Cache
//!   (500) よりずっと小さく取る — ここに乗る値は実際の行データ (機微データ
//!   そのもの) なので、保持するインスタンス数自体を絞ってワーストケースの
//!   メモリ使用量を小さく保つ。超過時の挙動は Schema Cache と同じ「丸ごと
//!   clear してから挿入」(部分的な LRU 追い出しはしない、単純さを優先)。
//!
//! ### 機微データの保存方針 (受け入れ条件)
//!
//! - **ディスクには絶対に書かない。** プロセスメモリ (`HashMap` 上) にのみ存在し、
//!   `profiles.json` のような永続化ストアには一切触れない。
//! - **ログにはキャッシュの内容 (SQL 本文・セル値) を出さない。** ヒット/ミス・
//!   invalidate・容量超過のログはすべて `tracing::debug!` で、件数や真偽値だけを
//!   載せ、SQL 文字列や行データそのものは載せない (`sql_summary` のような
//!   切り詰めすら経由しない — 単に出さない)。
//! - **切断・再接続・プロセス終了で必ず消える。** Schema Cache と同じく
//!   `Session` のフィールドとして存在する (下記) ため、`reconnect` の
//!   セッション差し替えやプロセス終了でインスタンスごと消える。
//!
//! ### 接続単位の分離
//!
//! Schema Cache と同じ方式 — `QueryResultCache` はグローバルな Map ではなく
//! [`crate::state::Session`] のフィールドとして存在する。別セッションの
//! `QueryResultCache` へ到達する経路は型として存在しないため、「接続をまたいだ
//! キャッシュ汚染」はそもそも起こり得ない。

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::{watch, RwLock};

use crate::db::types::{
    ForeignKey, IndexInfo, QueryResult, SchemaObject, TableColumnInfo, TableRowIdentity,
    TableSchema, Value,
};
use crate::db::{is_read_only_sql_for, DriverKind};
use crate::error::{AppError, Result};

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

/// single-flight で共有する fetch の結末 (#1107)。リーダー (実際に `fetch` を
/// 実行した呼び出し) が `watch` チャネルで待機者へ配る。
#[derive(Clone)]
enum FlightOutcome<V> {
    /// fetch が成功した。待機者は (generation が変わっていなければ) この値を返す。
    Value(V),
    /// fetch がエラーを返した。`AppError` は `Clone` できず、かつ `kind`
    /// (`connectionLost` など UI の復帰導線を決める判別子) を保ったまま複製する
    /// 手段がないため、エラー本体は配らない。待機者は各自の `fetch` を 1 回だけ
    /// 直接実行し、自分自身のエラー (または回復した値) を受け取る
    /// ([`KeyedCache::get_or_fetch`] 参照)。
    Failed,
}

type FlightTx<V> = watch::Sender<Option<FlightOutcome<V>>>;
type FlightRx<V> = watch::Receiver<Option<FlightOutcome<V>>>;

/// 1 キーぶんの進行中 fetch。`generation` は fetch 開始時点の invalidate 世代で、
/// 合流できるのは**同じ世代の呼び出しだけ** — invalidate 後に来た呼び出しが
/// invalidate 前に始まった fetch (= stale かもしれない結果) に相乗りしない。
struct Flight<V> {
    id: u64,
    generation: u64,
    /// 合流した待機者の数 (ログとテストの同期用。値の正しさには関与しない)。
    waiters: usize,
    rx: FlightRx<V>,
}

enum FlightRole<V> {
    /// 同じ世代の fetch が進行中なので、その結末を待つ。
    Wait(FlightRx<V>),
    /// 自分がリーダーとして fetch を実行する。
    Lead { id: u64, tx: FlightTx<V> },
}

/// リーダーが持つ後始末用ガード。正常終了・エラー・**キャンセル (future の
/// drop)・パニック (巻き戻しによる drop)** のどの経路でも `Drop` が走り、
/// in-flight 表から自分のエントリを取り除く。フィールドの `tx` は `drop` 本体の
/// **後**に破棄されるため、「表からは消えたが送信側は生きている」順序になる —
/// 逆順 (送信側だけ先に閉じて表に残る) だと、閉じたフライトへ新しい呼び出しが
/// 合流して空振りを繰り返す窓ができてしまう。結末を送らずに `tx` が閉じると
/// 待機者の `changed()` がエラーになり、待機者は永久に待たずに再試行する。
struct FlightGuard<'a, K: Eq + Hash, V> {
    flights: &'a StdMutex<HashMap<K, Flight<V>>>,
    key: K,
    id: u64,
    tx: FlightTx<V>,
}

impl<K: Eq + Hash, V> Drop for FlightGuard<'_, K, V> {
    fn drop(&mut self) {
        let mut flights = lock_flights(self.flights);
        // invalidate 後に同じキーで新しい世代のフライトが登録されている
        // (= 表のエントリが既に差し替わっている) ことがあるので、自分の id の
        // ときだけ取り除く。
        if flights.get(&self.key).is_some_and(|f| f.id == self.id) {
            flights.remove(&self.key);
        }
    }
}

/// in-flight 表のロックを取る。保持するのは表の参照・更新の間だけで、
/// **`.await` を跨いで保持しない** (だから非同期ロックではなく `std` の
/// `Mutex` で足り、`Drop` からも取れる)。ポイズン (保持中のパニック) は表を
/// 壊す操作 (途中までの更新) を伴わないので、中身をそのまま使って続行する。
fn lock_flights<K, V>(
    flights: &StdMutex<HashMap<K, Flight<V>>>,
) -> MutexGuard<'_, HashMap<K, Flight<V>>> {
    flights.lock().unwrap_or_else(PoisonError::into_inner)
}

/// リーダーの結末を待つ。結末が届けば `Some`、結末を送らずにリーダーが消えた
/// (キャンセル・パニック) なら `None`。
async fn wait_for_flight<V: Clone>(mut rx: FlightRx<V>) -> Option<FlightOutcome<V>> {
    loop {
        let current = rx.borrow_and_update().clone();
        if current.is_some() {
            return current;
        }
        if rx.changed().await.is_err() {
            // 送信側が閉じた。閉じる直前に結末が送られていればそれを返す。
            return rx.borrow().clone();
        }
    }
}

/// キー付きのキャッシュスロット 1 kind 分 (`tables` / `columns` / クエリ結果など)。
/// 値の本体 (`entries`) と、同一キーへの同時ミスを 1 回の fetch にまとめる
/// single-flight の in-flight 表 (`flights`、#1107) を組にして持つ。
struct KeyedCache<K, V> {
    /// ログに載せる種別名 (`"schema cache"` など)。キーや値の中身は載せない。
    label: &'static str,
    entries: RwLock<HashMap<K, CacheEntry<V>>>,
    flights: StdMutex<HashMap<K, Flight<V>>>,
    next_flight_id: AtomicU64,
}

impl<K, V> KeyedCache<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone,
{
    fn new(label: &'static str) -> Self {
        Self {
            label,
            entries: RwLock::new(HashMap::new()),
            flights: StdMutex::new(HashMap::new()),
            next_flight_id: AtomicU64::new(0),
        }
    }

    /// 値だけを捨てる。進行中のフライトは触らない — `generation` の
    /// インクリメント (呼び出し元の `invalidate_all` が先に行う) により、
    /// 以後の呼び出しは旧世代のフライトに合流せず、旧世代の結果は cache へ
    /// 書き戻らず、旧世代を待っていた待機者も結果を受け取らずに再試行する。
    async fn clear(&self) {
        self.entries.write().await.clear();
    }

    async fn lookup(&self, key: &K, ttl: Duration) -> Option<V> {
        let guard = self.entries.read().await;
        guard
            .get(key)
            .filter(|entry| !entry.is_expired(ttl))
            .map(|entry| entry.value.clone())
    }

    fn join_or_lead(&self, key: &K, generation: u64) -> FlightRole<V> {
        let mut flights = lock_flights(&self.flights);
        if let Some(flight) = flights.get_mut(key) {
            if flight.generation == generation {
                flight.waiters += 1;
                tracing::debug!(
                    waiters = flight.waiters,
                    "{}: joined an in-flight fetch (single-flight)",
                    self.label
                );
                return FlightRole::Wait(flight.rx.clone());
            }
        }
        // 進行中のフライトが無い、または旧世代 (invalidate 前に始まった) の
        // フライトしか無い — 自分がリーダーになる。旧世代のエントリは差し替える
        // (旧リーダーのガードは id が違うので新しいエントリを消さない)。
        let (tx, rx) = watch::channel(None);
        let id = self.next_flight_id.fetch_add(1, Ordering::Relaxed);
        flights.insert(
            key.clone(),
            Flight {
                id,
                generation,
                waiters: 0,
                rx,
            },
        );
        FlightRole::Lead { id, tx }
    }

    /// `fetch` を実行し、成功かつ `cacheable` なら generation を再確認してから
    /// cache へ書く。ロックは fetch 中には一切保持しない。
    ///
    /// **`generation` による invalidate との競合防止 (PR #1101 レビュー指摘)。**
    /// fetch を `.await` している間に `invalidate_all()` が `generation` を
    /// インクリメントすることがある (例: DDL 実行前に始まった introspection が
    /// DDL 完了後に返ってくる)。この場合 fetch 結果は最新でない可能性があるため、
    /// **呼び出し元へは返すが cache へは書き込まない**。再チェックは write lock を
    /// 取得した**後**に行う — `invalidate_all()` は generation のインクリメントを
    /// 各スロットの write lock 取得より必ず先に行うため、ロック取得後なら
    /// generation の最新値を確実に読める (チェックしてからロックを取る順序だと、
    /// その隙間で invalidate が完了して stale な結果を書き戻す余地が残る)。
    async fn fetch_and_store<F, Fut, C>(
        &self,
        key: K,
        generation_before_fetch: u64,
        max_entries: usize,
        generation: &AtomicU64,
        cacheable: &C,
        fetch: F,
    ) -> Result<V>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V>>,
        C: Fn(&V) -> bool,
    {
        let value = fetch().await?;
        if cacheable(&value) {
            let mut guard = self.entries.write().await;
            if generation.load(Ordering::SeqCst) == generation_before_fetch {
                if guard.len() >= max_entries && !guard.contains_key(&key) {
                    tracing::debug!(
                        max_entries,
                        "{}: kind exceeded its entry cap, clearing before insert",
                        self.label
                    );
                    guard.clear();
                }
                guard.insert(key, CacheEntry::fresh(value.clone()));
            } else {
                tracing::debug!(
                    "{}: dropping a fetch result that raced with invalidate_all (stale generation)",
                    self.label
                );
            }
        }
        Ok(value)
    }

    /// get-or-fetch 本体 (single-flight 付き、#1107)。
    ///
    /// 1. cache を読み取りロックで引き、ヒットすれば即返す (ロックは即解放)。
    /// 2. ミスしたら in-flight 表を見る。**同じキー・同じ generation** の fetch が
    ///    進行中ならそれに合流して結末を待ち、無ければ自分がリーダーとして
    ///    fetch を実行する。fetch 中はどのロックも保持しない (introspection 中に
    ///    他の操作をブロックしない、#1101 レビュー方針)。
    /// 3. リーダーは結果を (generation を再確認してから) cache に書き、結末を
    ///    待機者へ配る。**リーダー自身は fetch 結果を必ず返す** — invalidate と
    ///    競合した場合でも「呼び出し元へは返すが cache へは書かない」という
    ///    #1105 以来の挙動を保つ。
    ///
    /// 待機者側の扱い:
    ///
    /// - **成功**: 待ち始めた時点の generation がまだ最新なら値を受け取る。
    ///   待っている間に `invalidate_all()` が走っていたら、その値は invalidate 前
    ///   の状態かもしれないので**受け取らずに 1. からやり直す** (新しい世代で
    ///   改めて合流またはリーダーになる) — invalidate 後の呼び出しに stale な値を
    ///   返さない。
    /// - **エラー**: エラーはキャッシュしない (従来どおり)。待機者は自分の
    ///   `fetch` を 1 回だけ直接実行して、その結果を返す ([`FlightOutcome::Failed`]
    ///   参照)。もう一度合流させないのは、DB が落ちている間に待機者が 1 人ずつ
    ///   順番にリーダーになってタイムアウトを直列に積み上げるのを避けるため。
    /// - **リーダーのキャンセル・パニック**: 結末が届かないまま送信側が閉じるので
    ///   待機者は永久には待たず、1. からやり直す (うち 1 人が新しいリーダーになる)。
    async fn get_or_fetch<F, Fut, C>(
        &self,
        key: K,
        ttl: Duration,
        max_entries: usize,
        generation: &AtomicU64,
        cacheable: C,
        fetch: F,
    ) -> Result<V>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V>>,
        C: Fn(&V) -> bool,
    {
        // 待機者として再試行した末に自分がリーダーになることがあるので、
        // `FnOnce` の fetch は使うときに取り出す。取り出した分岐は必ず return
        // するため、2 回取り出されることはない。
        let mut fetch = Some(fetch);
        loop {
            if let Some(value) = self.lookup(&key, ttl).await {
                return Ok(value);
            }
            let generation_now = generation.load(Ordering::SeqCst);
            match self.join_or_lead(&key, generation_now) {
                FlightRole::Wait(rx) => match wait_for_flight(rx).await {
                    Some(FlightOutcome::Value(value))
                        if generation.load(Ordering::SeqCst) == generation_now =>
                    {
                        return Ok(value);
                    }
                    Some(FlightOutcome::Value(_)) => {
                        tracing::debug!(
                            "{}: discarding a shared fetch result that raced with invalidate_all; retrying",
                            self.label
                        );
                    }
                    Some(FlightOutcome::Failed) => {
                        let fetch = take_fetch(&mut fetch)?;
                        let generation_before_fetch = generation.load(Ordering::SeqCst);
                        return self
                            .fetch_and_store(
                                key,
                                generation_before_fetch,
                                max_entries,
                                generation,
                                &cacheable,
                                fetch,
                            )
                            .await;
                    }
                    None => {
                        tracing::debug!(
                            "{}: the in-flight fetch was cancelled or panicked; retrying",
                            self.label
                        );
                    }
                },
                FlightRole::Lead { id, tx } => {
                    let guard = FlightGuard {
                        flights: &self.flights,
                        key: key.clone(),
                        id,
                        tx,
                    };
                    // 1. の lookup とリーダー登録の間に、先行リーダーが cache へ
                    // 書いてフライトを片付け終えていることがある (リーダーは
                    // 「cache へ書く → フライトを消す」の順なので、フライトが
                    // 無いのに cache にはある状態が起こりうる)。登録後にもう一度
                    // 引いて、その隙間での重複 fetch を防ぐ。
                    if let Some(value) = self.lookup(&key, ttl).await {
                        guard
                            .tx
                            .send_replace(Some(FlightOutcome::Value(value.clone())));
                        return Ok(value);
                    }
                    let fetch = take_fetch(&mut fetch)?;
                    let result = self
                        .fetch_and_store(
                            key,
                            generation_now,
                            max_entries,
                            generation,
                            &cacheable,
                            fetch,
                        )
                        .await;
                    guard.tx.send_replace(Some(match &result {
                        Ok(value) => FlightOutcome::Value(value.clone()),
                        Err(_) => FlightOutcome::Failed,
                    }));
                    return result;
                }
            }
        }
    }

    /// テスト用: `key` の進行中フライトに合流している待機者の数。フライトが
    /// 無ければ 0。
    #[cfg(test)]
    fn flight_waiters(&self, key: &K) -> usize {
        lock_flights(&self.flights)
            .get(key)
            .map_or(0, |flight| flight.waiters)
    }
}

/// `get_or_fetch` のループ内で `FnOnce` の fetch を取り出す。取り出した分岐は
/// 必ず return するので `None` にはならないが、本体コードで `expect` を使わない
/// 規約 (#527) に従いエラーとして扱う。
fn take_fetch<F>(fetch: &mut Option<F>) -> Result<F> {
    fetch.take().ok_or_else(|| {
        AppError::Other("cache: fetch closure was already consumed (internal bug)".into())
    })
}

/// Schema Cache の全 kind が使う「常にキャッシュ対象」述語 (Query Result Cache
/// だけは行数・バイト数の上限で絞る)。
fn always_cacheable<V>(_: &V) -> bool {
    true
}

/// Schema Cache のログ上の種別名。
const SCHEMA_CACHE_LABEL: &str = "schema cache";

/// `(database, table)` の複合キー。`columns` / `row_identity` / `list_indexes`
/// で共有する。
type TableKey = (String, String);

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
    /// 接続全体で 1 件しかない `databases()` は、キー `()` の [`KeyedCache`]
    /// として持つ (single-flight・generation の扱いを他の kind と共通化する)。
    databases: KeyedCache<(), Vec<String>>,
    tables: KeyedCache<String, Vec<String>>,
    columns: KeyedCache<TableKey, Vec<TableColumnInfo>>,
    row_identity: KeyedCache<TableKey, TableRowIdentity>,
    schema_overview: KeyedCache<String, Vec<TableSchema>>,
    foreign_keys: KeyedCache<String, Vec<ForeignKey>>,
    schema_objects: KeyedCache<String, Vec<SchemaObject>>,
    list_indexes: KeyedCache<TableKey, Vec<IndexInfo>>,
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
            databases: KeyedCache::new(SCHEMA_CACHE_LABEL),
            tables: KeyedCache::new(SCHEMA_CACHE_LABEL),
            columns: KeyedCache::new(SCHEMA_CACHE_LABEL),
            row_identity: KeyedCache::new(SCHEMA_CACHE_LABEL),
            schema_overview: KeyedCache::new(SCHEMA_CACHE_LABEL),
            foreign_keys: KeyedCache::new(SCHEMA_CACHE_LABEL),
            schema_objects: KeyedCache::new(SCHEMA_CACHE_LABEL),
            list_indexes: KeyedCache::new(SCHEMA_CACHE_LABEL),
        }
    }

    pub async fn databases<F, Fut>(&self, fetch: F) -> Result<Vec<String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<String>>>,
    {
        self.databases
            .get_or_fetch(
                (),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
                fetch,
            )
            .await
    }

    pub async fn tables<F, Fut>(&self, database: &str, fetch: F) -> Result<Vec<String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<String>>>,
    {
        self.tables
            .get_or_fetch(
                database.to_string(),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
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
        self.columns
            .get_or_fetch(
                (database.to_string(), table.to_string()),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
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
        self.row_identity
            .get_or_fetch(
                (database.to_string(), table.to_string()),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
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
        self.schema_overview
            .get_or_fetch(
                database.to_string(),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
                fetch,
            )
            .await
    }

    pub async fn foreign_keys<F, Fut>(&self, database: &str, fetch: F) -> Result<Vec<ForeignKey>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<ForeignKey>>>,
    {
        self.foreign_keys
            .get_or_fetch(
                database.to_string(),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
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
        self.schema_objects
            .get_or_fetch(
                database.to_string(),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
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
        self.list_indexes
            .get_or_fetch(
                (database.to_string(), table.to_string()),
                self.ttl,
                self.max_entries_per_kind,
                &self.generation,
                always_cacheable,
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
        self.databases.clear().await;
        self.tables.clear().await;
        self.columns.clear().await;
        self.row_identity.clear().await;
        self.schema_overview.clear().await;
        self.foreign_keys.clear().await;
        self.schema_objects.clear().await;
        self.list_indexes.clear().await;
        tracing::debug!("schema cache invalidated");
    }
}

// ── Query Result Cache (#1097) ──

/// `(database, sql)` の組。モジュールドキュメントの「キー設計」参照。
type QueryCacheKey = (Option<String>, String);

/// キャッシュエントリの既定 TTL。モジュールドキュメント「TTL・容量上限」参照。
const DEFAULT_QUERY_TTL: Duration = Duration::from_secs(30);

/// キャッシュ 1 エントリが持ってよい最大行数。フロント既定の auto-limit
/// (`DEFAULT_AUTO_LIMIT_COUNT` = 1000、`src/settings.ts`) に合わせた「対話的に
/// 妥当なサイズ」の上限。超える結果はキャッシュ対象外 (呼び出し元へはそのまま返す)。
const DEFAULT_QUERY_MAX_ROWS: usize = 1000;

/// キャッシュ 1 エントリが持ってよい最大バイト数 (概算、[`estimate_query_result_bytes`]
/// 参照)。行数の上限だけでは大きな TEXT/BLOB 列 1 つで簡単に超過するため独立に持つ。
const DEFAULT_QUERY_MAX_BYTES: usize = 1024 * 1024; // 1 MiB

/// セッションあたりの最大エントリ数。モジュールドキュメント「TTL・容量上限」参照。
const DEFAULT_QUERY_MAX_ENTRIES: usize = 20;

/// `result` のおおよそのメモリ占有バイト数を見積もる。`perf::approx_rows_bytes`
/// (値 1 個あたり一律 12 バイトという相対比較用の粗い係数) と異なり、こちらは
/// 文字列/バイナリセルの実長を数える — キャッシュ容量の実効的な上限として機能
/// させる以上、大きな TEXT/BLOB を含む結果を過小評価してはいけないため、
/// 用途に応じてあえて別の (より正確な) 見積もりを使う。
fn estimate_query_result_bytes(result: &QueryResult) -> usize {
    let columns_bytes: usize = result
        .columns
        .iter()
        .map(|c| c.name.len() + c.type_name.len())
        .sum();
    let rows_bytes: usize = result
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|v| match v {
                    Value::Null | Value::Bool(_) => 1,
                    Value::Int(_) | Value::UInt(_) | Value::Float(_) => 8,
                    // Bytes は既に hex 文字列へエンコード済み (`Value` のドキュ
                    // メント参照) なので、String と同じく `len()` が実際の占有量。
                    Value::String(s) | Value::Bytes(s) => s.len(),
                })
                .sum::<usize>()
        })
        .sum();
    columns_bytes + rows_bytes
}

/// セッション (接続) 単位のクエリ結果キャッシュ。モジュールドキュメント参照。
pub struct QueryResultCache {
    ttl: Duration,
    max_entries: usize,
    max_rows: usize,
    max_bytes: usize,
    /// invalidate 世代カウンタ。`SchemaCache::generation` と同じ役割・同じ
    /// 仕組みで「invalidate と競合した in-flight fetch の結果が cache に
    /// 書き戻る」ことを防ぐ (詳細は [`KeyedCache::get_or_fetch`] のドキュメント参照)。
    generation: AtomicU64,
    entries: KeyedCache<QueryCacheKey, QueryResult>,
}

impl Default for QueryResultCache {
    fn default() -> Self {
        Self::new(
            DEFAULT_QUERY_TTL,
            DEFAULT_QUERY_MAX_ENTRIES,
            DEFAULT_QUERY_MAX_ROWS,
            DEFAULT_QUERY_MAX_BYTES,
        )
    }
}

impl QueryResultCache {
    /// テスト用に TTL / 容量上限を差し替えられるコンストラクタ。本体コードは
    /// 常に `QueryResultCache::default()` (= `Session` 生成時) を使う。
    fn new(ttl: Duration, max_entries: usize, max_rows: usize, max_bytes: usize) -> Self {
        Self {
            ttl,
            max_entries,
            max_rows,
            max_bytes,
            generation: AtomicU64::new(0),
            entries: KeyedCache::new("query result cache"),
        }
    }

    /// `driver`/`sql` から読み取り専用と判定できるときだけキャッシュを consult
    /// する。書き込み文はそもそもキャッシュを読み書きしない — `fetch` を素通しで
    /// 実行して結果を返すだけで、呼び出し元 (`commands::query` 等) が成功後に
    /// [`invalidate_all`](Self::invalidate_all) を呼ぶ前提 (モジュールドキュメント
    /// 「invalidate 条件」参照)。
    ///
    /// キャッシュヒット時は `fetch` を一切呼ばない。ミス時は `fetch` を実行し、
    /// 結果が行数・バイト数の上限内であれば cache へ insert してから返す
    /// (上限超過時は insert だけをスキップし、呼び出し元へは結果をそのまま返す)。
    ///
    /// ロックの扱い・`generation` による invalidate との競合防止・同一キーへの
    /// 同時ミスを 1 回の fetch にまとめる single-flight (#1107) は `SchemaCache`
    /// と共通の [`KeyedCache::get_or_fetch`] に委ねる (fetch 中はロックを解放し、
    /// write lock 取得後に generation を再チェックしてから insert する)。上限を
    /// 超えてキャッシュ対象外になった結果も、同じ世代で合流した待機者へは
    /// そのまま配る (同一キー・同一世代なので再実行しても同じ問い合わせになる)。
    pub async fn get_or_fetch<F, Fut>(
        &self,
        driver: DriverKind,
        database: Option<&str>,
        sql: &str,
        fetch: F,
    ) -> Result<QueryResult>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<QueryResult>>,
    {
        if !is_read_only_sql_for(driver, sql) {
            return fetch().await;
        }
        let key: QueryCacheKey = (database.map(str::to_string), sql.to_string());
        let (max_rows, max_bytes) = (self.max_rows, self.max_bytes);
        self.entries
            .get_or_fetch(
                key,
                self.ttl,
                self.max_entries,
                &self.generation,
                |value: &QueryResult| {
                    value.rows.len() <= max_rows && estimate_query_result_bytes(value) <= max_bytes
                },
                fetch,
            )
            .await
    }

    /// このセッションのクエリ結果キャッシュを丸ごと無効化する。呼び出し元の
    /// 一覧はモジュールドキュメント「invalidate 条件」参照。
    pub async fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.entries.clear().await;
        tracing::debug!("query result cache invalidated");
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
            comment: None,
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
                    comment: None,
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

        assert!(cache.databases.entries.read().await.is_empty());
        assert!(cache.tables.entries.read().await.is_empty());
        assert!(cache.columns.entries.read().await.is_empty());
        assert!(cache.row_identity.entries.read().await.is_empty());
        assert!(cache.schema_overview.entries.read().await.is_empty());
        assert!(cache.foreign_keys.entries.read().await.is_empty());
        assert!(cache.schema_objects.entries.read().await.is_empty());
        assert!(cache.list_indexes.entries.read().await.is_empty());
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
        assert_eq!(cache.tables.entries.read().await.len(), 2);

        // 3 件目の挿入で容量 (2) を超えるため、丸ごとクリアしてから db3 だけが
        // 残る。
        cache
            .tables("db3", || async { Ok(vec!["t3".to_string()]) })
            .await
            .unwrap();
        let map = cache.tables.entries.read().await;
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

    /// 上と同じ競合を キー無しスロット (`databases()`、キー `()`) 側でも固定する。
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
            cache.tables.entries.read().await.is_empty(),
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

#[cfg(test)]
mod query_result_cache_tests {
    use super::*;
    use crate::db::types::Column;
    use crate::error::AppError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn test_cache() -> QueryResultCache {
        QueryResultCache::new(Duration::from_secs(300), 20, 1000, 1024 * 1024)
    }

    /// `rows` 行・`cols_per_row` 列 (すべて `Value::Int`) の小さな `QueryResult`
    /// を組み立てる。容量上限テストで手早くサイズを作るためのヘルパー。
    fn result_with(rows: usize, cols_per_row: usize) -> QueryResult {
        QueryResult {
            columns: (0..cols_per_row)
                .map(|i| Column {
                    name: format!("c{i}"),
                    type_name: "int".to_string(),
                })
                .collect(),
            rows: (0..rows)
                .map(|r| (0..cols_per_row).map(|_| Value::Int(r as i64)).collect())
                .collect(),
            rows_affected: rows as u64,
            elapsed_ms: 0,
        }
    }

    /// 受け入れ条件: 同一クエリの再表示で `fetch` (= 実際の DB 実行) が省略される。
    #[tokio::test]
    async fn read_only_sql_hits_cache_on_second_call() {
        let cache = test_cache();
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let calls = calls.clone();
            let result = cache
                .get_or_fetch(
                    DriverKind::Sqlite,
                    Some("main"),
                    "SELECT * FROM t",
                    || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(result_with(2, 1))
                    },
                )
                .await
                .unwrap();
            assert_eq!(result.rows.len(), 2);
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "2 回目以降はキャッシュから返り、fetch は最初の 1 回だけのはず"
        );
    }

    /// キー設計: `database` が違えば同じ SQL 文字列でも独立にキャッシュされる。
    #[tokio::test]
    async fn different_databases_are_cached_independently() {
        let cache = test_cache();

        let a = cache
            .get_or_fetch(DriverKind::Sqlite, Some("db_a"), "SELECT 1", || async {
                Ok(result_with(1, 1))
            })
            .await
            .unwrap();
        assert_eq!(a.rows.len(), 1);

        // 同じ SQL でも database が違うのでキャッシュミスし、別の (3行の) 結果
        // が返るはず — 混同していれば a と同じ 1 行が返ってしまう。
        let b = cache
            .get_or_fetch(DriverKind::Sqlite, Some("db_b"), "SELECT 1", || async {
                Ok(result_with(3, 1))
            })
            .await
            .unwrap();
        assert_eq!(b.rows.len(), 3);
    }

    /// 対象外の条件 1: 読み取り専用でない SQL (INSERT/UPDATE/DELETE/DDL) は
    /// キャッシュへ一切触れず、毎回 `fetch` が実行される。
    #[tokio::test]
    async fn non_read_only_sql_is_never_cached() {
        let cache = test_cache();
        let calls = Arc::new(AtomicUsize::new(0));

        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET x = 1",
            "DELETE FROM t",
            "CREATE TABLE t2 (id INTEGER)",
        ] {
            let calls1 = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, sql, || async move {
                    calls1.fetch_add(1, Ordering::SeqCst);
                    Ok(QueryResult::empty(1, 0))
                })
                .await
                .unwrap();
            // 同じ書き込み文をもう一度: キャッシュされていれば呼ばれないはず
            // だが、書き込みは対象外なので必ずもう一度呼ばれる。
            let calls2 = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, sql, || async move {
                    calls2.fetch_add(1, Ordering::SeqCst);
                    Ok(QueryResult::empty(1, 0))
                })
                .await
                .unwrap();
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            8,
            "書き込み文は毎回 fetch が実行され、一度もキャッシュされないこと"
        );
    }

    /// 対象外の条件 2: 行数の上限を超える結果はキャッシュされない。
    #[tokio::test]
    async fn oversized_row_count_is_not_cached() {
        let cache = QueryResultCache::new(
            Duration::from_secs(300),
            20,
            /* max_rows */ 5,
            1024 * 1024,
        );
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..2 {
            let calls = calls.clone();
            cache
                .get_or_fetch(
                    DriverKind::Sqlite,
                    None,
                    "SELECT * FROM big",
                    || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(result_with(6, 1)) // 上限 5 行を超える
                    },
                )
                .await
                .unwrap();
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "行数上限を超える結果は insert されず、次回も fetch が走ること"
        );
    }

    /// 対象外の条件 3: バイト数の上限を超える結果はキャッシュされない
    /// (行数は上限内でも、大きな文字列 1 個で超過しうる)。
    #[tokio::test]
    async fn oversized_byte_size_is_not_cached() {
        let cache =
            QueryResultCache::new(Duration::from_secs(300), 20, 1000, /* max_bytes */ 100);
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..2 {
            let calls = calls.clone();
            cache
                .get_or_fetch(
                    DriverKind::Sqlite,
                    None,
                    "SELECT big_text FROM t",
                    || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(QueryResult {
                            columns: vec![Column {
                                name: "big_text".to_string(),
                                type_name: "text".to_string(),
                            }],
                            rows: vec![vec![Value::String("x".repeat(1000))]], // 100 バイト上限を大きく超過
                            rows_affected: 1,
                            elapsed_ms: 0,
                        })
                    },
                )
                .await
                .unwrap();
        }

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "バイト数上限を超える結果は insert されず、次回も fetch が走ること"
        );
    }

    /// TTL が経過したエントリはヒットとみなさず再取得すること。
    #[tokio::test]
    async fn expired_entry_is_refetched() {
        let cache = QueryResultCache::new(Duration::from_millis(20), 20, 1000, 1024 * 1024);
        let calls = Arc::new(AtomicUsize::new(0));

        {
            let calls = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, "SELECT 1", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(result_with(1, 1))
                })
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(40)).await;

        {
            let calls = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, "SELECT 1", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(result_with(1, 1))
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

    /// 容量上限を超えたら、次の挿入前に丸ごとクリアされること。
    #[tokio::test]
    async fn exceeding_capacity_clears_before_inserting() {
        let cache = QueryResultCache::new(
            Duration::from_secs(300),
            /* max_entries */ 2,
            1000,
            1024 * 1024,
        );

        cache
            .get_or_fetch(DriverKind::Sqlite, None, "SELECT 1", || async {
                Ok(result_with(1, 1))
            })
            .await
            .unwrap();
        cache
            .get_or_fetch(DriverKind::Sqlite, None, "SELECT 2", || async {
                Ok(result_with(1, 1))
            })
            .await
            .unwrap();
        assert_eq!(cache.entries.entries.read().await.len(), 2);

        cache
            .get_or_fetch(DriverKind::Sqlite, None, "SELECT 3", || async {
                Ok(result_with(1, 1))
            })
            .await
            .unwrap();
        let map = cache.entries.entries.read().await;
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&(None, "SELECT 3".to_string())));
    }

    /// `fetch` がエラーを返したときはキャッシュへ何も書き込まれないこと。
    #[tokio::test]
    async fn fetch_error_is_not_cached() {
        let cache = test_cache();
        let calls = Arc::new(AtomicUsize::new(0));

        {
            let calls = calls.clone();
            let err = cache
                .get_or_fetch(DriverKind::Sqlite, None, "SELECT 1", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err(AppError::InvalidInput("boom".into()))
                })
                .await;
            assert!(err.is_err());
        }
        {
            let calls = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, "SELECT 1", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(result_with(1, 1))
                })
                .await
                .unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "エラー後も再取得が走ること"
        );
    }

    /// 受け入れ条件: 書き込み後に stale な結果が返らないこと (invalidate_all)。
    #[tokio::test]
    async fn invalidate_all_forces_refetch() {
        let cache = test_cache();

        let before = cache
            .get_or_fetch(DriverKind::Sqlite, None, "SELECT * FROM t", || async {
                Ok(result_with(1, 1))
            })
            .await
            .unwrap();
        assert_eq!(before.rows.len(), 1);

        // 書き込み相当: 明示的に invalidate してから再取得する。
        cache.invalidate_all().await;

        let after = cache
            .get_or_fetch(DriverKind::Sqlite, None, "SELECT * FROM t", || async {
                Ok(result_with(5, 1))
            })
            .await
            .unwrap();
        assert_eq!(
            after.rows.len(),
            5,
            "invalidate 後は再取得され、更新後の行数が反映されること"
        );
    }

    /// レビュー指摘 (PR #1101) と同型の競合: `invalidate_all()` と in-flight
    /// fetch の競合。fetch クロージャの中で直接 `invalidate_all()` を呼ぶことで
    /// sleep なしで決定的に再現する (`SchemaCache` の同名テストと同じ手法)。
    #[tokio::test]
    async fn invalidate_during_fetch_does_not_resurrect_the_stale_value() {
        let cache = test_cache();

        let stale = cache
            .get_or_fetch(DriverKind::Sqlite, None, "SELECT * FROM t", || async {
                cache.invalidate_all().await;
                Ok(result_with(1, 1)) // "stale" 相当 (1 行)
            })
            .await
            .unwrap();
        assert_eq!(stale.rows.len(), 1);

        // invalidate 後の cache に古い値が残っていないこと — 次の呼び出しで
        // 必ず fetch が再実行されること。
        let calls = Arc::new(AtomicUsize::new(0));
        {
            let calls = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, "SELECT * FROM t", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(result_with(9, 1)) // "fresh" 相当
                })
                .await
                .unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "invalidate と競合した古い fetch の結果が cache に居座ってはいけない"
        );
    }

    /// 上と同じ競合を、2 つの独立したタスクを実際に並行実行させる形でも固定する
    /// (`SchemaCache` の `concurrent_invalidate_during_an_in_flight_fetch_...`
    /// と同じ手法 — oneshot channel による決定的な同期、sleep には頼らない)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_invalidate_during_an_in_flight_fetch_does_not_resurrect_stale_value() {
        let cache = Arc::new(test_cache());

        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (invalidated_tx, invalidated_rx) = tokio::sync::oneshot::channel::<()>();

        let cache_for_fetch = cache.clone();
        let fetch_task = tokio::spawn(async move {
            cache_for_fetch
                .get_or_fetch(
                    DriverKind::Sqlite,
                    None,
                    "SELECT * FROM t",
                    move || async move {
                        started_tx
                            .send(())
                            .expect("test still waiting on started_rx");
                        invalidated_rx.await.expect("invalidated_tx must fire");
                        Ok(result_with(1, 1)) // stale
                    },
                )
                .await
        });

        started_rx.await.expect("fetch task must signal start");
        cache.invalidate_all().await;
        invalidated_tx
            .send(())
            .expect("fetch task must still be awaiting the signal");

        let stale = fetch_task
            .await
            .expect("fetch task must not panic")
            .expect("fetch itself must succeed");
        assert_eq!(stale.rows.len(), 1);

        assert!(
            cache.entries.entries.read().await.is_empty(),
            "invalidate と競合した fetch の結果が cache に書き戻ってはいけない"
        );

        let calls = Arc::new(AtomicUsize::new(0));
        {
            let calls = calls.clone();
            cache
                .get_or_fetch(DriverKind::Sqlite, None, "SELECT * FROM t", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(result_with(9, 1)) // fresh
                })
                .await
                .unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "cache に stale な値が残っていなければ、次のアクセスで必ず再取得が走るはず"
        );
    }
}

/// single-flight (#1107) の回帰テスト。すべて oneshot / 待機者数の観測による
/// 決定的な同期で組み立て、sleep によるタイミング依存は使わない。
/// `tokio::time::timeout` は「実装が壊れて待機者が永久に待つ」ときにテストを
/// ハングさせずに失敗させるための安全網で、成功経路のタイミングには関与しない。
#[cfg(test)]
mod single_flight_tests {
    use super::*;
    use crate::db::types::Column;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::oneshot;

    const HANG_GUARD: Duration = Duration::from_secs(10);

    fn schema_cache() -> Arc<SchemaCache> {
        Arc::new(SchemaCache::new(Duration::from_secs(300), 500))
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    /// `slot` の `key` のフライトに `n` 人の待機者が合流するまで待つ。
    async fn wait_for_waiters<K, V>(slot: &KeyedCache<K, V>, key: &K, n: usize)
    where
        K: Eq + Hash + Clone,
        V: Clone,
    {
        tokio::time::timeout(HANG_GUARD, async {
            while slot.flight_waiters(key) < n {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("待機者が合流しないままタイムアウトした");
    }

    /// `rx` の合図が来るまで結果を返さない fetch を持つ `tables("db")` 呼び出しを
    /// 別タスクで開始し、fetch に入った (= リーダーとしてロック解放中の
    /// introspection に入った) ことを確認してから JoinHandle を返す。
    async fn spawn_blocked_leader(
        cache: &Arc<SchemaCache>,
        calls: &Arc<AtomicUsize>,
        release: oneshot::Receiver<Result<Vec<String>>>,
    ) -> tokio::task::JoinHandle<Result<Vec<String>>> {
        let (started_tx, started_rx) = oneshot::channel::<()>();
        let cache = cache.clone();
        let calls = calls.clone();
        let handle = tokio::spawn(async move {
            cache
                .tables("db", move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).expect("test waits for start");
                    release.await.expect("test must release the leader")
                })
                .await
        });
        tokio::time::timeout(HANG_GUARD, started_rx)
            .await
            .expect("leader never started")
            .expect("leader dropped before start");
        handle
    }

    /// `tables("db")` を呼ぶ待機者タスク。fetch が呼ばれたら `calls` を数え、
    /// `value` を返す (待機者が合流に成功していれば呼ばれない)。
    fn spawn_caller(
        cache: &Arc<SchemaCache>,
        calls: &Arc<AtomicUsize>,
        value: Result<Vec<String>>,
    ) -> tokio::task::JoinHandle<Result<Vec<String>>> {
        let cache = cache.clone();
        let calls = calls.clone();
        tokio::spawn(async move {
            cache
                .tables("db", move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    value
                })
                .await
        })
    }

    async fn join<T>(handle: tokio::task::JoinHandle<T>) -> T {
        tokio::time::timeout(HANG_GUARD, handle)
            .await
            .expect("task hung (a waiter waited forever)")
            .expect("task must not panic")
    }

    /// 受け入れ条件 1: 同一キーへ同時に複数の呼び出しがミスしても `fetch` は
    /// 1 回しか実行されず、全員が同じ結果を受け取る。
    #[tokio::test]
    async fn concurrent_misses_run_fetch_only_once() {
        let cache = schema_cache();
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();

        let leader = spawn_blocked_leader(&cache, &calls, release_rx).await;
        let waiters: Vec<_> = (0..4)
            .map(|_| spawn_caller(&cache, &calls, Ok(strings(&["WRONG"]))))
            .collect();
        wait_for_waiters(&cache.tables, &"db".to_string(), 4).await;

        release_tx.send(Ok(strings(&["t1", "t2"]))).unwrap();

        assert_eq!(join(leader).await.unwrap(), strings(&["t1", "t2"]));
        for waiter in waiters {
            assert_eq!(join(waiter).await.unwrap(), strings(&["t1", "t2"]));
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "同時ミスでも fetch はリーダーの 1 回だけのはず"
        );
        // 完了後はフライトが片付き、値は cache に載っている。
        assert_eq!(cache.tables.flight_waiters(&"db".to_string()), 0);
        assert!(lock_flights(&cache.tables.flights).is_empty());
        assert!(cache.tables.entries.read().await.contains_key("db"));
    }

    /// マルチスレッドランタイムでも同じく 1 回にまとまる (`std::sync::Mutex`
    /// による in-flight 表の排他が実スレッド並行でも成り立つこと)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_misses_run_fetch_only_once_on_multi_thread_runtime() {
        let cache = schema_cache();
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();

        let leader = spawn_blocked_leader(&cache, &calls, release_rx).await;
        let waiters: Vec<_> = (0..8)
            .map(|_| spawn_caller(&cache, &calls, Ok(strings(&["WRONG"]))))
            .collect();
        wait_for_waiters(&cache.tables, &"db".to_string(), 8).await;
        release_tx.send(Ok(strings(&["t"]))).unwrap();

        assert_eq!(join(leader).await.unwrap(), strings(&["t"]));
        for waiter in waiters {
            assert_eq!(join(waiter).await.unwrap(), strings(&["t"]));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// 異なるキーは合流しない (single-flight はキー単位)。
    #[tokio::test]
    async fn different_keys_do_not_share_a_flight() {
        let cache = schema_cache();
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = spawn_blocked_leader(&cache, &calls, release_rx).await;

        // 別キーの呼び出しは、"db" のリーダーが止まっていても即座に完了する。
        let other = tokio::time::timeout(
            HANG_GUARD,
            cache.tables("other_db", || async { Ok(strings(&["o"])) }),
        )
        .await
        .expect("別キーの呼び出しが無関係なフライトを待ってはいけない")
        .unwrap();
        assert_eq!(other, strings(&["o"]));

        release_tx.send(Ok(strings(&["t"]))).unwrap();
        join(leader).await.unwrap();
    }

    /// キー無しスロット (`databases()`、キー `()`) でも同時ミスが
    /// 1 回の fetch にまとまる。
    #[tokio::test]
    async fn concurrent_database_misses_run_fetch_only_once() {
        let cache = schema_cache();
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<()>();

        let leader = {
            let cache = cache.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                cache
                    .databases(move || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        Ok(strings(&["d1"]))
                    })
                    .await
            })
        };
        started_rx.await.unwrap();
        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let cache = cache.clone();
                let calls = calls.clone();
                tokio::spawn(async move {
                    cache
                        .databases(move || async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(strings(&["WRONG"]))
                        })
                        .await
                })
            })
            .collect();
        wait_for_waiters(&cache.databases, &(), 3).await;
        release_tx.send(()).unwrap();

        assert_eq!(join(leader).await.unwrap(), strings(&["d1"]));
        for waiter in waiters {
            assert_eq!(join(waiter).await.unwrap(), strings(&["d1"]));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// 受け入れ条件 2 (#1105 の generation 対策との整合): single-flight の
    /// 待ち合わせ中に `invalidate_all()` が走ったら、
    ///
    /// - リーダー自身は fetch 結果を返す (従来どおり) が cache へは書かない
    /// - 待っていた呼び出しは stale な共有結果を受け取らず、新しい世代で
    ///   自分の fetch をやり直して最新値を返す
    /// - stale な値が cache に復活しない
    #[tokio::test]
    async fn invalidate_while_waiting_does_not_hand_out_or_cache_the_stale_value() {
        let cache = schema_cache();
        let leader_calls = Arc::new(AtomicUsize::new(0));
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();

        let leader = spawn_blocked_leader(&cache, &leader_calls, release_rx).await;
        let waiter = spawn_caller(&cache, &waiter_calls, Ok(strings(&["fresh"])));
        wait_for_waiters(&cache.tables, &"db".to_string(), 1).await;

        // 待機者が合流した状態で invalidate (DDL 実行後に相当)。
        cache.invalidate_all().await;
        // invalidate 前に読み始めた introspection が古い結果を返す。
        release_tx.send(Ok(strings(&["stale"]))).unwrap();

        assert_eq!(
            join(leader).await.unwrap(),
            strings(&["stale"]),
            "リーダー自身への返り値は従来どおり fetch 結果そのもの"
        );
        assert_eq!(
            join(waiter).await.unwrap(),
            strings(&["fresh"]),
            "invalidate を跨いで待っていた呼び出しが stale な共有結果を掴んではいけない"
        );
        assert_eq!(waiter_calls.load(Ordering::SeqCst), 1);

        // cache には新しい世代で取り直した値だけが載っている。
        let map = cache.tables.entries.read().await;
        assert_eq!(
            map.get("db").map(|e| e.value.clone()),
            Some(strings(&["fresh"])),
            "stale な値が cache に復活してはいけない"
        );
    }

    /// invalidate **後**に来た呼び出しは、invalidate 前に始まった (まだ進行中の)
    /// フライトに合流しない — 旧世代のリーダーを待たずに自分で fetch する。
    /// 旧リーダーが後から完了しても、新しい世代の値を上書きしない。
    #[tokio::test]
    async fn caller_after_invalidate_does_not_join_the_old_generation_flight() {
        let cache = schema_cache();
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = spawn_blocked_leader(&cache, &calls, release_rx).await;

        cache.invalidate_all().await;

        // 旧世代のフライトに合流していればリーダーが止まっている限り返らない
        // (= タイムアウトで失敗する)。
        let late = tokio::time::timeout(
            HANG_GUARD,
            cache.tables("db", || async { Ok(strings(&["fresh"])) }),
        )
        .await
        .expect("invalidate 後の呼び出しが旧世代のフライトを待ってはいけない")
        .unwrap();
        assert_eq!(late, strings(&["fresh"]));

        release_tx.send(Ok(strings(&["stale"]))).unwrap();
        assert_eq!(join(leader).await.unwrap(), strings(&["stale"]));

        // 旧リーダーのガードが新しい世代のフライトやエントリを壊していないこと、
        // および stale が fresh を上書きしていないこと。
        let hit = cache
            .tables("db", || async { Ok(strings(&["WRONG"])) })
            .await
            .unwrap();
        assert_eq!(hit, strings(&["fresh"]));
        assert!(lock_flights(&cache.tables.flights).is_empty());
    }

    /// 受け入れ条件 3: リーダーの fetch がエラーを返した場合の挙動。
    ///
    /// - エラーはキャッシュしない
    /// - 待機者は永久に待たず、自分の fetch を 1 回だけ直接実行してその結果を
    ///   返す (エラーの `kind` を保つため、リーダーのエラーは複製しない)
    #[tokio::test]
    async fn leader_error_releases_waiters_to_fetch_on_their_own() {
        let cache = schema_cache();
        let leader_calls = Arc::new(AtomicUsize::new(0));
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();

        let leader = spawn_blocked_leader(&cache, &leader_calls, release_rx).await;
        let recovering = spawn_caller(&cache, &waiter_calls, Ok(strings(&["recovered"])));
        let failing = spawn_caller(&cache, &waiter_calls, Err(AppError::Timeout(30)));
        wait_for_waiters(&cache.tables, &"db".to_string(), 2).await;

        release_tx
            .send(Err(AppError::InvalidInput("boom".into())))
            .unwrap();

        assert!(matches!(join(leader).await, Err(AppError::InvalidInput(_))));
        assert_eq!(join(recovering).await.unwrap(), strings(&["recovered"]));
        // 待機者自身の fetch のエラーが、その kind のまま返ること。
        assert!(matches!(join(failing).await, Err(AppError::Timeout(30))));
        assert_eq!(
            waiter_calls.load(Ordering::SeqCst),
            2,
            "リーダーがエラーなら待機者はそれぞれ自分の fetch を 1 回ずつ実行する"
        );
        assert!(lock_flights(&cache.tables.flights).is_empty());
    }

    /// エラーのあと、次の呼び出しでは改めて fetch が走る (エラーが cache にも
    /// in-flight 表にも残らない)。
    #[tokio::test]
    async fn after_a_failed_flight_the_next_call_fetches_again() {
        let cache = schema_cache();
        let calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = spawn_blocked_leader(&cache, &calls, release_rx).await;
        let waiter = spawn_caller(&cache, &calls, Err(AppError::InvalidInput("again".into())));
        wait_for_waiters(&cache.tables, &"db".to_string(), 1).await;

        release_tx
            .send(Err(AppError::InvalidInput("boom".into())))
            .unwrap();
        assert!(join(leader).await.is_err());
        assert!(join(waiter).await.is_err());
        assert!(cache.tables.entries.read().await.is_empty());

        let next = {
            let calls = calls.clone();
            cache
                .tables("db", || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(strings(&["ok"]))
                })
                .await
                .unwrap()
        };
        assert_eq!(next, strings(&["ok"]));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    /// リーダーの future がキャンセル (drop) されても待機者は永久に待たず、
    /// 待機者のうち 1 人が新しいリーダーとして fetch をやり直す。その結果は
    /// cache に載り、次回はヒットする。
    #[tokio::test]
    async fn cancelled_leader_does_not_strand_waiters() {
        let cache = schema_cache();
        let leader_calls = Arc::new(AtomicUsize::new(0));
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        // release_tx を保持し続ける = リーダーの fetch は自力では終わらない。
        let (_release_tx, release_rx) = oneshot::channel();

        let leader = spawn_blocked_leader(&cache, &leader_calls, release_rx).await;
        let waiters: Vec<_> = (0..3)
            .map(|_| spawn_caller(&cache, &waiter_calls, Ok(strings(&["retried"]))))
            .collect();
        wait_for_waiters(&cache.tables, &"db".to_string(), 3).await;

        leader.abort();
        let aborted = tokio::time::timeout(HANG_GUARD, leader)
            .await
            .expect("aborted leader must finish");
        assert!(aborted.unwrap_err().is_cancelled());

        for waiter in waiters {
            assert_eq!(join(waiter).await.unwrap(), strings(&["retried"]));
        }
        assert_eq!(
            waiter_calls.load(Ordering::SeqCst),
            1,
            "キャンセル後の再試行も 1 回の fetch にまとまる (待機者が新しいリーダーに合流する)"
        );
        assert!(lock_flights(&cache.tables.flights).is_empty());

        let hit = cache
            .tables("db", || async { Ok(strings(&["WRONG"])) })
            .await
            .unwrap();
        assert_eq!(hit, strings(&["retried"]));
    }

    /// 呼び出し元の future を直接 drop する形のキャンセル (タスクの abort では
    /// なく、`select!` の負け側などと同じ経路) でも in-flight 表が片付き、
    /// 次の呼び出しが合流先を失って固まらない。
    #[tokio::test]
    async fn dropping_the_leader_future_cleans_up_the_flight() {
        let cache = schema_cache();
        {
            let fut = cache.tables("db", std::future::pending::<Result<Vec<String>>>);
            // 1 回だけ poll して fetch に入らせてから drop する。
            // `biased` なので必ず `fut` を先に 1 回 poll し、pending なら
            // 即座に完了する 2 本目の分岐へ抜ける。
            let mut fut = Box::pin(fut);
            tokio::select! {
                biased;
                _ = &mut fut => panic!("pending な fetch のリーダーが完了してはいけない"),
                _ = std::future::ready(()) => {}
            }
            assert_eq!(lock_flights(&cache.tables.flights).len(), 1);
        }
        assert!(
            lock_flights(&cache.tables.flights).is_empty(),
            "drop されたリーダーのフライトが表に残ってはいけない"
        );

        let value = tokio::time::timeout(
            HANG_GUARD,
            cache.tables("db", || async { Ok(strings(&["after_drop"])) }),
        )
        .await
        .expect("次の呼び出しが消えたフライトを待ってはいけない")
        .unwrap();
        assert_eq!(value, strings(&["after_drop"]));
    }

    /// リーダーの fetch がパニックしても待機者は永久に待たず、fetch をやり直す。
    #[tokio::test]
    async fn panicking_leader_does_not_strand_waiters() {
        let cache = schema_cache();
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<()>();

        let leader = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .tables("db", move || async move {
                        started_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        panic!("introspection panicked (test)");
                    })
                    .await
            })
        };
        started_rx.await.unwrap();
        let waiter = spawn_caller(&cache, &waiter_calls, Ok(strings(&["after_panic"])));
        wait_for_waiters(&cache.tables, &"db".to_string(), 1).await;

        release_tx.send(()).unwrap();
        let panicked = tokio::time::timeout(HANG_GUARD, leader)
            .await
            .expect("panicking leader must finish");
        assert!(panicked.unwrap_err().is_panic());

        assert_eq!(join(waiter).await.unwrap(), strings(&["after_panic"]));
        assert_eq!(waiter_calls.load(Ordering::SeqCst), 1);
        assert!(lock_flights(&cache.tables.flights).is_empty());
    }

    // ── Query Result Cache ──

    fn one_row(v: i64) -> QueryResult {
        QueryResult {
            columns: vec![Column {
                name: "c".to_string(),
                type_name: "int".to_string(),
            }],
            rows: vec![vec![Value::Int(v)]],
            rows_affected: 1,
            elapsed_ms: 0,
        }
    }

    fn first_cell(result: &QueryResult) -> i64 {
        match result.rows[0][0] {
            Value::Int(v) => v,
            ref other => panic!("unexpected cell {other:?}"),
        }
    }

    fn query_key() -> QueryCacheKey {
        (Some("main".to_string()), "SELECT * FROM t".to_string())
    }

    fn spawn_query(
        cache: &Arc<QueryResultCache>,
        calls: &Arc<AtomicUsize>,
        value: i64,
    ) -> tokio::task::JoinHandle<Result<QueryResult>> {
        let cache = cache.clone();
        let calls = calls.clone();
        tokio::spawn(async move {
            cache
                .get_or_fetch(
                    DriverKind::Sqlite,
                    Some("main"),
                    "SELECT * FROM t",
                    move || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(one_row(value))
                    },
                )
                .await
        })
    }

    async fn spawn_blocked_query_leader(
        cache: &Arc<QueryResultCache>,
        release: oneshot::Receiver<QueryResult>,
    ) -> tokio::task::JoinHandle<Result<QueryResult>> {
        let (started_tx, started_rx) = oneshot::channel::<()>();
        let cache = cache.clone();
        let handle = tokio::spawn(async move {
            cache
                .get_or_fetch(
                    DriverKind::Sqlite,
                    Some("main"),
                    "SELECT * FROM t",
                    move || async move {
                        started_tx.send(()).unwrap();
                        Ok(release.await.unwrap())
                    },
                )
                .await
        });
        tokio::time::timeout(HANG_GUARD, started_rx)
            .await
            .expect("leader never started")
            .unwrap();
        handle
    }

    /// Query Result Cache も同一クエリの同時ミスを 1 回の実行にまとめる。
    #[tokio::test]
    async fn query_cache_concurrent_misses_run_fetch_only_once() {
        let cache = Arc::new(QueryResultCache::new(
            Duration::from_secs(300),
            20,
            1000,
            1024 * 1024,
        ));
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = spawn_blocked_query_leader(&cache, release_rx).await;
        let waiters: Vec<_> = (0..3)
            .map(|_| spawn_query(&cache, &waiter_calls, -1))
            .collect();
        wait_for_waiters(&cache.entries, &query_key(), 3).await;

        release_tx.send(one_row(7)).unwrap();
        assert_eq!(first_cell(&join(leader).await.unwrap()), 7);
        for waiter in waiters {
            assert_eq!(first_cell(&join(waiter).await.unwrap()), 7);
        }
        assert_eq!(waiter_calls.load(Ordering::SeqCst), 0);
    }

    /// 上限超過でキャッシュ対象外になる結果も、同じ世代で合流した待機者には
    /// 配られる (cache には載らない)。
    #[tokio::test]
    async fn query_cache_shares_uncacheable_results_with_waiters_without_caching() {
        let cache = Arc::new(QueryResultCache::new(
            Duration::from_secs(300),
            20,
            /* max_rows */ 0,
            1024 * 1024,
        ));
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = spawn_blocked_query_leader(&cache, release_rx).await;
        let waiter = spawn_query(&cache, &waiter_calls, -1);
        wait_for_waiters(&cache.entries, &query_key(), 1).await;

        release_tx.send(one_row(3)).unwrap();
        assert_eq!(first_cell(&join(leader).await.unwrap()), 3);
        assert_eq!(first_cell(&join(waiter).await.unwrap()), 3);
        assert_eq!(waiter_calls.load(Ordering::SeqCst), 0);
        assert!(cache.entries.entries.read().await.is_empty());
    }

    /// Query Result Cache でも、待ち合わせ中の invalidate (= 書き込み後) を
    /// 跨いだ待機者は stale な共有結果を受け取らず、取り直した値を返す。
    #[tokio::test]
    async fn query_cache_invalidate_while_waiting_does_not_hand_out_stale_rows() {
        let cache = Arc::new(QueryResultCache::new(
            Duration::from_secs(300),
            20,
            1000,
            1024 * 1024,
        ));
        let waiter_calls = Arc::new(AtomicUsize::new(0));
        let (release_tx, release_rx) = oneshot::channel();
        let leader = spawn_blocked_query_leader(&cache, release_rx).await;
        let waiter = spawn_query(&cache, &waiter_calls, 2);
        wait_for_waiters(&cache.entries, &query_key(), 1).await;

        cache.invalidate_all().await;
        release_tx.send(one_row(1)).unwrap(); // stale

        assert_eq!(first_cell(&join(leader).await.unwrap()), 1);
        assert_eq!(
            first_cell(&join(waiter).await.unwrap()),
            2,
            "書き込み後の待機者に stale な行を返してはいけない"
        );
        assert_eq!(waiter_calls.load(Ordering::SeqCst), 1);
        let map = cache.entries.entries.read().await;
        assert_eq!(map.get(&query_key()).map(|e| first_cell(&e.value)), Some(2));
    }
}
