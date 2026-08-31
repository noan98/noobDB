# 管理機能 (プロセス / ユーザ権限 / ローカル横断クエリ / 自動更新)

サーバプロセス管理、ユーザ・権限管理、ローカル横断クエリ、アプリ内自動更新。

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
## ローカル横断クエリ (#740)

複数接続の結果セットをローカルエンジンへ取り込み、異種 DB 間 JOIN・再分析を 1 アプリ内で
完結させる機能です。第 1 候補は DuckDB (#709) でしたが、本実装は #709 に先行しないため
**既にフル依存済みの組み込み SQLite をインメモリ相当 (一時ファイル) で使う縮退構成**を
採用しています。将来 DuckDB へ差し替える場合は `db::Connection` の `Sqlite` 版
`register_local_table` / `list_local_tables` / `drop_local_table` / `vacuum_into` を
新バリアントへ実装し直すだけで、`commands/local.rs` (IPC 層) は無改修で済む設計です。

- **「ローカル」接続 = 駆動元セッションを持たない特殊セッション**。`create_local_session`
  が OS 標準の一時領域 (`std::env::temp_dir()/noobdb-local/`) に空の SQLite ファイルを
  touch し、既存の `Connection::Sqlite` としてそのまま開きます。以降のクエリ実行は
  **既存の `run_query` / `run_query_stream` 等をそのまま再利用**し、新しい実行経路は
  一切増やしていません。フロント (`App.tsx`) はこの「ローカル」を実在しない擬似
  `ConnectionProfile` (`id: "__local__"`、`driver: "sqlite"`) として扱い、`handleConnect`
  内で `id` を見て `api.connect` の代わりに `api.createLocalSession` を呼ぶ以外は、
  複数同時接続のタブ切替・タブ復元・エディタ・グリッド・エクスポートを他の接続と
  完全に共有します。
- **登録**: `register_local_table` が `db::types::{Column, Value}` (既存のワイヤ
  フォーマットそのもの) を受け取り、`db::sqlite::SqliteConn::register_local_table` が
  1 トランザクションで「テーブル作成 (無型宣言 = BLOB affinity で値を無変換のまま保持) →
  行 INSERT (`Value` を文字列往復させず直接 bind — `Bytes` は実 BLOB に、`Int`/`Float`/
  `Bool` はそれぞれの storage class に、`Null` は SQL NULL に) → 由来メタデータ upsert」
  まで行います。無型宣言のカラムは SQLite の BLOB affinity (無変換) を利用しており、
  型付き `Value` から文字列を経由しない分、CSV インポート系の文字列ベース経路より
  高精度に往復します。取り込み対象は**在メモリの取得済み行のみ**で、上限
  `MAX_LOCAL_TABLE_ROWS = 200_000` (バックエンド `commands/local.rs` とフロント
  `components/localQuery.ts` の同名定数で表現) を超える登録はバックエンドが拒否します。
- **由来メタデータ**は隠しカタログテーブル `__noobdb_local_meta` (ローカル DB 自身の中、
  初回登録時に遅延作成) に保存し、`LocalTableMeta` (元の接続名・実行 SQL・ドライバ・
  登録日時・行数) として `list_local_tables` で返します。セッション固有の `AppState`
  側の別管理は持たず、ローカル DB ファイル自体がこの状態の単一の情報源です。
- **置き場所は全ユーザ共有なので、権限と所有者を検証してから使う (Unix)**:
  `std::env::temp_dir()/noobdb-local/` には複数 DB を横断結合した**実データ**が入る
  一方、`/tmp` は誰でも書ける固定パスです。ディレクトリは `0700` で作成し、既に
  存在する場合は「シンボリックリンクでない・実ディレクトリである・所有者が自分・
  group/other に権限が無い」の 4 点を `symlink_metadata` (lstat) で確認してから使い、
  満たさなければ**黙って使わずエラーで拒否**します (攻撃者に先回りで作られた
  ディレクトリやリンクへ書き込まないため)。SQLite ファイル自体も `create_new`
  (`O_CREAT|O_EXCL`、リンクを辿らない) + `mode(0o600)` で作ります
  (`dump.rs::DefaultsFile::create` と同じパターン)。`cleanup_stale_local_files` も
  同様に lstat してから消すので、`noobdb-local` がリンクへ差し替えられていても
  リンク先を再帰削除しません。
- **既定揮発 / 明示操作でのみ永続化**: バッキングファイルは OS 標準の一時領域に置き、
  `disconnect` 時に削除します (`Session.local_temp_file` の有無で「ローカルセッション
  かどうか」を判別)。アプリ異常終了で削除が走らなくても、次回起動時に
  `commands::local::cleanup_stale_local_files` が同ディレクトリを丸ごと掃除します
  (前回起動のセッションはどのみち全て無効なので安全)。「ファイルに保存」は
  `save_local_database` → SQLite の `VACUUM INTO` で独立したスナップショットファイルを
  書き出すだけで、元のセッション自体の揮発性は変えません。
- **UI**: `ResultGrid` の「ローカルに登録」ボタン (`RegisterLocalTableModal` で名前確認
  + 件数/上限/プライバシー注記を表示) と、サイドバーの「ローカル」タブ
  (`LocalTablesPanel`。登録済みテーブルの由来一覧・削除・ファイル保存)。安全性/
  プライバシーの明示 (外部送信なし、ここでの書き込みは元接続に反映されない) は
  モーダル文言に集約しています。
- 統合テストは `tests/local_query_integration.rs` に集約 (SQLite ベースで外部サーバ
  不要・常時実行)。異種「接続」2 つ (別々の temp SQLite ファイルで模擬) からの登録 →
  JOIN、BLOB/NULL/日時の往復、上限行数超過の拒否、非ローカルセッションへの誤呼び出し
  拒否、`VACUUM INTO` によるファイル保存を検証します。

## アプリ内自動更新 (Tauri updater プラグイン統合、#705)

配布した旧バージョンのアプリが、GitHub Releases に上がった新バージョンを検出 →
ダウンロード → 適用 (再起動) までアプリ内で行える仕組みです。Tauri 公式の
`tauri-plugin-updater` (検出/ダウンロード/**署名検証**) と `tauri-plugin-process`
(適用後の `relaunch`) を統合しています。既存の dialog / notification プラグインと
同じく、フロントは Rust コマンドではなく**プラグイン自体の JS API**
(`@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process`) を直接呼ぶため、
`invoke_handler!` へのコマンド追加はありません (`lib.rs` は desktop ターゲット限定の
`#[cfg(desktop)]` ブロックで両プラグインを登録)。

- **フロント構成**: 副作用層 `updater.ts` (プラグイン呼び出し: `getCurrentAppVersion`
  / `checkForAppUpdate` / `installUpdateAndRestart` / `dismissUpdate`) と、純粋な整形層
  `updaterFormat.ts` (`downloadProgressPercent` / `truncateReleaseNotes` /
  `displayVersion`。Vitest 対象) を通知 (`notifications.ts` ⇔ `queryNotify.ts`) と同じ
  方針で分離しています。確認ダイアログ → 承認時のダウンロード/適用という UI フローは
  `components/updatePrompt.tsx` の `confirmAndInstallUpdate` に集約し、起動時チェック
  (`App.tsx`) と設定画面の手動チェック (`SettingsView` の「更新を確認」ボタン + 現在
  バージョン表示) の両方から使います。
- **ユーザ承認制 / ベストエフォート**: 起動時に一度だけ自動チェックし
  (`settings.ts` の `autoUpdateCheckEnabled`、既定オン。オフラインや社内配布向けに
  設定でオフにできる)、更新があっても**ダウンロード・適用・再起動はユーザが確認
  ダイアログで承認したときだけ**行います (勝手に再起動しない)。オフラインや
  マニフェスト取得失敗など**チェック自体の失敗**は起動時は静かに無視し (起動を
  ブロックしない)、手動チェックのみエラーをトーストで知らせます
  (`checkForAppUpdate` は「最新 = null」と「失敗 = throw」を区別)。
- **capabilities**: 最小権限方針を維持し `updater:default` と `process:allow-restart`
  のみ追加 (`capabilities/default.json`)。
- **署名と配布**: `tauri.conf.json` の `bundle.createUpdaterArtifacts: true` で更新用
  成果物 (署名付き) と `latest.json` を生成し、`plugins.updater.pubkey` の**公開鍵**で
  署名を検証します (検証に失敗した更新は適用されません)。`endpoints` は
  `https://github.com/noan98/noobDB/releases/latest/download/latest.json`。**秘密鍵は
  リポジトリや `profiles.json` には置かず** (秘密分離の既存方針)、GitHub Actions の
  Secrets `TAURI_SIGNING_PRIVATE_KEY` (鍵にパスワードを付けた場合は
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) で管理します。`release.yml` のタグビルド
  (`tauri-action`) がこの Secrets を使って署名し `latest.json` を自動アップロード
  します。キャッシュ温めビルド (main push、鍵なし) は `--config` で
  `createUpdaterArtifacts` を false に上書きして署名を要求せずに通します。

> **セットアップ必須 (メンテナ作業)**: リポジトリに現在入っている
> `plugins.updater.pubkey` は**プレースホルダの公開鍵**です。実運用では
> `pnpm tauri signer generate` で鍵ペアを生成し、**公開鍵で
> `tauri.conf.json` の `pubkey` を差し替え**、**秘密鍵を GitHub Actions Secrets
> `TAURI_SIGNING_PRIVATE_KEY` に登録**してください (公開鍵は非秘密なのでコミット
> 可、秘密鍵は絶対にコミットしない)。公開鍵と Secrets の秘密鍵が対でないと、
> 署名検証が通らず更新が適用されません。ターゲットは Windows (NSIS) が最初で、
> macOS / Linux バンドル対応が入ったら同じマニフェストに載ります。
