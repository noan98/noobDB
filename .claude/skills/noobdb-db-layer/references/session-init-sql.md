# セッション初期化 SQL (#522)

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
