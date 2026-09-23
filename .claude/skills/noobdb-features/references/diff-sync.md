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

## テーブル・タイムラプス (#739) — データ比較の時間方向版

`timelapse/` (純関数 + `store.rs`) と `commands/timelapse.rs`。ウォッチ登録した
テーブルを接続時 (`settings.timelapseOnConnect`) と手動更新で `select_rows_sql`
(PK 順・`MAX_DATA_ROWS + 1` 行。MSSQL は `TOP (n)`) により取得し、
`<data_dir>/table_timelapse.sqlite` (Unix は `0600`) に世代として保存する。

- **PK 必須** (`compare_table_data` と同じ制約)。上限超過のテーブルは
  `allow_partial` の同意が無ければ登録しない (UI が「先頭 N 行だけを記録」を確認)。
- 列名 + 行 JSON の FNV-1a 64 フィンガープリントが直前世代と同じなら世代を増やさない。
  ウォッチ単位の世代数ローテーション (`clamp_max_generations`、既定 20) と、全体の
  保存量上限 `MAX_TOTAL_BYTES` (64 MiB。各ウォッチの最新世代は残す)。
- 差分は `diff_snapshots` → `compute_data_diff` をそのまま流用し、**source = 新しい
  世代 / target = 古い世代** (`source_only` = 追加)。世代間で列が増減しても名前で
  揃えてから比較する (`align_rows`)。
- `Connection::execute` を直接呼ぶのでクエリ履歴に残らず、read_only セッションでも
  動く (`ensure_allowed_for_session` も通す)。
- 保存するのは実データのローカルコピー (秘密情報は含めない)。機微カラムマスク
  (#1069) は**表示専用**で、保存データはマスクしない。UI は Bottom Panel の
  `timelapse` タブ (`TableTimelapsePanel.tsx` / `tableTimelapse.ts`)。
