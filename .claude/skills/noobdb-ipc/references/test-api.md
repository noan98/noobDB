# テスト専用 API と Tauri capabilities

## テスト専用 API

`lib.rs` は `pub mod __test_api` (`#[doc(hidden)]`) を公開しており、
`src-tauri/tests/` 配下の統合テストが Tauri を経由せずに `db::Connection` の
経路を駆動できるようにしています。`connect`・`parse_mysql_url`・
`parse_postgres_url`・`sqlite_options`・`mysql_exec_text`・`is_read_only_sql`
(ゴールデンベクタ検証用)・`kill_process_inner` (Tauri State 不要のプロセス強制終了)
などを提供します。新しいテスト用エントリポイントが必要な場合は、内部モジュールを
公開するのではなく、ここに追加してください。

**コマンド層の常時実行カバレッジ (#881)。** `commands/inspector.rs` /
`commands/server.rs` / `commands/process.rs` は env ゲートの MySQL/PostgreSQL
統合テストからしか実行されておらず、`rust (windows test)` ジョブや env 変数を
設定しないローカルの `cargo test` (= SQLite のみ) では**コマンド境界が 1 度も
走りません**でした。各コマンドの State なしコア
(`query_stats_support_inner` / `sample_live_queries_inner` /
`sample_statement_stats_inner` / `server_info_inner` / `server_metrics_inner` /
`list_processes_inner`) を `__test_api` から公開し、常時実走の
`tests/sqlite_integration.rs` が「SQLite 短絡パスの戻り値 (縮退レスポンス /
非対応エラー)」「未知セッション ID での `SessionNotFound`」「読み取り操作は
read_only セッションでも通ること」を外部サーバ無しで固定します。`_inner` を切る
パターンは `commands::query::run_query_inner` と同じで、`#[tauri::command]` 側は
一行のラッパーに徹します。

## Tauri capabilities

`src-tauri/capabilities/default.json` は意図的に最小限です: ウィンドウ / app /
イベントのデフォルトに加え、`dialog:allow-open` / `dialog:allow-save` のみ。
具体的な必要性がない限り、権限を追加しないでください — フロントエンドはバックエンドの
コマンドを呼び出すべきで、シェルや fs の API を直接叩くべきではありません。
