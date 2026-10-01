# IPC コマンド一覧

`src-tauri/src/lib.rs::run()` の `generate_handler!` に登録されている **155 コマンド**の
全件です。`src/api/tauri.ts` の `api` オブジェクトがこれをミラーします。

> **このファイルは `src/__tests__/docCommandParity.test.ts` が
> `generate_handler!` と突き合わせています。** コマンドを追加・削除したらここも
> 更新してください (更新しないと CI が落ちます)。

## 接続 (`commands/connection.rs`)

`test_connection` / `connect` / `cancel_connect` / `ping_session` / `health_probe_all` /
`disconnect` / `reconnect`

`health_probe_all(sessionIds, timeoutMs, refreshVersion)` (#1259) は接続ヘルスの一括プローブ。
Rust が全セッションを並列に問い合わせ、各セッションを `tokio::time::timeout` で打ち切る。

## SSH (`commands/ssh.rs`)

`list_known_hosts` / `forget_host_key` / `trust_host_key` / `resolve_ssh_config_host`

## クエリ実行・トランザクション (`commands/query.rs`)

`run_query` / `run_query_transaction` / `run_query_stream` / `preview_query_stream` /
`cancel_stream` / `set_emergency_mode` / `run_lookup_query` / `begin_transaction` (任意引数 `isolation` / `readOnly`, #1166) / `run_in_transaction` /
`finish_transaction`

## 一括書き込み (`commands/bulk_write.rs`, #1259)

`bulk_update_cells` / `insert_generated_rows`

- `bulk_update_cells(sessionId, database, table, pkColumns, groups, extraStatements)` は結果グリッドの
  セル編集 Apply。フロント (`cellEdit.buildUpdateGroups`) が同じ (列, 値) ごとにまとめた
  構造化入力を送り、Rust が `UPDATE t SET c = v WHERE pk IN (…)` (単一 PK・500 件ずつ) /
  行条件の `OR` 連結 (複合 PK・NULL を含む PK・100 行ずつ) を組み立てる。`extraStatements` は
  同じトランザクションに載せる DELETE / INSERT。実行は `run_query_transaction_inner` へ
  委譲するため read_only ガード (緊急モード含む)・履歴・キャッシュ invalidate は従来と同一
  (フライトレコーダーに記録しない点も従来どおり。記録対象は `run_query_stream({ capture: true })`
  の単文のみ)。リテラルは `db::data_diff::sql_literal` (バインドにしないのは PostgreSQL が
  text 型パラメータを整数列へ暗黙変換しないため)。64bit PK は文字列のまま引用リテラルで比較。
- `insert_generated_rows` はテストデータ生成の投入。生成行を `Connection::import_rows`
  (1 トランザクション) へ直接渡す。履歴には 1 行の要約を残す。

`run_query_stream` は結果を Channel の `columns` / `rows` / `done` のほかに、バッチ合流
(`db::stream_batch::StreamBatcher`: 初回は即送信、以降は時間 / サイズ倍々) と逐次統計
(`rows.stats` / `done.stats`: 列ごとの NULL 数・数値 min/max・重複行フラグ) を付けて送る
(#1257)。自動リフレッシュでは任意引数 `refreshDiff` (`{ key, pkIndices, prevSnapshotId }`)
を渡すと、`db::refresh_diff` が前回結果の PK ハッシュ → 行ハッシュを保持して `patch`
メッセージ (変化行・追加行の実データ + 変化なし区間の参照 + 削除数。全一致なら
`unchanged`) だけを返す。

## ブロードキャスト (`commands/broadcast.rs`)

`broadcast_compare` — 同じ読み取りクエリを基準 + 対象セッションへ並行実行し、環境ごとの
`env` メッセージ (列 + 上限 5,000 行の表示行 + 基準との差分サマリ、`db::broadcast_diff`) を
Channel で返す (#738, #1257)。読み取り専用はバックエンド強制。各環境は
`{runId}:{sessionId}` の stream id で `cancel_stream` できる。

## スキーマ (`commands/schema.rs`)

`list_databases` / `list_tables` / `describe_table` /
`schema_overview` / `foreign_keys` / `list_schema_objects` / `get_object_definition` /
`list_indexes` / `table_row_estimates` / `list_table_comments` / `get_routine_signature`
(ストアドプロシージャ / 関数のパラメータ取得、#1003 — SQLite は未対応エラー) /
`table_statistics` / `describe_database` / `alter_table_context` / `incoming_foreign_keys` (#1255)

#1255 の 148 コマンドは N+1 の IPC を 1 回に畳む一括取得。いずれも読み取り専用。
`table_statistics` はサイズ・行数に列数・インデックス数・PK 有無・FK 数を合成して返す
(旧 `table_sizes` の置き換え)。`describe_database` は全テーブルの `describe_table` 相当
(スキーマエクスポート / ER 図)。`alter_table_context` は列編集ダイアログの初期ロード一式
(列・テーブルコメント・このテーブルの FK・テーブル名一覧)。`incoming_foreign_keys` は
`foreign_keys` のキャッシュから対象テーブルを参照する FK だけを返す(逆方向 FK ジャンプ)。
`table_statistics` / `describe_database` は取得結果でテーブル単位の `columns` / `list_indexes`
キャッシュも埋める。

## スキーマ・テーブルオープンの集約 (`commands/schema.rs` / `schema_tree.rs` / `table_open.rs`、#1263)

`table_row_estimate` / `load_schema_tree` / `list_tables_all` / `open_table` / `open_tables`

- `table_row_estimate` — `table_row_estimates` の 1 テーブル版 (MySQL `TABLE_NAME = ?` /
  PG `relname = $2` / SQLite は `None`)。`open_table` が失敗したときのフォールバックで使う。
- `open_table(session, db, table, limit, with_estimate)` — 列 + (PK 無しなら)行識別 + 初回
  SELECT の SQL (`table_select_sql`、フロント `qualifiedTableSql` と共有ゴールデン
  `tableSelectSql.json`) + 行数推定 (タイムアウト付き) を `tokio::join!` で並行取得して
  1 IPC で返す。`open_tables` はセッション復元用の一括版 (テーブルごとの成功/失敗、行数推定なし)。
- `load_schema_tree(session, open_dbs, open_table_keys)` — スキーマツリーの復元 / 更新用。
  DB 一覧 + 開いている DB のテーブル・行数推定・非テーブルオブジェクト・コメント + 開いている
  テーブルの列・インデックス (多いときは #1255 の一括取得) を 1 回で返す。
- `list_tables_all` — 全 DB のテーブル一覧を SQL 1 本で返す (スキーマ検索用、MySQL
  `information_schema.TABLES` / PG 全スキーマ / SQLite は単一 DB)。

`describe_table` の各列は `comment` (列コメント) を、`list_table_comments` は
テーブル / ビューのコメントを返す (#1002)。SQLite はコメント非対応で常に空。

`get_object_definition` は `kind = "table"` でテーブルの `CREATE TABLE` DDL も返す
(#1001)。MySQL/SQLite はネイティブ DDL、PostgreSQL は
`db/table_ddl.rs` がカタログ情報から再構成したベストエフォート DDL。

## 比較・同期 (`commands/diff.rs`, `commands/sync.rs`)

`compare_schema` / `compare_table_data` /
`generate_sync_sql` / `generate_data_sync_sql` / `release_data_diffs` / `apply_sync_sql`

`compare_table_data` は表示用 `diff` と保持差分の `diff_id` を返し、`generate_data_sync_sql(diffId, allowDelete, skipKeys)` は
ID から Rust 側で描画する。`release_data_diffs(diffIds)` で保持を破棄する (#1259)。

## サンドボックス (`commands/sandbox.rs`)

`create_sandbox` / `list_sandboxes` / `discard_sandbox` / `sandbox_table_diff` /
`sandbox_schema_diff` / `sandbox_advance_base` (`diffId` + `skipKeys`, #1259)

## プロセス管理・ユーザ / 権限 (`commands/process.rs`, `commands/privileges.rs`)

`list_processes` / `get_process_query` / `kill_processes` / `list_db_users` / `list_user_privileges` /
`generate_create_user_sql` / `generate_drop_user_sql` / `generate_alter_password_sql` /
`generate_privilege_diff_sql` (#1259。権限差分から GRANT/REVOKE をまとめて生成) / `apply_privilege_sql`
(`list_processes` はクエリを Rust 側で 1 行要約 (`query_summary` / `query_truncated`) にして返し、
全文は `get_process_query` で id 指定取得。`kill_processes` は read_only ガード 1 回 + PostgreSQL は `unnest` で 1 文 /
MySQL は 1 接続上で順に `KILL`、結果は `{killed, failed, first_error}` (#1259)。
`list_user_privileges` は任意引数 `database` でテーブル別の行をサーバ側 WHERE で絞る)

## 診断 (`commands/advisor.rs`, `commands/inspector.rs`, `commands/server.rs`)

`analyze_schema_health` / `query_stats_support` / `sample_live_queries` /
`start_statement_recording` / `sample_statement_delta` (#1259。baseline 差分と N+1 目安を Rust 側で集計) / `server_info` / `server_metrics`

## 列データプロファイル (`commands/profile.rs`)

`profile_column` (#974。NULL 率 / DISTINCT / MIN・MAX / 上位頻出値 / ヒストグラムを
サーバ側で全件集計。単一 SELECT のみで read_only セッションでも可)

## テーブル・タイムラプス (`commands/timelapse.rs`)

`timelapse_watch_table` / `timelapse_capture` / `timelapse_list_watches` /
`timelapse_diff_generations` / `timelapse_unwatch` / `timelapse_clear_all`
(#739。ウォッチ登録したテーブルの世代スナップショットを `<data_dir>/table_timelapse.sqlite`
に保存し、任意の 2 世代を `compute_data_diff` で比較。取得は PK 順の単一 SELECT
(最大 `MAX_DATA_ROWS`) で履歴に記録せず、read_only セッションでも可。PK 必須)

## スキーマドリフト (`commands/schema_drift.rs`)

`schema_drift_capture` / `schema_drift_list` / `schema_drift_compare` /
`schema_drift_import_legacy`
(#736 / #1260。`capture` は `columns_for_database` + `indexes_for_database` の 2 クエリで
DB 全体を取得 → 正規化・フィンガープリント → `<data_dir>/schema_drift.sqlite` へ保存
(最大 20 世代) → 前世代との変化サマリだけを返す。`list` / `compare` はセッション不要。
`import_legacy` は旧 localStorage 世代を初回だけ取り込む)

## 実行計画ウォッチ (`commands/plan_watch.rs`)

`plan_watch_list` / `plan_watch_set` / `plan_watch_refresh` /
`plan_watch_import_legacy`
(#743 / #1260。世代は `<data_dir>/plan_watch.sqlite`。`refresh` はウォッチ中スニペットの
EXPLAIN をまとめて実行し、正規化・フィンガープリント・世代記録・前世代との比較を Rust 内で
完結して件数だけを返す。履歴に記録せず、read_only セッションでも可。スニペット削除
(`delete_snippet`) は全プロファイルのウォッチを連鎖削除する)

## タスクスケジューラ (`commands/tasks.rs`)

`list_tasks` / `save_task` / `delete_task` / `set_task_enabled` / `run_task_now` /
`list_task_runs` / `list_assertion_runs` / `clear_task_runs` / `get_scheduler_settings` /
`set_scheduler_settings`

## データ品質アサーション (`commands/assertions.rs`)

`list_assertions` / `save_assertion` / `delete_assertion` / `preview_assertion_sql` /
`run_assertion` (#742。定義は `assertions.json`、ルール → SQL は純ロジック
`db::assertions`。実行は `run_lookup_query` と同じ裏方経路で、read_only セッションでも
可・ルールごとにタイムアウト・履歴/結果キャッシュに載らない)

## フライトレコーダー / Undo (`commands/flight_recorder.rs`)

`list_flight_records` / `clear_flight_records` / `preview_undo` / `undo_flight_record`

## ローカル横断クエリ (`commands/local.rs`)

`create_local_session` / `register_local_table` / `list_local_tables` /
`drop_local_table` / `save_local_database`

## プロファイル (`commands/profiles.rs`)

`list_profiles` / `reveal_profile_secret` / `save_profile` / `delete_profile` /
`reorder_profiles` / `export_profiles` / `import_profiles`

## プロファイルの暗号化バックアップ (`commands/profile_backup.rs`)

`export_profiles_encrypted` / `import_profiles_encrypted` (#710。keyring の秘密込みで
パスフレーズ暗号化 — Argon2id + AES-256-GCM、形式は `profiles/backup.rs` の
モジュール doc。引数は `req` 構造体でパスフレーズを受け、応答は件数のみ)

## スニペット・履歴・ログ (`commands/snippets.rs`, `history.rs`, `logs.rs`)

`list_snippets` / `save_snippet` / `delete_snippet` / `list_history` / `get_history_sql` /
`list_history_sql` / `clear_history` / `read_logs` / `clear_logs`

履歴 (#1256): `list_history` は SQL 全文ではなく `sql_preview` (空白を畳んだ先頭 400
文字、超過は `…`) と `sql_len` を返す。全文は `get_history_sql(id)` を復元・コピー・
新規タブで開く・スニペット保存の時点で呼んで取る。`list_history_sql(profile_id, limit)` は
エディタの ↑/↓ 履歴ナビとコマンドパレット用に SQL 全文だけを新しい順に返す (実行の
たびに再取得せず、実行直後の SQL はフロントが先頭へ積む)。

## エクスポート / ダンプ / インポート / ファイル

`export_query_result` / `export_query_stream` / `dump_database` / `parse_csv_preview` /
`import_csv` / `preview_create_table_ddl` / `read_text_file` / `write_text_file` /
`write_binary_file` / `fetch_cell_bytes` / `probe_cell_blob` / `save_cell_to_file` /
`read_binary_file` / `get_import_skipped_text` / `save_import_skipped_rows`

`fetch_cell_bytes` / `probe_cell_blob` / `save_cell_to_file` / `read_binary_file`
(`commands/cell_blob.rs`, #1148 / #1258) は BLOB セルのファイル入出力とプレビュー用。
`probe_cell_blob` はサイズ (`OCTET_LENGTH` / `LENGTH`) と先頭 16 バイトだけを SELECT して
MIME・拡張子・画像か (`detect_blob_kind` がマジックバイト判定を担う) を返す (3 ドライバで
SQL を揃えている)。`fetch_cell_bytes` は主キーで 1 セルの生バイトを SELECT のみで引き直し
(`read_only` でも通る)、`read_binary_file` はファイルを読む (上限 16 MiB)。この 2 つは
`tauri::ipc::Response` で**生バイト**を返し、JS は `ArrayBuffer` で受ける (16 進や JSON 配列を
経由しない)。`save_cell_to_file` は DB → ファイルを Rust 内で完結させる (BLOB が IPC を通らない)。
書き戻しはフロントが `UPDATE` を組み立てて通常の `run_query` (読み取り専用ガード付き) で流す。

`write_text_file` (`commands/file.rs`, #1258) は SQL・Markdown・JSON などのテキストを文字列の
まま UTF-8 で書く (上限 32 MiB)。`write_binary_file` は `tauri::ipc::Request` の raw ボディ
(`InvokeBody::Raw`) を受け、保存先パスはヘッダ `x-noobdb-path` に URL エンコードして載せる
(`api.writeBinaryFile` が `encodeURIComponent`、Rust 側 `decode_path_header` が復元)。

`get_import_skipped_text` / `save_import_skipped_rows` (`commands/import.rs`, #1258) は
skip モードの取り込みでスキップされた行の「全件」を扱う。`csv-import:done` には先頭
200 件 (`MAX_REPORTED_SKIPPED`) と総数 `skippedTotal` だけを載せ、全件は `AppState` が直近の
取り込み結果として保持する。表示文言はフロントの i18n テンプレートを引数で受ける。

`preview_create_table_ddl` は「ファイルから新規テーブルを作成」(#985) の DDL
プレビュー。`import_csv` の `createTable` 引数が実行時に通るのと同じ
`db::create_table::render_create_table` を返す (書き込みなし)。

`mask_export_rows` (`commands/export.rs`, #733) — エクスポートのデータマスキングを
行へ適用して返す (ExportModal のプレビュー / 全文コピー用)。仮名化の秘密ソルトを
フロントへ出さないため、変換は実出力と同じ `db/masking.rs` で行う。ファイル・DB には
触れない。`export_query_result` / `export_query_stream` も同じ `masks` 引数を受け取る。
`mask_export_rows` / `export_query_result` / `register_local_table` は `result_id`
(#1264, 下記「結果ハンドル」) を渡すと行を送らずバックエンド保持の行を使う。

### 結果ハンドル (`commands/result.rs`, #1264)

`run_query_stream` の `retainResult: true` で、ストリームした結果をバックエンドが
**合計メモリ上限付き** (既定 256 MiB、LRU) で保持し、`done` の `resultId` で返す
(`db/result_store.rs`)。保持できなかった結果は `resultId: null` で、フロントは従来どおり
JS から行を送る。ハンドルは「行配列」に紐づけて持ち (`components/resultHandle.ts`)、
編集適用などで行配列が入れ替われば自動的に使われなくなる。

`result_sort_filter` — ソート・列フィルタ・全体フィルタを適用した表示順の行インデックスを
返す。意味論は `ResultGrid.tsx` と同じ (`db/result_ops.rs`)。文字列の照合順序だけ
`Intl.Collator` の近似なので、5 万行以上 (`HANDLE_SORT_MIN_ROWS`) の結果に限って使う。
`null` はハンドルが無い。

`result_find` — 結果内検索 (正規表現なし。正規表現は JS の文法と違うためフロントが JS で
処理する)。ヒットは行優先で `limit` 件 + 総数。`null` はハンドルが無い。

`result_column_stats` — 列クイック統計 (`gridStats.ts::columnStats` と同じ値)。

`release_result` — ハンドルを破棄する (タブを閉じる・再実行・編集適用)。冪等。セッション
切断でもバックエンドが破棄する。

`render_export_text` — エクスポート内容をテキストで返す (全文コピー・マスク付き
プレビュー用)。ファイル出力と同じ `write_export_to` を `Vec<u8>` に向けるので、書式・
マスキングはファイルとバイト一致する (`tests/export_format_golden.rs` が固定)。


`run_sql_script` (`commands/script.rs`, #973) — `.sql` ファイルを 64 KiB ずつ読み、
`db/script.rs` のストリーミング文分割 (フロント `splitSqlStatements` と共有ゴールデン
`scriptSplitVectors.json` で一致を固定) で 1 文ずつ実行する。`sql-script:progress` /
`:done` / `:error` / `:cancelled` イベント + `cancel_stream`。読み取り専用ガードは
文ごと、`continueOnError` / `wrapInTransaction` は排他。スクリプト内の
BEGIN/COMMIT/ROLLBACK は明示トランザクションのプリミティブへ読み替える。

`run_sql_batch` (`commands/script.rs`, #1256) — エディタの複数文 SQL のバッチ実行。
`run_sql_script` と同じ `run_script_core_with` を文字列の `Cursor` で再利用し、分割
(`split_script`)・文ごとの read-only ガード・トランザクション制御文の読み替えを共有する。
差分は (1) 結果を文ごとに返す (SELECT は `previewRows` 件に達した時点で
`execute_stream` の `on_batch` で取得を打ち切る)、(2) 明示トランザクション中は各文を
`execute_in_transaction` で同じ接続に流す (制御文の読み替えなし)、(3) 履歴には記録
しない。結果は Channel (`started` / `results` / `done` / `error` / `cancelled`) で、
`results` は 150ms 間引きでまとめて届く。`cancel_stream` で中断できる。

## 接続間データ転送 (`commands/transfer.rs`, #986)

`transfer_data` — ソース接続のテーブル全件 / 単一の読み取り専用クエリ結果を、別接続の
テーブルへスキーマ + データごと永続コピーするストリーミングコマンド。読み出しは
`execute_stream`、書き込みは `import_rows` (新しい書き込み経路は増やさない)。進捗は
`transfer-stream:*` イベント、`cancel_stream` で中断。ターゲットの `read_only` は
バックエンドで拒否する。

## Schema Cache (`commands/schema.rs`, #1097)

`refresh_schema_cache` — セッション単位の Schema Cache (`cache::SchemaCache`) を
明示的に無効化する。DDL 実行時 (`run_query` / `run_query_transaction` /
`run_in_transaction` / `apply_sync_sql`) は成功後にバックエンドが自動で
invalidate するため、通常のフローでこのコマンドを呼ぶ必要はない — Schema
Browser の更新ボタンなど、ユーザが明示的に最新化したいときのみ使う。
