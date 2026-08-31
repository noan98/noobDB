# IPC 表面・テスト専用 API・capabilities

`#[tauri::command]` の登録一覧、エラーの構造化、`__test_api`、Tauri capabilities の最小権限方針。

## IPC 表面

すべての `#[tauri::command]` は `lib.rs::run()` 内の `invoke_handler!` マクロで
登録されます。現在のコマンド群:

- 接続: `test_connection` / `connect` / `disconnect` / `reconnect` /
  `ping_session` / `cancel_connect`
- SSH known_hosts: `list_known_hosts` / `forget_host_key` / `trust_host_key`
- SSH config: `resolve_ssh_config_host` (`~/.ssh/config` エイリアス解決。#708)
- クエリ: `run_query` / `run_query_transaction` / `run_query_stream` /
  `preview_query_stream` / `cancel_stream` / `set_emergency_mode`
- 明示的トランザクション: `begin_transaction` / `run_in_transaction` /
  `finish_transaction`
- スキーマ: `list_databases` / `list_tables` / `describe_table` /
  `schema_overview` / `foreign_keys` / `list_indexes` / `list_schema_objects` /
  `get_object_definition` / `table_row_estimates`
- プロセス管理: `list_processes` / `kill_process`
- ユーザ / 権限管理: `list_db_users` / `list_user_privileges` /
  `generate_create_user_sql` / `generate_drop_user_sql` / `generate_alter_password_sql` /
  `generate_grant_sql` / `generate_revoke_sql` / `apply_privilege_sql`
- 比較・同期 (Diff/Sync): `compare_schema` / `compare_table_data` /
  `generate_sync_sql` / `generate_data_sync_sql` / `apply_sync_sql`
- サンドボックス (壊せる砂場、#747): `create_sandbox` / `list_sandboxes` /
  `discard_sandbox` / `sandbox_table_diff` / `sandbox_schema_diff` /
  `filter_sandbox_data_diff` / `sandbox_advance_base`
- プロファイル: `list_profiles` / `reveal_profile_secret` / `save_profile` /
  `delete_profile` / `export_profiles` / `import_profiles`
- スニペット: `list_snippets` / `save_snippet` / `delete_snippet`
- 履歴: `list_history` / `clear_history`
- ログ: `read_logs` / `clear_logs`
- エクスポート/ダンプ/インポート: `export_query_result` / `export_query_stream` /
  `dump_database` / `parse_csv_preview` / `import_csv`
- ファイル: `read_text_file` / `write_binary_file`

完全なリストは
`src/api/tauri.ts` の `api` オブジェクトにミラーされています (`src/__tests__/
ipcCommandParity.test.ts` が Rust 側登録と `tauri.ts` の対応をテストで突き合わせます)。
**コマンドを追加する
ときは: Rust ハンドラを追加し、`lib.rs` で登録し、`tauri.ts` に型付けされたラッパー
(とストリーミングなら対応する `listen*` ヘルパー) を追加します — これらの間でズレが
発生するとフロントエンドが暗黙のうちに壊れます。**

**さらに「UI からそのラッパーに到達できるか」も検証します (#907)。**
`ipcCommandParity` が担保するのは「lib.rs 登録 ⇔ `tauri.ts` ラッパ」の集合一致まで
で、その先の到達性は誰も見ていませんでした。`api` は単一オブジェクトとして export され
UI で使われているため **knip では原理的にプロパティ単位の未使用を検出できず**、逆に
`ipcCommandParity` は集合完全一致を強制するので UI 未接続のラッパーを消すと CI が
落ちる — 結果としてデッドラッパーが構造的に不可視でした。
`src/__tests__/apiReachabilityParity.test.ts` が `Object.keys(api)` と `src/` 配下
(`api/tauri.ts` と `__tests__/` を除く) の `api.<name>` 参照を突き合わせ、**どこからも
呼ばれないラッパーがあれば落ちます**。逃げ道の許可リスト
`INTENTIONALLY_UNREACHABLE` は**空のまま維持するのが理想**で、追加するときは理由を
併記してください (「まだ UI を作っていない」は理由になりません — UI を足すか、
ラッパーと Rust コマンドを一緒に消す)。この方針で #907 では
`run_captured_write` / `precheck_captured_write` を IPC ごと削除しました (書き込み記録は
`run_query_stream({ capture: true })` に一本化済み。`run_captured_write_inner` は
その共通コアとして残る)。`clear_flight_records` / `clear_task_runs` は同じ調査で
UI 未接続と分かりましたが、#910 が `FlightRecorderPanel` の「全消去」/ `TaskManager`
の「実行履歴をクリア」導線を追加して解消済みです。

**「3 点コントラクト」の残る 1 辺 (#1031)。** `ipcCommandParity` は `generate_handler!`
の**登録**集合を「正」とみなして `tauri.ts` と突き合わせるため、`#[tauri::command]`
が付いているのに `generate_handler!` から**登録し忘れた**関数はどちらの集合にも
現れず不可視のまま (`apiReachabilityParity` は Rust ソースを読まないので対象外、
knip は TS 限定で Rust の未使用関数を検出しない)。
`src/__tests__/commandRegistrationParity.test.ts` が `import.meta.glob` で
`src-tauri/src/commands/**/*.rs` を再帰的に読み、実在する `#[tauri::command]
pub (async) fn <name>` を抽出して `generate_handler!` 登録集合の部分集合であることを
検証し、この最後の 1 辺を塞ぎます。抽出前に行コメント (`//` 始まり、`///`/`//!` も
同じ手法で除去可能) を取り除くのが要点で、そうしないと「The `#[tauri::command]`
wrapper above is intentionally a one-liner over this.」のような**説明文中の記法**
(`commands/query.rs::run_query_inner` / `commands/sync.rs::apply_sync_sql_inner` /
`commands/sandbox.rs` のモジュール doc に実例あり) を誤って属性だと検出してしまいます。

エラーは `AppError` として上に
伝搬し、`{ kind, message }` の**構造化 JSON** としてシリアライズされます
(`error.rs::Serialize` / `AppError::kind()` を参照。#683)。`kind` はバリアント由来の
安定した判別子 (`ssh` / `sshHostKeyMismatch` / `timeout` / `readOnly` /
`connectionLost` / `invalidInput` / `db` ...) で、`message` は従来の `Display` 文字列
です。フロントの `src/api/tauri.ts` の `invoke` ラッパーが reject 値を
`BackendError` (`.kind` / `.message` を持つ。`toString()` は `message` を返すので
既存の `String(e)` 経路は不変) に正規化し、**旧形式の素の文字列も後方互換で受け付け**
ます (`normalizeBackendError`)。`src/errorHints.ts` は「`kind` による確実な分類
(`hintForKind`) → `message` パターンはフォールバック (`matchErrorHint`)」の 2 段構成
(`resolveErrorHint`) で、SSH 系 (認証失敗 / エージェント不在 / 鍵・パスフレーズ /
ホスト鍵不一致) のヒントもここで解決します。`kind` → ヒントの対応はフロント/バック
共有ゴールデン (`src/__tests__/fixtures/errorKindVectors.json` を
`errorKindGolden.test.ts` と `tests/error_kind_golden.rs` が突き合わせ) で固定して
います。**`error.rs` にバリアントを追加するときは `kind()` の分岐も更新**してください。

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
