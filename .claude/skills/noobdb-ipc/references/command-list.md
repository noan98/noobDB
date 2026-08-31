# IPC コマンド一覧

`src-tauri/src/lib.rs::run()` の `generate_handler!` に登録されている **98 コマンド**の
全件です。`src/api/tauri.ts` の `api` オブジェクトがこれをミラーします。

> **このファイルは `src/__tests__/docCommandParity.test.ts` が
> `generate_handler!` と突き合わせています。** コマンドを追加・削除したらここも
> 更新してください (更新しないと CI が落ちます)。

## 接続 (`commands/connection.rs`)

`test_connection` / `connect` / `cancel_connect` / `ping_session` / `disconnect` /
`reconnect`

## SSH (`commands/ssh.rs`)

`list_known_hosts` / `forget_host_key` / `trust_host_key` / `resolve_ssh_config_host`

## クエリ実行・トランザクション (`commands/query.rs`)

`run_query` / `run_query_transaction` / `run_query_stream` / `preview_query_stream` /
`cancel_stream` / `set_emergency_mode` / `begin_transaction` / `run_in_transaction` /
`finish_transaction`

## スキーマ (`commands/schema.rs`)

`list_databases` / `list_tables` / `describe_table` / `table_row_identity` /
`schema_overview` / `foreign_keys` / `list_schema_objects` / `get_object_definition` /
`list_indexes` / `table_row_estimates` / `table_sizes`

## 比較・同期 (`commands/diff.rs`, `commands/sync.rs`)

`compare_schema` / `compare_table_data` / `diff_schema_snapshots` /
`generate_sync_sql` / `generate_data_sync_sql` / `apply_sync_sql`

## サンドボックス (`commands/sandbox.rs`)

`create_sandbox` / `list_sandboxes` / `discard_sandbox` / `sandbox_table_diff` /
`sandbox_schema_diff` / `filter_sandbox_data_diff` / `sandbox_advance_base`

## プロセス管理・ユーザ / 権限 (`commands/process.rs`, `commands/privileges.rs`)

`list_processes` / `kill_process` / `list_db_users` / `list_user_privileges` /
`generate_create_user_sql` / `generate_drop_user_sql` / `generate_alter_password_sql` /
`generate_grant_sql` / `generate_revoke_sql` / `apply_privilege_sql`

## 診断 (`commands/advisor.rs`, `commands/inspector.rs`, `commands/server.rs`)

`analyze_schema_health` / `query_stats_support` / `sample_live_queries` /
`sample_statement_stats` / `server_info` / `server_metrics`

## タスクスケジューラ (`commands/tasks.rs`)

`list_tasks` / `save_task` / `delete_task` / `set_task_enabled` / `run_task_now` /
`list_task_runs` / `clear_task_runs` / `get_scheduler_settings` /
`set_scheduler_settings`

## フライトレコーダー / Undo (`commands/flight_recorder.rs`)

`list_flight_records` / `clear_flight_records` / `preview_undo` / `undo_flight_record`

## ローカル横断クエリ (`commands/local.rs`)

`create_local_session` / `register_local_table` / `list_local_tables` /
`drop_local_table` / `save_local_database`

## プロファイル (`commands/profiles.rs`)

`list_profiles` / `reveal_profile_secret` / `save_profile` / `delete_profile` /
`reorder_profiles` / `export_profiles` / `import_profiles`

## スニペット・履歴・ログ (`commands/snippets.rs`, `history.rs`, `logs.rs`)

`list_snippets` / `save_snippet` / `delete_snippet` / `list_history` / `clear_history` /
`read_logs` / `clear_logs`

## エクスポート / ダンプ / インポート / ファイル

`export_query_result` / `export_query_stream` / `dump_database` / `parse_csv_preview` /
`import_csv` / `read_text_file` / `write_binary_file`
