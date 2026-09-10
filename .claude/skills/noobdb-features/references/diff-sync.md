# スキーマ・データ比較と同期 (Diff / Sync)

## スキーマ・データ比較と同期 (Diff / Sync)

2 つの接続 (セッション) 間でスキーマとデータを突き合わせ、差分を埋める SQL を生成・
適用する機能です。**純粋計算層 (`db/`) と IPC 層 (`commands/`) を明確に分離**しており、
純粋層はドライバ非依存・副作用なしで単体テストが容易です。

- `db/diff.rs`: `compute_schema_diff` がテーブル/カラムのメタデータ 2 組を入力に
  `SchemaDiff` (各テーブル・カラムを `DiffStatus`: `SourceOnly` / `TargetOnly` /
  `Different` / `Same` で分類) を計算する純粋関数。`data_type` / `key` / `extra` は
  大小無視、`default` は厳密比較など、フィールドごとに比較基準を変えています。
- `db/data_diff.rs`: `compute_data_diff` がプライマリキーで行をペアリングして
  `RowDiff` を計算し、`generate_data_sync_sql` がそこから INSERT / UPDATE / DELETE を
  生成します。リテラルはドライバ別にエスケープ (MySQL はバックスラッシュも二重化)。
- `db/sync.rs`: `generate_sync_sql` が `SchemaDiff` から対象ドライバの DDL 方言に
  合わせた `SyncPlan` (`SyncStatement` 列 + `warnings`) を生成。MySQL は `MODIFY COLUMN`、
  PostgreSQL は facet 単位の `ALTER COLUMN`、SQLite は in-place 変更不可のため warning に
  降格、と方言差を吸収します。`SyncKind::order()` で CREATE → ADD → ALTER → DROP →
  INSERT/UPDATE/DELETE の安全な適用順を決めます。MySQL の `DEFAULT` は
  `information_schema.COLUMNS.COLUMN_DEFAULT` が**クオート無し**で返るため
  `is_mysql_string_default_type` に該当する型 (文字列系に加え `date`/`datetime`/
  `timestamp`/`time`/`year`/`binary`/`varbinary`/`blob` 系/`json`) では再クオートします
  — 漏れると `DEFAULT 2020-01-01` のような構文エラーの DDL になります。式の
  デフォルト (`CURRENT_TIMESTAMP` 等) は `extra` の `DEFAULT_GENERATED` を見て
  手前で逐語出力へ分岐するので二重クオートにはなりません。
- `commands/diff.rs`: `compare_schema` / `compare_table_data` が両セッションから
  メタデータ・行を取得して上記純粋関数に渡す IPC ラッパー。両セッションが同一ドライバで
  あること、データ比較対象テーブルにプライマリキーがあることを要求し、データ比較は
  `MAX_DATA_ROWS=5000` / `DEFAULT_DATA_ROWS=1000` で上限を設けます (マスターデータ向け)。
- `commands/sync.rs`: `generate_sync_sql` / `generate_data_sync_sql` (純粋生成) と
  `apply_sync_sql` (ターゲットセッションでトランザクション実行) を公開。`allow_destructive`
  (`DROP`) / `allow_delete` (`DELETE`) フラグで破壊的操作をオプトインにし、読み取り専用
  セッションへの適用は拒否します。MySQL は DDL の暗黙コミットのため best-effort 逐次、
  他ドライバは all-or-nothing。
