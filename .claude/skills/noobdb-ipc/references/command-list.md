# IPC コマンド一覧

`src-tauri/src/lib.rs::run()` の `generate_handler!` に登録されている全コマンドの
一覧です。`src/api/tauri.ts` の `api` オブジェクト (本体は `src/api/commands/*.ts`) が
これをミラーします。

コマンド名は **1 行 1 コマンドの箇条書き**で書いてください (`a` / `b` と 1 行に並べると、
同じセクションにコマンドを足す並列の PR が同じ行を書き換えて衝突します)。件数も
書きません。

> **このファイルは `src/__tests__/docCommandParity.test.ts` が
> `generate_handler!` と突き合わせています。** コマンドを追加・削除したらここも
> 更新してください (更新しないと CI が落ちます)。

## 接続 (`commands/connection.rs`)

- `test_connection`
- `connect`
- `cancel_connect`
- `ping_session`
- `session_tunnel_alive`
- `health_probe_all`
- `disconnect`
- `reconnect`

`health_probe_all(sessionIds, timeoutMs, refreshVersion)` (#1259) は接続ヘルスの一括プローブ。
Rust が全セッションを並列に問い合わせ、各セッションを `tokio::time::timeout` で打ち切る。
各項目の `tunnel_alive` (#1537) は SSH トンネルの生存 (トンネル越しでなければ null)。
`false` のときは `SELECT 1` を投げずに `down` を返す。

`session_tunnel_alive(sessionId)` (#1537) は SSH トンネルの生存だけを DB に触れずに返す軽量チェック
(russh `Handle::is_closed` + accept ループ終了 + 踏み台の生存)。UI が定期的に呼び、クエリ失敗より
先に切断を知らせて再接続 (#712) へ誘導する。

## AI 基盤 (`commands/ai.rs`, #690)

- `set_ai_api_key`
- `has_ai_api_key`
- `run_ai_request`
- `test_ai_connection`
- `get_ai_usage_history`
- `clear_ai_usage_history`

- API キーは OS keyring (`ai/anthropic_api_key`) のみ。`set_ai_api_key(key)` は `None` = 変更なし /
  `Some("")` = 削除。`has_ai_api_key` は bool だけ返し、値を返す IPC は無い。
- `run_ai_request(streamId, task, system, prompt, settings, format, systemCached, history, onEvent)` はストリーミング。`format` は任意で
  `{ type: "json_schema", schema }` (構造化出力 `output_config.format`、他の形は拒否)。結果は
  `onEvent` の Tauri Channel に `kind` タグ付き (`delta` / `retrying` / `done` / `error` / `cancelled`) で届く
  (#1534。`listenAiStream` が Channel を作る)。429 / 529 はストリーム開始前に限り `Retry-After` /
  指数バックオフで最大 3 回再試行し、その間 `retrying` が届く。
  `systemCached` は任意 (#1473): system の固定部分 (スキーマなど)。`system` より前のブロックになり、
  モデルの最小キャッシュ長 (`AiModel::cache_min_tokens`、UTF-8 バイト数で判定) 以上のとき
  `cache_control: ephemeral` が付く。キャッシュは `systemCached` を渡したときだけ (オプトイン)。
  `history` は任意 (#1471): 追い質問用の会話履歴 `[{ role, content }]` (user 始まり・user / assistant 交互・
  assistant 終わりで、今回の `prompt` が末尾の user になる)。20 件超・形が崩れた履歴・空の発言は拒否し、
  `prompt` / `system` / `systemCached` / 履歴の合算が `MAX_PROMPT_BYTES` を超えても拒否する。
  履歴の最後の発言にもキャッシュのブレークポイントを置く (system 固定部分と合わせて最大 2 個)。
  フロントは直近 5 往復に絞って渡す (`src/ai/conversation.ts`)。
  中断は既存の `cancel_stream` (`StreamKind::Ai`)。モデル・エフォートは呼び出し側から渡さず、
  `task` + `settings` (設定スナップショット) からバックエンド (`ai/models.rs`) が
  `taskModels[kind] ?? defaultModel` / `taskEfforts[kind] ?? 推奨` で解決する。
- `get_ai_usage_history` / `clear_ai_usage_history` (#1540) は使用量台帳 (`ai_usage.json`: 日 JST × タスク × モデルのトークン数のみ。
  キー・送信内容は含まない)。概算コストはフロント `aiModels.ts` の単価表で掛ける。
- `test_ai_connection(settings)` は短い非ストリーミング要求。認証 / ネットワーク / API / refusal は
  戻り値の `status` で区別する。
- エラー kind: `aiRefused` / `aiAuth` / `aiNetwork` / `aiApi` / `aiOverloaded` (429 / 529。再試行しても通らなかった一時的な混雑)。

## SSH (`commands/ssh.rs`)

- `list_known_hosts`
- `forget_host_key`
- `trust_host_key`
- `resolve_ssh_config_host`

## クエリ実行・トランザクション (`commands/query.rs`)

- `run_query`
- `run_query_transaction`
- `run_query_stream`
- `preview_query_stream`
- `cancel_stream`
- `set_emergency_mode`
- `run_lookup_query`
- `begin_transaction` (任意引数 `isolation` / `readOnly`, #1166)
- `run_in_transaction`
- `finish_transaction`
- `create_savepoint` / `rollback_to_savepoint` / `release_savepoint` (明示 TX 内の SAVEPOINT, #1418)

## 一括書き込み (`commands/bulk_write.rs`, #1259)

- `bulk_update_cells`
- `insert_generated_rows`

- `bulk_update_cells(sessionId, database, table, pkColumns, groups, extraStatements, pkBinary?)` は結果グリッドの
  セル編集 Apply。フロント (`cellEdit.buildUpdateGroups`) が同じ (列, 値) ごとにまとめた
  構造化入力を送り、Rust が `UPDATE t SET c = v WHERE pk IN (…)` (単一 PK・500 件ずつ) /
  行条件の `OR` 連結 (複合 PK・NULL を含む PK・100 行ずつ) を組み立てる。`extraStatements` は
  同じトランザクションに載せる DELETE / INSERT。実行は `run_query_transaction_inner` へ
  委譲するため read_only ガード (緊急モード含む)・履歴・キャッシュ invalidate は従来と同一
  (フライトレコーダーに記録しない点も従来どおり。記録対象は `run_query_stream({ capture: true })`
  の単文のみ)。リテラルは `db::data_diff::sql_literal` (バインドにしないのは PostgreSQL が
  text 型パラメータを整数列へ暗黙変換しないため)。64bit PK は文字列のまま引用リテラルで比較。`pkBinary` (任意、`pkColumns` と同順の bool) が真の列は 16 進文字列の key を `Value::Bytes` に戻してバイナリリテラルで比較する (BLOB 列を含む all_columns 同定用)。
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

- `list_databases`
- `list_tables`
- `describe_table`
- `schema_overview`
- `foreign_keys`
- `list_schema_objects`
- `get_object_definition`
- `list_indexes`
- `table_row_estimates`
- `list_table_comments`
- `get_routine_signature` (ストアドプロシージャ / 関数のパラメータ取得、#1003 — SQLite は未対応エラー)
- `table_statistics`
- `describe_database`
- `alter_table_context`
- `incoming_foreign_keys` (#1255)

#1255 の 148 コマンドは N+1 の IPC を 1 回に畳む一括取得。いずれも読み取り専用。
`table_statistics` はサイズ・行数に列数・インデックス数・PK 有無・FK 数を合成して返す
(旧 `table_sizes` の置き換え)。`describe_database` は全テーブルの `describe_table` 相当
(スキーマエクスポート / ER 図)。`alter_table_context` は列編集ダイアログの初期ロード一式
(列・テーブルコメント・このテーブルの FK・テーブル名一覧)。`incoming_foreign_keys` は
`foreign_keys` のキャッシュから対象テーブルを参照する FK だけを返す(逆方向 FK ジャンプ)。
`table_statistics` / `describe_database` は取得結果でテーブル単位の `columns` / `list_indexes`
キャッシュも埋める。

## スキーマ・テーブルオープンの集約 (`commands/schema.rs` / `schema_tree.rs` / `table_open.rs`、#1263)

- `table_row_estimate`
- `load_schema_tree`
- `list_tables_all`
- `open_table`
- `open_tables`

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

## 検索 (`commands/search.rs`, #1261)

- `search_schema_objects`
- `find_where_used`
- `data_search_stream`

検索系 3 機能を Rust 側で実行する。いずれもカタログまたは SELECT だけの読み取り操作で
`read_only` でも動く。

- `search_schema_objects(session_id, scope, query, limit)` — グローバルオブジェクト検索
  (Cmd/Ctrl+Shift+O)。`scope` は `{kind:"current", database}` / `{kind:"all"}`。全 DB 分の
  `information_schema` を 1 問い合わせで引いて索引化し (`SchemaCache` の `object_index_all` /
  `object_index_db`。DDL・Refresh・TTL で失効)、スコアリングと上位 N 件の抽出
  (`db/object_search.rs`) もバックエンドで行う。`query` が空なら結果は空で索引の構築のみ
  (ウォームアップ)。順位規則は共有ゴールデン `objectSearchVectors.json`。
- `find_where_used(session_id, stream_id, database, target, on_event)` — Where-used。
  Channel に `progress` / `done{report}` / `error` / `cancelled{report}` を送る。定義本文は
  PostgreSQL / SQLite では 1 問い合わせで一括取得 (`Connection::object_definitions_bulk`)、
  MySQL は `SHOW CREATE` を並列 3 で個別取得 (`information_schema` の定義は `CREATE …` の
  見出し・パラメータ・トリガーの対象テーブルを含まず検出結果が変わるため)。参照検出
  (`db/where_used.rs`) と保存済みスニペット (接続プロファイルのスコープで絞り込み) の
  走査もバックエンド。`cancel_stream(stream_id)` は途中結果つき (`cancelled: true`)。
  共有ゴールデン `whereUsedVectors.json`。
- `data_search_stream(session_id, stream_id, request, on_event)` — DB 全体からの値検索。
  走査 SQL の生成 (`db/data_search.rs`) と列メタデータの一括取得 (5 テーブル以上) を
  バックエンドで行い、同時実行 3 で発行する。Channel に `progress` / `table{entry}`
  (指定順) / `done` / `error` / `cancelled` を送る。走査 SQL は `ensure_allowed_for_session`
  (読み取り専用ガード) を通す。共有ゴールデン `dataSearchVectors.json`。

`describe_table` の各列は `comment` (列コメント) を、`list_table_comments` は
テーブル / ビューのコメントを返す (#1002)。SQLite はコメント非対応で常に空。

`get_object_definition` は `kind = "table"` でテーブルの `CREATE TABLE` DDL も返す
(#1001)。MySQL/SQLite はネイティブ DDL、PostgreSQL は
`db/table_ddl.rs` がカタログ情報から再構成したベストエフォート DDL。

## 比較・同期 (`commands/diff.rs`, `commands/sync.rs`)

- `compare_schema`
- `compare_table_data`
- `generate_sync_sql`
- `generate_data_sync_sql`
- `release_data_diffs`
- `apply_sync_sql`

`compare_table_data` は表示用 `diff` と保持差分の `diff_id` を返し、`generate_data_sync_sql(diffId, allowDelete, skipKeys)` は
ID から Rust 側で描画する。`release_data_diffs(diffIds)` で保持を破棄する (#1259)。
`compare_table_data` に `streamId` を渡して `allRows` で呼ぶと、ページごとの進捗を `data-diff:progress` イベント
(`streamId` / `rows`) で通知し、`cancel_stream(streamId)` で中止できる (中止時は `InvalidInput` で返る, #1612)。

## サンドボックス (`commands/sandbox.rs`)

- `create_sandbox`
- `list_sandboxes`
- `discard_sandbox`
- `sandbox_table_diff`
- `sandbox_schema_diff`
- `sandbox_advance_base` (`diffId` + `skipKeys`, #1259)
- `sandbox_reset_table` (#1539。1 表を base スナップショットへ戻す。行データのみ・read_only 拒否)

## プロセス管理・ユーザ / 権限 (`commands/process.rs`, `commands/privileges.rs`)

- `list_processes`
- `get_process_query`
- `get_process_queries` (複数 id の全文を一覧 1 回でまとめて取得。AI ロック診断用)
- `kill_processes`
- `list_db_users`
- `list_user_privileges`
- `generate_create_user_sql`
- `generate_drop_user_sql`
- `generate_alter_password_sql`
- `generate_privilege_diff_sql` (#1259。権限差分から GRANT/REVOKE をまとめて生成)
- `apply_privilege_sql`

`list_processes` はクエリを Rust 側で 1 行要約 (`query_summary` / `query_truncated`) にして返し、全文は `get_process_query` で id 指定取得。`kill_processes` は read_only ガード 1 回 + PostgreSQL は `unnest` で 1 文 / MySQL は 1 接続上で順に `KILL`、結果は `{killed, failed, first_error}` (#1259)。任意引数 `statement_only` (`statementOnly`) が true なら接続は残して実行中の文だけを止める (MySQL `KILL QUERY` / PostgreSQL `pg_cancel_backend`、#1538)。`list_user_privileges` は任意引数 `database` でテーブル別の行をサーバ側 WHERE で絞る

## 診断 (`commands/advisor.rs`, `commands/inspector.rs`, `commands/server.rs`)

- `analyze_schema_health`
- `query_stats_support`
- `sample_live_queries`
- `start_statement_recording`
- `sample_statement_delta` (#1259。baseline 差分と N+1 目安を Rust 側で集計)
- `server_info`
- `server_metrics`

## 列データプロファイル (`commands/profile.rs`)

`profile_column` (#974。NULL 率 / DISTINCT / MIN・MAX / 上位頻出値 / ヒストグラムを
サーバ側で全件集計。単一 SELECT のみで read_only セッションでも可)

`profile_table` (#1539。表の全列の件数 / NULL 数 / DISTINCT / MIN・MAX を 1 回の走査で一括取得。
上位値・ヒストグラムは含まず `profile_column` で列ごとに遅延取得。`approximate` で PostgreSQL の
DISTINCT を `pg_stats` から近似、#1609)

## テーブル・タイムラプス (`commands/timelapse.rs`)

- `timelapse_watch_table`
- `timelapse_capture`
- `timelapse_list_watches`
- `timelapse_diff_generations`
- `timelapse_unwatch`
- `timelapse_clear_all`

#739。ウォッチ登録したテーブルの世代スナップショットを `<data_dir>/table_timelapse.sqlite` に保存し、任意の 2 世代を `compute_data_diff` で比較。取得は PK 順の単一 SELECT (最大 `MAX_DATA_ROWS`) で履歴に記録せず、read_only セッションでも可。PK 必須

## スキーマドリフト (`commands/schema_drift.rs`)

- `schema_drift_capture`
- `schema_drift_list`
- `schema_drift_compare`
- `schema_drift_import_legacy`

#736 / #1260。`capture` は `columns_for_database` + `indexes_for_database` の 2 クエリで DB 全体を取得 → 正規化・フィンガープリント → `<data_dir>/schema_drift.sqlite` へ保存 (最大 20 世代) → 前世代との変化サマリだけを返す。`list` / `compare` はセッション不要。`import_legacy` は旧 localStorage 世代を初回だけ取り込む。`capture` の任意引数 `trigger_sql` (#1537) は DDL 成功をきっかけにした自動取得のときの実行 SQL で、世代に紐づけて保存する

## 実行計画ウォッチ (`commands/plan_watch.rs`)

- `plan_watch_list`
- `plan_watch_set`
- `plan_watch_refresh`
- `plan_watch_import_legacy`

#743 / #1260。世代は `<data_dir>/plan_watch.sqlite`。`refresh` はウォッチ中スニペットの EXPLAIN をまとめて実行し、正規化・フィンガープリント・世代記録・前世代との比較を Rust 内で完結して件数だけを返す。履歴に記録せず、read_only セッションでも可。スニペット削除 (`delete_snippet`) は全プロファイルのウォッチを連鎖削除する

## タスクスケジューラ (`commands/tasks.rs`)

- `list_tasks`
- `save_task`
- `delete_task`
- `set_task_enabled`
- `run_task_now` (引数 `id`, `streamId`) — `cancel_stream` で中断でき、進捗は `task-run:progress` (`streamId` で絞る。#1534)
- `list_task_runs`
- `list_assertion_runs`
- `clear_task_runs`
- `get_scheduler_settings`
- `set_scheduler_settings`

## データ品質アサーション (`commands/assertions.rs`)

- `list_assertions`
- `save_assertion`
- `delete_assertion`
- `preview_assertion_sql`
- `run_assertion` (#742。定義は `assertions.json`、ルール → SQL は純ロジック `db::assertions`。実行は `run_lookup_query` と同じ裏方経路で、read_only セッションでも可・ルールごとにタイムアウト・履歴/結果キャッシュに載らない)

## フライトレコーダー / Undo (`commands/flight_recorder.rs`)

- `list_flight_records`
- `clear_flight_records`
- `preview_undo`
- `undo_flight_record`
- `preview_redo` (#1536。取り消し済みの記録を再適用する SQL と衝突のプレビュー)
- `redo_flight_record` (#1536。Undo と同じ衝突検出・force・read_only ガード・履歴記録の経路で再適用し、記録を「取り消し済み」から戻す)

## ローカル横断クエリ (`commands/local.rs`)

- `create_local_session`
- `register_local_table`
- `list_local_tables`
- `drop_local_table`
- `save_local_database`

## プロファイル (`commands/profiles.rs`)

- `list_profiles`
- `list_skipped_profiles` (一覧に出ないプロファイルの要約。解釈できない要素と対応外ドライバ。秘密は含めない、#1614)
- `delete_skipped_profile` (解釈できず読み飛ばされた要素を `profiles.json` から削除、#1614)
- `reveal_profile_secret`
- `save_profile`
- `delete_profile`
- `reorder_profiles`
- `export_profiles`
- `import_profiles`

## プロファイルの暗号化バックアップ (`commands/profile_backup.rs`)

- `export_profiles_encrypted`
- `import_profiles_encrypted` (#710。keyring の秘密込みでパスフレーズ暗号化 — Argon2id + AES-256-GCM、形式は `profiles/backup.rs` のモジュール doc。引数は `req` 構造体でパスフレーズを受け、応答は件数のみ)

## スニペット・履歴・ログ (`commands/snippets.rs`, `history.rs`, `logs.rs`)

- `list_snippets`
- `save_snippet`
- `delete_snippet`
- `list_history`
- `get_history_sql`
- `get_history_sqls` (#1608。複数 id の全文をまとめて取得。入力と同じ順・長さで、無い行は null。履歴 AI 検索の候補取得用)
- `list_history_sql`
- `clear_history`
- `get_history_retention_days` / `set_history_retention_days` (#1539。履歴の期間ベース保持。0 = 無効。保存と同時に期限切れ行を削除)
- `read_logs`
- `clear_logs`

履歴 (#1256): `list_history` は SQL 全文ではなく `sql_preview` (空白を畳んだ先頭 400
文字、超過は `…`) と `sql_len` を返す。全文は `get_history_sql(id)` を復元・コピー・
新規タブで開く・スニペット保存の時点で呼んで取る。`list_history_sql(profile_id, limit)` は
エディタの ↑/↓ 履歴ナビとコマンドパレット用に SQL 全文だけを新しい順に返す (実行の
たびに再取得せず、実行直後の SQL はフロントが先頭へ積む)。

## エクスポート / ダンプ / インポート / ファイル

- `export_query_result`
- `export_query_stream`
- `dump_database` (`options.tables` で対象テーブルを絞れる (#1399): MySQL は `mysqldump <db> <tbl>...`、PostgreSQL は `pg_dump --table` (スキーマ修飾)、SQLite は指定テーブル + 付随する索引/トリガー。未指定は DB 全体)
- `dump_tool_status`
- `install_dump_tool`
- `parse_csv_preview`
- `import_csv`
- `preview_create_table_ddl`
- `read_text_file`
- `read_sql_file`
- `write_text_file`
- `write_binary_file`
- `fetch_cell_bytes`
- `probe_cell_blob`
- `save_cell_to_file`
- `save_cells_to_folder`
- `read_binary_file`
- `get_import_skipped_text`
- `save_import_skipped_rows`
- `import_dry_run`
- `import_xlsx_sheets`
- `list_import_templates`
- `save_import_template`
- `delete_import_template`

`dump_tool_status` / `install_dump_tool` (`commands/dump_tools.rs`) はダンプ用の外部ツール
(`mysqldump` / `pg_dump`) を **noobDB を実行している PC** で探し (PATH → Homebrew の keg-only
や `Program Files\MySQL\MySQL Server *\bin` などの既知の場所)、無ければ OS のパッケージ
マネージャ (Windows: winget / macOS: Homebrew) で導入する。Linux は sudo が要るので
コマンドを返すだけ。踏み台・DB サーバには何も入れない。`dump_database` も同じ解決関数を使う。

`fetch_cell_bytes` / `probe_cell_blob` / `save_cell_to_file` / `read_binary_file`
(`commands/cell_blob.rs`, #1148 / #1258) は BLOB セルのファイル入出力とプレビュー用。
`probe_cell_blob` はサイズ (`OCTET_LENGTH` / `LENGTH`) と先頭 16 バイトだけを SELECT して
MIME・拡張子・画像か (`detect_blob_kind` がマジックバイト判定を担う) を返す (3 ドライバで
SQL を揃えている)。`fetch_cell_bytes` は主キーで 1 セルの生バイトを SELECT のみで引き直し
(`read_only` でも通る)、`read_binary_file` はファイルを読む (上限 16 MiB)。この 2 つは
`tauri::ipc::Response` で**生バイト**を返し、JS は `ArrayBuffer` で受ける (16 進や JSON 配列を
経由しない)。`save_cell_to_file` は DB → ファイルを Rust 内で完結させる (BLOB が IPC を通らない)。
書き戻しはフロントが `UPDATE` を組み立てて通常の `run_query` (読み取り専用ガード付き) で流す。
`save_cells_to_folder` (#1539) は複数行の BLOB 列を主キー由来のファイル名 (`<pk>.<ext>`、複合キーは
`-` 連結) で 1 つのフォルダへ書き出す。行ごとに probe でサイズ・種別を調べ、NULL / 16 MiB 超過は
飛ばし、拡張子は種別 (不明は `bin`)、既存ファイルは上書きせず `_2` を付ける。1 行の失敗で止めず
件数 (`saved` / `skippedNull` / `skippedTooLarge` / `failed`) と先頭 20 件の失敗理由を返す。
行数上限 10,000。保存先は既存のフォルダに限る (作成しない)。

`read_sql_file` (`commands/file.rs`, #1535) は SQL ファイルを**文字コード付き**で読む。`encoding`
省略は自動判定 (BOM → UTF-8 として妥当か → Shift_JIS / EUC-JP をスコアで判別。UTF-16 は BOM または
NUL の比率パターン。自動判定で本文に NUL があればエラー)、指定があればその文字コード
(先頭の BOM と食い違えばエラー。UTF-8 系は BOM の有無を実際に合わせて返す)。不正バイトは U+FFFD に置換せずエラー。戻り値
`{ content, encoding }` の `encoding` をフロントがタブ (`Tab.fileEncoding`) に覚え、保存時に
`write_text_file` の `encoding` へ渡して同じ文字コードに書き戻す。識別子は `utf-8` / `utf-8-bom` /
`utf-16le` / `utf-16be` / `shift_jis` / `euc-jp` (Rust `text_encoding::TextEncoding`)。`read_text_file`
(JSON の設定ファイルなど) は従来どおり UTF-8 固定。

`write_text_file` (`commands/file.rs`, #1258) は SQL・Markdown・JSON などのテキストを文字列の
まま書く (上限 32 MiB)。`encoding` (#1535) を省略すると BOM なし UTF-8。指定すると変換して書き、
その文字コードで表せない文字があれば置換せずエラーにする (UTF-8 BOM / UTF-16 は BOM を付ける)。`write_binary_file` は `tauri::ipc::Request` の raw ボディ
(`InvokeBody::Raw`) を受け、保存先パスはヘッダ `x-noobdb-path` に URL エンコードして載せる
(`api.writeBinaryFile` が `encodeURIComponent`、Rust 側 `decode_path_header` が復元)。

`get_import_skipped_text` / `save_import_skipped_rows` (`commands/import.rs`, #1258) は
skip モードの取り込みでスキップされた行の「全件」を扱う。`csv-import:done` には先頭
200 件 (`MAX_REPORTED_SKIPPED`) と総数 `skippedTotal` だけを載せ、全件は `AppState` が直近の
取り込み結果として保持する。表示文言はフロントの i18n テンプレートを引数で受ける。

`save_import_skipped_rows` は任意引数 `format` (`text` 既定 / `csv` / `ndjson`、#1623) を取る。
`csv` / `ndjson` はスキップ行の元の行データ (取り込み先の列順、`SkippedRowInfo.cells`) を
書き出し、直してそのまま再取り込みできる。`cells` は IPC には載せず (`#[serde(skip)]`)、
列名とともに `AppState` が保持する。

`import_dry_run` (`commands/import.rs`, #1623) は取り込みの事前検証。本番と同じ
`load_import_rows` で行を作り、`Connection::dry_run_failures` が**必ずロールバックする**
トランザクションで 1 行ずつ INSERT して拒否される行を数える (PostgreSQL は行ごとに
SAVEPOINT)。MySQL の非トランザクショナル表は拒否。読み取り専用接続でも実行できる。
新規テーブル作成付き (`createTable`) は DB を試さずファイルのパースと主キー検証だけ
(`dbChecked: false`)。結果は失敗の総数と先頭 50 件 (`DRY_RUN_REPORT_LIMIT`)。

`import_xlsx_sheets` (`commands/import.rs`, #1623) は xlsx の複数シートを、シートごとに別の
**新規テーブル**へ順に取り込む。各シートは `run_import_core` を通る単独の取り込みと同じ
トランザクション単位で、`csv-import:started` はシートごと、`csv-import:done` は全体で 1 回
(`sheets` にシートごとの件数)。失敗したシートで止まり、それより前のシートは取り込み済みのまま
(エラー文に取り込み済みのシートを添える)。シートごとに列が違うので、元データ付きのスキップ行
書き出し (`csv` / `ndjson`) は使えない (テキストのみ)。

`list_import_templates` / `save_import_template` / `delete_import_template`
(`commands/import_templates.rs`, `import_templates/`, #1623) は接続 × データベース × テーブル単位の
取り込みマッピングテンプレート (列の対応・区切り文字・NULL トークン・文字コード・キー列など)。
data_dir の `import_templates.json` (非秘密、ファイルパスも持たない)。同じキーは置き換わり、
500 件を超えたら更新が古いものから捨てる。

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

`run_sql_script` の `options` (#1535) は `continueOnError` / `wrapInTransaction` に加えて、
`encoding` (省略 = 自動判定。**実行前にファイル全体を事前スキャン**して判定と妥当性確認を済ませ、
不正バイトなら 1 文も実行しない)、`startAtStatement` (この通し番号より前の文を実行せず読み飛ばす。
`ScriptFailure.index` と同じ 1 始まりでトランザクション制御文を含む。失敗した文からの再開用。読み飛ばした
文の `USE` による DB 切り替えには追従する)、`skipStatements` (個別除外する通し番号。上限 10 万件。
**BEGIN / COMMIT / ROLLBACK の番号は指定されても無視して実行する**)、`expectedFile` (事前確認時の
`{ size, mtimeMs }` = `sql-script:analyzed` の `fileStamp`。実行時のファイルと違えば 1 文も実行せずエラー) を持つ。
`sql-script:done` に `skippedExcluded` / `skippedBeforeStart` が付く。`sql-script:error` には
`inTransaction` (失敗時にトランザクションが開いていた。ROLLBACK の成否に関係なく true) と
`txBeginStatement` (スクリプト内の BEGIN の通し番号) が付き、フロントはトランザクション中の失敗では
「この文から再開」を出さず、BEGIN の文から再開させる。

`analyze_sql_script` (`commands/script.rs`, #1535) — 実行前の**事前確認 (ドライラン)**。`run_sql_script`
と同じストリーミング読み + 文分割で 1 文ずつ `db/script_analysis.rs` の `ScriptAnalyzer` へ渡し、
DB には触れない。保持するのは有限個の集計だけ (文の総数・種別ごとの件数・危険文の件数と先頭 200 件・
トランザクション制御文の位置の先頭 200 件・先頭 300 文の一覧・読み取り専用セッションで拒否される文の数)
なので GB 級でもメモリに全文を載せない。判定は実行時と同じ `is_read_only_sql_for` /
`classify_tx_statement` / `sql_may_change_schema` を流用し、危険文 (WHERE なしの DELETE/UPDATE、
DROP、TRUNCATE) は `classify_dangerous` (フロント `analyzeDangerousSql` の Rust 実装。共有ゴールデン
`dangerousSqlVectors.json` で固定)。一覧の `index` は実行時の通し番号と同じなので、UI の個別除外
(`skipStatements`) と再開位置 (`startAtStatement`) にそのまま使える。進捗は `sql-script:progress`
(`executed` = 走査済みの文数、`failed` = 見つけた危険文の数)、結果は `sql-script:analyzed`、失敗は
`sql-script:error`、中断は `cancel_stream` (`sql-script:cancelled`)。

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

`preview_transfer` — 転送前プレビュー (#1532)。ソースの先頭バッチだけ読んで打ち切り、転送先の
列定義と、値や型が縮退する列 (`lossy`: decimal の桁丸め・TIMESTAMPTZ の縮退など) を返す。
書き込み・DDL はしない。

## Schema Cache (`commands/schema.rs`, #1097)

`refresh_schema_cache` — セッション単位の Schema Cache (`cache::SchemaCache`) を
明示的に無効化する。DDL 実行時 (`run_query` / `run_query_transaction` /
`run_in_transaction` / `apply_sync_sql`) は成功後にバックエンドが自動で
invalidate するため、通常のフローでこのコマンドを呼ぶ必要はない — Schema
Browser の更新ボタンなど、ユーザが明示的に最新化したいときのみ使う。

`invalidate_table_cache` — 1 つのテーブルだけの Schema Cache を無効化する (#1539)。ALTER /
CREATE INDEX の適用後など対象が分かるとき、接続全体の `refresh_schema_cache` の代わりに呼ぶ。
バックエンド側でも `run_query_transaction` / `run_query` が、単一テーブルだけに効く単純な DDL
(`db::schema_scope`) ならこのテーブル単位の無効化に切り替える (解析できない DDL は従来どおり全体)。

`schema_cache_times` — テーブル一覧をキャッシュした DB ごとの取得時刻 (epoch ミリ秒)。ツリーの
「キャッシュ取得 HH:MM」表示用。内容は返さず時刻だけ。
