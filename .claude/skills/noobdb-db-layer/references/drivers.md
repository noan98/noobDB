# ドライバのディスパッチと値のデコード

## ドライバのディスパッチ: `enum Connection`

DB レイヤは意図的に手書きの enum で実装されており、トレイトオブジェクトではありません。
`src-tauri/src/db/mod.rs` の `db::Connection` は `MySql` / `Postgres` / `Sqlite` の
3 バリアントを持ち、各操作 (`execute`, `begin_transaction` / `execute_in_transaction` /
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
(MySQL `PROCESSLIST` / PostgreSQL `pg_stat_activity`) もこの enum 表面の一部で、
SQLite では多くがサーバ機能非対応のため空や no-op で短絡します。

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
