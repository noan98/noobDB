# DB ドライバ層 (`db/`)

`enum Connection` によるディスパッチ、MSSQL 固有事情、TLS 設定、セッション初期化 SQL。

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
build_options` が SQLite を最初に短絡処理します)。

## TLS / SSL 設定 (#520)

MySQL / PostgreSQL の接続は TLS をファーストクラスでサポートします。
`DbConnectOptions` の `ssl_mode` (`SslMode` enum: `disable` / `prefer` / `require` /
`verify_ca` / `verify_full`) と証明書パス 3 種 (`ssl_root_cert` = CA、
`ssl_client_cert` / `ssl_client_key` = mTLS) がドライバ非依存の共通表現で、各ドライバの
`connect` 内の `apply_tls` がそれぞれの sqlx enum へマッピングします (PostgreSQL は
`PgSslMode`、MySQL は `MySqlSslMode`。`verify_full` は MySQL の `VerifyIdentity` に対応)。
`ssl_mode = None` は sqlx 既定 (`prefer`/`preferred`) を維持するため、TLS 設定が無い
旧プロファイルは**後方互換**で従来どおり接続できます。空の証明書パス (`Some("")`) は
`non_empty` で「未設定」として扱います。SQLite は TLS 非対象で常に `None`。**証明書はパス
のみが非秘密フィールドとして `profiles.json` に保存され、ファイルの中身は接続時に読み込む
だけで保存しません (keyring も不要)**。UI は `ConnectionForm` の TLS セクション。SSH
トンネル併用時はドライバが 127.0.0.1 に接続するため `verify_full` のホスト名検証が失敗
しうる点をヘルプ (`formTlsSshHint`) に明記しています。

**TLS 統合テスト方針 (#520 の既知ギャップ、#795 で実装)**: `apply_tls` のモード
マッピングとパス正規化 (`non_empty`) は `db/mysql.rs` / `db/postgres.rs` の単体
テストが network 不要でカバーしていますが、実 TLS ハンドシェイク (CA 検証の成功/
失敗) は実サーバが要るため、既存の MySQL/PostgreSQL 統合テストと同じ環境変数ゲート
方式で `src-tauri/tests/tls_integration.rs` に追加しました。ゲートする環境変数は
`NOOBDB_TEST_MYSQL_TLS_URL` / `NOOBDB_TEST_POSTGRES_TLS_URL` (TLS 必須サーバの
接続 URL) と `NOOBDB_TEST_TLS_CA` (両サーバの証明書を発行した CA の PEM パス、
共通) の 3 つで、いずれか欠けている対応するテストはスキップされます。カバーする
観点は各ドライバにつき: `ssl_mode=require` での接続成立、`verify_ca`/`verify_full` +
正しい CA での接続成立、`verify_full` + CA 未指定 (システムのトラストストアには
自己署名 CA が入っていないため検証失敗) で `AppError` がエラーとして表面化する
こと (`connect` の戻り値は常に `Result<Connection, AppError>` なので `Err` である
こと自体が確認になる)。

**CI 配備 (`ci.yml` の `rust (test)` ジョブ) — 既存サービスコンテナとは別に TLS
必須の DB を独立して立てる方式を採用**: `scripts/ci-setup-tls-db.sh` が openssl で
自己署名 CA + サーバ証明書 (SAN に `127.0.0.1`/`localhost`) を生成し、
mysql-server/postgresql (ubuntu-latest ランナーに既定でプリインストール済み) を
**別ポート (3307/5433)** に TLS 必須 (`require_secure_transport=ON` /
`hostssl ... scram-sha-256` のみ許可) で起動して、上記 3 環境変数を `$GITHUB_ENV`
へ書き出します。既存の MySQL 8 / PostgreSQL 16 サービスコンテナ (3306/5432、平文)
はそのまま維持し、TLS インスタンスは完全に独立した並存構成です。

この方式を選んだ理由 (サービスコンテナの `services:` ブロックへ直接 TLS を組み込む
案との比較): GitHub Actions のサービスコンテナは**ジョブの他のどのステップよりも
前に起動する**ため、証明書をジョブ内で生成してからコンテナへ渡す手段が無く (ボリューム
マウントで後から流し込んでも mysqld/postgres は起動時にしか TLS 設定を読まない)、
かつ `services:` の workflow 構文には `command:` (エントリポイント引数の上書き) が
無いため、公式 postgres イメージへ `-c ssl=on -c ssl_cert_file=...` のような起動
引数を渡す手段も存在しません。対して「サービスコンテナに頼らず apt パッケージを
直接構成する」方式は、SSH トンネル統合テスト (#331、`scripts/ci-setup-sshd.sh`) で
既に実績のある同じパターンをそのまま踏襲でき、ローカルでも同一スクリプトで再現・
検証できます。CI ワークフロー本体の変更は「sshd と並列の background ステップ +
`wait:` への合流」1 箇所の追加のみで、既存のサービスコンテナ定義・カバレッジ計装・
ジョブ分割方針には一切手を入れていません (最小侵襲)。MySQL 側は Ubuntu の
AppArmor プロファイルがカスタム datadir/証明書パスを塞ぐことがあるため
`aa-complain` で complain モードに倒しています (プロファイルが存在しない環境では
no-op)。

## セッション初期化 SQL (#522)

接続プロファイルは**セッション初期化 SQL** (`DbConnectOptions.init_sql`、複数文可) を
持てます。接続確立直後にドライバ層で **sqlx の `after_connect` フック**を通じて
**プールの各物理接続ごと**に実行されるため、`SET search_path` / `SET time_zone` /
`SET sql_mode` / `SET ROLE` / `statement_timeout`・SQLite の `PRAGMA` などを毎タブ
手動で流さなくても結果の再現性が保てます。各ドライバの `connect` が
`init_sql_of(opts)` で非空時のみ `after_connect(|conn, _| raw_sql(...))` を登録します
(`sqlx::raw_sql` は `;` 区切りの複数文を simple-query で実行)。`connect_with` が初回
接続を 1 本張って検証するため、初期化 SQL の実行失敗は**接続時のエラーとして表面化**
します。

**読み取り専用との整合方針**: 初期化 SQL は `db::is_session_init_sql` の安全網を通し、
**各文が `SET` / `PRAGMA` で始まるか、`is_read_only_sql` を通る読み取り専用文のみ**を
許可します (データ変更・DDL・`USE` は全体を不正として弾く)。書き込みを一切含まないため
読み取り専用セッションでも整合します。検証は `commands::connection::build_options` が
接続前に行い、不正なら `InvalidInput` を返します。コメント/文字列リテラルはマスクして
から `;` 分割するので、`'a;b'` 内のセミコロンは文境界と誤認しません。非秘密フィールド
として `profiles.json` に保存します。判定の単体テストは `db/mod.rs`、実行が各物理接続で
効くことの検証は `tests/sqlite_integration.rs` の `sqlite_init_sql_runs_on_each_connection`
(PRAGMA を設定して読み戻す。外部サーバ不要で常時実走) がカバーします。
