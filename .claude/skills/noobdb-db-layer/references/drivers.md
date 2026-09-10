# ドライバのディスパッチと値のデコード

## ドライバのディスパッチ: `enum Connection`

DB レイヤは意図的に手書きの enum で実装されており、トレイトオブジェクトではありません。
`src-tauri/src/db/mod.rs` の `db::Connection` は `MySql` / `Postgres` / `Sqlite` /
`DuckDb` / `Mssql` の 5 バリアントを持ち (`DuckDb` と `Mssql` だけ `Box<...>` —
`duckdb::Connection` を抱える `DuckDbConn` と `tiberius::Client` を抱える
`MssqlConn` が sqlx ベースの 3 ドライバよりずっと大きく
`clippy::large_enum_variant` に当たるため)、
各操作 (`execute`, `begin_transaction` / `execute_in_transaction` /
`finish_transaction` / `transaction_active`, `health_check`,
`preview_execute_with_limit`, `execute_stream`, `import_rows`, `execute_transaction`,
`databases`, `tables`, `columns`, `schema_overview`, `foreign_keys`, `schema_objects`,
`object_definition`, `list_indexes`, `table_row_estimates`, `list_processes`,
`kill_process`, `close`, `driver_kind`) でバリアントに対してマッチします。**新しい
データベースを追加する場合は、`DriverKind` にバリアントを追加し、同じメソッド表面を
公開する `db/<name>.rs` モジュールを追加し、`db/mod.rs` の各 `match` アームを拡張します。**
SSH やセッション層には触らないでください — それらはドライバに依存しません。`schema_objects` /
`object_definition` (ビュー・ルーチン・トリガーの列挙と DDL 取得)、`list_indexes`、
`table_row_estimates` (統計情報ベースの概算行数)、`list_processes` / `kill_process`
(MySQL `PROCESSLIST` / PostgreSQL `pg_stat_activity` / MSSQL `sys.dm_exec_sessions`
+ `sys.dm_exec_requests` / `KILL <spid>`) もこの enum 表面の一部で、SQLite では多くが
サーバ機能非対応のため空や no-op で短絡します。

**MSSQL ドライバ (`db/mssql.rs`、#729) は他 3 ドライバと異なり sqlx を使いません**
(sqlx に MSSQL バックエンドが無いため)。代わりに素の TDS クライアント `tiberius` を
直接使い、コネクションプールも `sqlx::Pool` ではなく本モジュール内に手書きの極小プール
(`MssqlPool` — `std::sync::Mutex<Vec<Client>>` の idle リスト + `tokio::sync::Semaphore`
で同時接続数を制限。同期 Mutex を使うのは `PooledConn` の `Drop` から async を経由せずに
接続をプールへ返せるようにするため) を実装しています。エラー型も `AppError::Sqlx` では
なく専用の `AppError::Mssql(#[from] tiberius::error::Error)` です。他ドライバとの主な
差分:

- **スキーマ introspection は `dbo` スキーマに限定**しています。MSSQL は 1 データベース
  内に複数スキーマを持てますが、既存の「1 データベース = 1 名前空間」という他ドライバの
  抽象 (sync/export/import が生成する識別子はすべて単一パート想定) を崩さないための
  意図的なスコープ縮小です (`db/mssql.rs` のモジュール doc に詳細)。フロント側の
  `db.table` 参照もすべて `db.[dbo].table` の 3 パートで組み立てます
  (`cellEdit.ts`/`QueryBuilder.tsx`/`tableMaintenance.ts`/`createTable.ts` の
  `qualified`/`qualifiedTableRef`/`tableRef`/`qualifiedName` を参照)。
- **識別子クオートは `[ident]`** (`db::sync::quote_ident` の `DriverKind::Mssql` 分岐、
  フロントは `sqlDialect.ts::quoteIdentFor`)。**自動 LIMIT は `TOP (n)`** を
  `SELECT [DISTINCT]` の直後に挿入する専用実装 `db::apply_auto_limit_mssql`
  (`db::apply_auto_limit_for` がドライバで振り分け) — `WITH` (CTE) は対象外
  (「型を惑わせるより何もしない」方針、doc 参照)。フロントの `QueryBuilder.tsx` も
  同じ TOP 方式で生成する。
- **`server_metrics` / `query_stats_support` (ライブクエリ・インスペクタ) /
  `unused_indexes` は未実装**(SQLite と同じ `unsupported_driver` 縮退)。`dump_database`
  も未対応 (`commands/dump.rs` が `InvalidInput` を返す)。いずれも本 Issue の受け入れ
  条件の範囲外 — 将来 `sys.dm_exec_*` 系 DMV で実装可能。
- **手書きプールは「疑わしい接続を絶対に返さない」方針**。`PooledConn` の `Drop` は
  既定でアイドルリストへ接続を戻すため、失敗した操作の後にそのまま返すと壊れた TCP
  ソケットが次の無関係なリクエストへ配られます。そこで fallible な操作は
  `unwrap_or_discard` / `rows` / `exec` などのヘルパ経由に統一し、エラー時は必ず
  `mark_discard()` します (I/O エラーと SQL エラーを tiberius のエラー型から確実に
  見分けるのは難しいので、**迷ったら捨てる** — 接続 1 本のコストの方が小さい)。
  `execute_stream` / `preview_execute_with_limit` / `import_rows` は逆に
  **先に discard を立て、最後まで読み切って成功したときだけ `unmark_discard()`** し
  ます。この形なら `cancel_stream` の abort やタイムアウトで future が drop された
  場合も自動的に discard 扱いになり、**未消費の結果セットを抱えた接続**がプールへ
  戻りません (tiberius は読み切っていない `QueryStream` があると次のクエリの前に
  残りを flush するため、放置すると次の呼び出し元がそのツケを払います)。例外は
  `probe_failing_row` の行単位 INSERT 失敗で、これは想定内のデータエラーであり接続
  破損の証拠ではないので discard しません。
- **統合テストは `tests/mssql_integration.rs`**、`NOOBDB_TEST_MSSQL_URL`
  (`mssql://user:pass@host:port/db`) 環境変数ゲート (未設定ならスキップ)。CI の
  サービスコンテナは未追加 (ローカル/手動実行のみ、他ドライバと同じ導入パターンを
  踏襲すれば追加可能)。

`db::types::{Value, Column, QueryResult, TableColumnInfo, TableSchema,
PreviewResult, StreamBatch}` がドライバ横断のワイヤフォーマットです。`Value` は
`#[serde(untagged)]` なので、JSON では直接プリミティブとして見えます。BLOB は
JSON で安全に扱えるよう 16 進エンコードした文字列 (`Value::Bytes`) になります。
各ドライバの `decode_cell` 系では型に応じた明示的なデコードを行っています — カラム型を
追加する際は「型付きで試して失敗したら String にフォールバック」というパターンに
従ってください。

**64bit 整数は「JS の安全整数」を境に表現が変わります。** `Value` は
`#[serde(untagged)]` なので `Int`/`UInt` は JSON の素の数値としてシリアライズされ、
フロントの `JSON.parse` で IEEE754 倍精度の `number` になります。したがって
`Number.MAX_SAFE_INTEGER` (2^53-1) を超える整数はそのまま返すと**丸められて別の値に
なり**、表示・コピー・エクスポートが静かに誤るだけでなく、インラインセル編集が
丸めた値で `WHERE pk = ...` を組み立てるため**意図しない行を書き換えうる**。これを
避けるため、全ドライバの整数デコードは `Value::from_i64_lossless` /
`from_u64_lossless` / `from_i128_lossless` / `from_u128_lossless` (`db/types.rs`) を
通し、安全整数の外は十進文字列 (`Value::String`) にします (DECIMAL/NUMERIC が桁あふれ
時に文字列へ退避するのと同じ方針で、フロントの `cellEdit.ts` もこの前提で書かれて
います)。**新しい整数型の分岐を足すときは必ずこのヘルパを経由してください。**

**PostgreSQL のデコードは「非 NULL の値を `Value::Null` にしない」ことを不変条件と
します。** sqlx の通常の `try_get` は型互換チェックを通すため、`String` が受け付ける
TEXT/VARCHAR/BPCHAR/NAME/UNKNOWN/citext 以外 (uuid・配列・inet/cidr・macaddr・money・
interval・ユーザ定義 ENUM・ドメイン型など) は失敗し、`Vec<u8>` も BYTEA 以外は失敗
するため、素朴なフォールバックだと**実データが NULL として返り**ます。表示が消える
だけでなく、`db/data_diff.rs` の比較で両側とも `Null` になり Diff/Sync とサンドボックス
書き戻しが実差分を見逃します。`postgres.rs::decode_cell` は UUID・配列・INET/CIDR・
MACADDR・MONEY・INTERVAL・BIT/VARBIT・TID(`ctid`)・OID 系に明示分岐を持ち、最終
フォールバックは型互換チェックを飛ばす `try_get_unchecked`(String → 失敗時 `Vec<u8>` を
16 進) にして、**SQL NULL のときだけ `Value::Null`** を返します。JSON/JSONB は
`serde_json::Value` を経由すると `BTreeMap` でキーが並べ替わるため、生ワイヤバイト
(JSONB は先頭のバージョンバイトを剥がす) をそのまま返してサーバのキー順を保ちます
(MySQL はサーバ側が JSON のキーを正規化するので対象外)。

クエリ判定 (結果セットを返す SELECT 系か、`rows_affected` を返す書き込み系か) は
ドライバごとに SQL の先頭キーワードを見て行います。MySQL の `is_query_shape`
(`db/mysql.rs`) は `select`/`show`/`describe`/`desc`/`explain`/`call` に加えて、
`with` で始まる文は CTE 本体が DML かどうか (`with_cte_is_mutation`) を判定します
(データ変更 CTE は execute 経路、純粋な `WITH ... SELECT` は fetch 経路)。`CALL` は
結果セットを返しうるので fetch 経路を通します。判定前にコメントと文字列リテラルは
マスクされます。

SQLite はファイルバックドライバで、`DbConnectOptions.file_path` を使い、
host/port/user/password と SSH トンネルを持ちません (`commands::connection::
