# プロセス管理とユーザ / 権限管理

## プロセス管理

`commands/process.rs` の `list_processes` / `kill_process` が、サーバのアクティブな
接続/クエリ (MySQL `PROCESSLIST`、PostgreSQL `pg_stat_activity`) を `ProcessInfo` として
列挙し、選択したプロセス/接続を強制終了します。`list_processes` は読み取り操作なので
読み取り専用セッションでも許可しますが、`kill_process` はサーバ状態を変えるため
読み取り専用セッションを明示的に拒否します (SQL 文ではないので `is_read_only_sql` の
経路外、コマンド側で別途ガード)。SQLite はサーバプロセスを持たないため空を返します。
なお #587 で `performance_schema` 無効時に MySQL のプロセス一覧が空になる問題を修正済み。

## ユーザ / 権限管理 (#732)

MySQL ユーザ (`mysql.user` + `mysql.tables_priv`) / PostgreSQL ロール (`pg_roles` +
`information_schema.role_table_grants`) の一覧と、選択したユーザ/ロールのテーブル単位
CRUD+DDL 権限マトリクスを閲覧・編集する機能です。Diff/Sync (`db::sync` /
`commands::sync`) と同じ「SQL 生成 (純粋) → プレビュー → 確認 → 適用」の分離パターンを
踏襲します。

- `db/privileges.rs`: `CREATE USER` / `DROP USER` / `ALTER USER ... PASSWORD` /
  `GRANT` / `REVOKE` を方言別に生成する副作用なしの純ロジック。識別子クオートは
  `db::sync::quote_ident` を共有し、単体テストでドライバ別の生成 SQL を固定しています。
  DDL チェックボックスは各ドライバがテーブル単位で実際に `GRANT` できるスキーマ変更系
  権限をまとめたもの (MySQL: `CREATE`/`ALTER`/`DROP`/`INDEX`/`REFERENCES`、PostgreSQL:
  `TRUNCATE`/`REFERENCES`/`TRIGGER` — PostgreSQL の `CREATE`/`ALTER`/`DROP TABLE` は
  テーブル単位の `GRANT` ではなくスキーマ所有権 / `CREATE ON SCHEMA` で制御されるため
  対象外)。**MySQL の `GRANT ... ON db.*` では DB 名の `_` / `%` を `\_` / `\%` に
  エスケープします** — MySQL は `mysql.db` の `Db` 列を LIKE パターンとして評価する
  ため、バッククォートで囲んでいてもエスケープしないと `my_app` への GRANT が
  `myXapp` にも波及し最小権限原則が崩れます。テーブルを明示する `db.table` 形式
  (`mysql.tables_priv`) はパターン評価を受けないので対象外です。
- `db::Connection::list_db_users` / `user_privileges` が `mysql.user` / `pg_roles` を
  読む読み取り専用の introspection です。SQLite はユーザ概念を持たないため
  `list_processes` と同じ「空ではなくエラーで非対応を明示する」方針で `AppError` を
  返し、フロントはこの機能の導線自体を出しません。
- `commands/privileges.rs::apply_privilege_sql` は `apply_sync_sql_inner` と同じく
  `execute_transaction` を直接呼び、`run_query_transaction` の履歴記録経路を経由しません
  — `CREATE USER`/`ALTER USER ... PASSWORD` はパスワードを SQL リテラルとして含みうる
  ため、クエリ履歴にもログにも一切残しません。読み取り専用セッションは
  `kill_process` と同じくコマンド側で明示的に拒否します (`is_read_only_sql` を通らない
  経路のため)。
- フロント (`UsersPanel.tsx`) は MySQL の `mysql.user` グローバル (`*.*`) 権限行を
  意図的に**表示専用**にしています — このパネルが編集するのは選択中データベースの
  テーブル単位権限 (`GRANT ... ON db.table`) で、スコープが異なるサーバ全体権限を
  誤って書き換えてしまう事故を避けるためです。`DROP USER` は typed confirmation 付きの
  danger 確認、`REVOKE` を含む権限変更は danger 確認、それ以外は primary 確認を経ます。
- 権限不足エラー (MySQL "command denied to user" / PostgreSQL "permission denied
  for ..." / "must be owner of ..." / "must be superuser") のヒントを `errorHints.ts`
  に追加しています (`errorHintInsufficientPrivilege`)。
