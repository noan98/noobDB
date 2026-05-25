# CLAUDE.md

このファイルは、本リポジトリのコードを扱う際に Claude Code (claude.ai/code) に
向けたガイダンスを提供します。

## 言語ポリシー

- **プルリクエスト (PR) の作成は必ず日本語で行ってください。** PR のタイトル・
  本文・サマリー・テスト計画など、PR に含まれるすべての記述を日本語で記述します。
  これは Claude Code が本リポジトリで PR を作成するすべての状況に適用される、
  例外のないルールです。

## Issue のラベリングポリシー

- **新規 Issue を作成するときは、対応コストとメリットを必ずラベルで明示してください。**
  運用判断 (どれから着手するか / 後回しにするか) の材料になるため、両軸が揃って
  いない Issue は作成しないでください。既存 Issue を更新する際にも、これらの
  ラベルが付いていなければ合わせて付与します。
- **コスト (実装にかかる労力) は 3 段階**。実装規模・影響範囲・必要な検証を踏まえて
  判定します。
  - `cost:Low` — 数時間〜半日程度。フラグ追加や UI の小改修など、影響範囲が限定的。
  - `cost:Mid` — 1〜数日程度。新しいモジュール 1 つや既存パターンの拡張で済む規模。
  - `cost:High` — 1 週間以上。新ドライバ追加・新ストレージ導入・複数レイヤを跨ぐ
    大規模変更など、設計検討と広範な検証が必要。
- **メリット (対応することによる価値) は 5 段階**。利用者への影響度・対象ユーザ数・
  事故防止や日常 DX への寄与を踏まえて判定します。
  - `benefit:1` — ごく一部のユーザのみが恩恵を受ける、または見た目の微調整レベル。
  - `benefit:2` — 一部ユーザの利便性が改善する程度。
  - `benefit:3` — 多くのユーザが日常的に恩恵を受ける QoL 改善や、特定ユースケース
    での価値が大きい機能。
  - `benefit:4` — 主要なワークフローを大きく改善する、または README ロードマップに
    明記された重要機能。
  - `benefit:5` — プロダクトの位置付けや安全性を一段引き上げる中核機能 (新 DB
    対応・誤操作防止・破壊的編集 UX など)。
- ラベルは GitHub 上に存在しなければ自動作成されますが、命名は上記に厳密に従って
  ください (`cost:low|medium|high`、`benefit:1`〜`benefit:5`)。揺れがあると後段の
  集計・フィルタが壊れます。
- 判断に迷ったら Issue 本文の末尾に「コスト: medium (理由: ...) / メリット: 4
  (理由: ...)」のように短い根拠を残しておくと、後から見直しやすくなります。

## Issue と PR の紐付け

- **関連 Issue がある PR では、本文にクロージングキーワードを必ず含めてください。**
  GitHub は PR 本文 (またはマージ先ブランチに残るコミットメッセージ) に
  `Closes #123` / `Fixes #123` / `Resolves #123` などのキーワードが含まれている
  ときだけ、マージと同時に Issue を自動でクローズします。タイトルの `(#123)` や
  本文中の `#123` 単独はリンクされるだけで、close はされません。
- 複数 Issue を解消する PR では、それぞれにキーワードを付けてください。例:

  ```
  Closes #77
  Closes #73
  ```

  または 1 行で `Closes #77, closes #73` のように書けます。
- キーワード自体は英語のままで構いません (日本語本文との混在 OK)。PR 本文の
  冒頭または末尾の独立した行に置くのが確実です。コードブロックや引用 (`>`) の
  中に入れるとパースされません。
- 自動クローズの判定はマージ時点で行われます。マージ後に本文を編集しても
  Issue は閉じないため、その場合は手動で Issue をクローズしてください。
- **Epic (トラッキング Issue) の子をすべて解消する PR では、各子 Issue に加えて
  Epic 本体にも `Closes #<Epic番号>` を必ず入れてください。** Epic は子 Issue の
  クローズに連動して自動では閉じないため、最後の子をまとめて解消する PR で Epic
  も一緒に閉じます。例:

  ```
  Closes #115
  Closes #116
  Closes #154
  ```

  ただし子 Issue の一部だけを解消する (Epic がまだ完了しない) PR には Epic の
  `Closes` を入れないでください。早期クローズになります。その場合は子 Issue の
  キーワードのみ記載し、Epic は残った子が片付いた最後の PR で閉じます。

## コマンド

フロントエンド (リポジトリのルートから実行):

```sh
npm install
npm run dev            # vite 開発サーバを http://localhost:1420 で起動
npm run build          # tsc による型チェック + vite ビルド → dist/
npm run tauri dev      # アプリ全体 (Tauri が beforeDevCommand 経由で vite を起動)
npm run tauri build    # 本番バンドル (Windows では NSIS インストーラ)
```

Rust バックエンド (`src-tauri/` から実行):

```sh
cargo fmt --all -- --check                          # 整形チェック (CI と同じ)
cargo clippy --all-targets --locked -- -D warnings  # 型チェック込みの lint
cargo test                                          # ユニットテスト
cargo nextest run --all-targets                     # CI が使うテストランナー
cargo test --test mysql_integration                 # 統合テストファイルを単体で実行
cargo test mysql_roundtrip_when_env_set             # テスト名を指定して単体で実行
```

統合テストは対応する環境変数が設定されていない限りスキップされます (SQLite を除く):

```sh
NOOBDB_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb \
  cargo test --test mysql_integration
NOOBDB_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/testdb \
  cargo test --test postgres_integration
```

`tests/sqlite_integration.rs` は外部サーバを必要とせず、`std::env::temp_dir()`
に一時ファイルを作って**常に**実行されます。

CI は 2 つのワークフローに分かれています:

- `.github/workflows/ci.yml` — `main` への PR で起動。`dorny/paths-filter` で
  変更領域 (frontend / rust / workflow) を判定し、ジョブ単位の `if:` で出し分け
  します (ワークフロー丸ごとスキップにすると必須チェックが「待機中」で固まるため、
  ジョブを skip させる方式)。frontend ジョブは `npm run build`、rust ジョブは
  Linux 上で MySQL 8 サービスコンテナに対し `cargo clippy --all-targets --locked
  -- -D warnings` と `cargo nextest run` を実行します (clippy が rustc ドライバ
  として型チェックを内包するので別途 `cargo check` は走らせません)。別ジョブで
  `cargo fmt --all -- --check` も走ります。
- `.github/workflows/release.yml` — `v*` タグまたは `workflow_dispatch` を
  トリガに、`windows-latest` 上で `tauri-action` 経由の NSIS バンドルを生成します。
  `main` への push でもキャッシュ温め目的でビルドが走ります。

Linux CI では Tauri 2 のシステムパッケージ (`libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libxdo-dev`,
`libayatana-appindicator3-dev`) が必要です。

### ビルド高速化

ローカルと CI の Rust ビルドを速くするための設定をいくつか入れています。

- `src-tauri/Cargo.toml` の `[profile.dev]` で `debug = "line-tables-only"` を
  指定し、dev ビルドの debuginfo を行テーブルのみに削減しています。リンク時間と
  生成物サイズが減り、バックトレースのファイル:行情報は維持されます。ツール導入
  不要で全環境に効きます。
- `src-tauri/.cargo/config.toml` が **Linux x86_64 ターゲットのリンカに
  `clang` + `mold`** を指定しています。インクリメンタルビルドではリンクが所要
  時間の大半を占めるため、効果が大きいです。**Linux で開発・テストする場合は
  `clang` と `mold` のインストールが必須**です (`sudo apt install clang mold`
  など)。未導入だと `cargo build` / `clippy` / `test` がリンカを見つけられず
  失敗します。用意できない場合は同ファイルの `-fuse-ld=mold` を `-fuse-ld=lld`
  に変えるか、`[target.*]` ブロックをコメントアウトしてください。この設定は
  Linux x86_64 ターゲット限定で、Windows のリリースビルドや macOS には影響
  しません。
- 同ファイルに **sccache** (`[build] rustc-wrapper`) の設定をコメントアウト
  状態で同梱しています。プロジェクト/ブランチを跨いでコンパイル成果物を再利用
  したい場合は `cargo install sccache` してから該当行を有効化してください。
  クリーンビルドや `Cargo.lock` 変更時のビルドに効きます (リンク時間は短縮
  されないので mold と併用すると効果的)。
- CI (`ci.yml` の rust ジョブ) では上記 config に合わせて `clang` と `mold` を
  apt で導入済みで、`cargo nextest` のテストバイナリ群のリンクが mold で高速化
  されます。

JS のリンタやテストランナーは設定されていません。フロントエンドは `tsc`
(`npm run build` 経由) でのみ型チェックされます。`tsconfig.json` では `strict`、
`noUnusedLocals`、`noUnusedParameters` が有効になっているため、未使用の import や
パラメータがあるとビルドが失敗します。

## アーキテクチャ

noobDB は MySQL / PostgreSQL / SQLite に対応した軽量デスクトップ DB クライアントで、
SSH トンネルをファーストクラスでサポートします。Rust バックエンド (`rust-version`
1.77、edition 2021) は `sqlx` 0.9 (`tls-rustls`)、`russh` 0.60、`keyring` 3 などに
依存しています。

### 2 プロセス構成

- **フロントエンド** (`src/`): React 19 + TypeScript + Vite。UI の状態はすべて
  ここで保持しますが、セッションやプロファイルに関してはバックエンドの状態が
  正となります。UI から Rust への通信は `invoke(...)` のみ — `src/api/tauri.ts`
  が Tauri コマンド全体への型付けされた単一のラッパーです。JS 側の引数名は
  camelCase の規約 (例: `sessionId`) で、Tauri が自動的に Rust 側の `snake_case`
  に変換します。ストリーミングコマンドの結果は `invoke` の戻り値ではなくイベント
  (`listen`) で受け取ります — `tauri.ts` の `listenQueryStream` /
  `listenPreviewStream` / `listenImportStream` を参照。
- **バックエンド** (`src-tauri/src/`): Tauri 2 + Tokio。`lib.rs::run()` で IPC
  ハンドラを登録し、`AppState` を Tauri 管理ステートとしてインストールします。
  `tracing` でログを出力し、`main.rs` は薄いシムで `noobdb_lib::run()` を呼ぶだけです。

### ドライバのディスパッチ: `enum Connection`

DB レイヤは意図的に手書きの enum で実装されており、トレイトオブジェクトではありません。
`src-tauri/src/db/mod.rs` の `db::Connection` は `MySql` / `Postgres` / `Sqlite` の
3 バリアントを持ち、各操作 (`execute`, `preview_execute_with_limit`, `execute_stream`,
`import_rows`, `execute_transaction`, `databases`, `tables`, `columns`,
`schema_overview`, `close`, `driver_kind`) でバリアントに対してマッチします。**新しい
データベースを追加する場合は、`DriverKind` にバリアントを追加し、同じメソッド表面を
公開する `db/<name>.rs` モジュールを追加し、`db/mod.rs` の各 `match` アームを拡張します。**
SSH やセッション層には触らないでください — それらはドライバに依存しません。

`db::types::{Value, Column, QueryResult, TableColumnInfo, TableSchema,
PreviewResult, StreamBatch}` がドライバ横断のワイヤフォーマットです。`Value` は
`#[serde(untagged)]` なので、JSON では直接プリミティブとして見えます。BLOB は
JSON で安全に扱えるよう 16 進エンコードした文字列 (`Value::Bytes`) になります。
各ドライバの `decode_cell` 系では型に応じた明示的なデコードを行っています — カラム型を
追加する際は「型付きで試して失敗したら String にフォールバック」というパターンに
従ってください。

クエリ判定 (結果セットを返す SELECT 系か、`rows_affected` を返す書き込み系か) は
ドライバごとに SQL の先頭キーワードを見て行います。MySQL の `is_query_shape`
(`db/mysql.rs`) は `select`/`show`/`describe`/`desc`/`explain`/`call` に加えて、
`with` で始まる文は CTE 本体が DML かどうか (`with_cte_is_mutation`) を判定します
(データ変更 CTE は execute 経路、純粋な `WITH ... SELECT` は fetch 経路)。`CALL` は
結果セットを返しうるので fetch 経路を通します。判定前にコメントと文字列リテラルは
マスクされます。

SQLite はファイルバックドライバで、`DbConnectOptions.file_path` を使い、
host/port/user/password と SSH トンネルを持ちません (`commands::connection::
build_options` が SQLite を最初に短絡処理します)。

### 読み取り専用ガードと自動 LIMIT

`db/mod.rs` の `is_read_only_sql` は、読み取り専用プロファイルで許可してよい文かを
判定する**ベストエフォートの安全網** (パーサではない) です。許可リストは `SELECT` /
`SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`。コメントと文字列リテラルをマスク
したうえで、隠れた 2 文目 (`SELECT 1; DELETE ...`)、書き込み/DDL キーワード、データ
変更 CTE、`SELECT ... INTO`、ロック付き SELECT (`FOR UPDATE` 等) を弾きます。
`commands::query` の各エントリポイントは `ensure_allowed_for_session` でこのガードを
通します。

`apply_auto_limit` は、自前で行数を制限していない素の `SELECT` / `WITH ... SELECT` に
自動で `LIMIT n` を付与します。判定は保守的で、迷ったら `None` (ユーザの SQL をそのまま
実行) を返します。単一行集計 (`COUNT(*)` 等) や既存の `LIMIT`/`OFFSET`、ロック句がある
場合は付与しません。`db/mod.rs` の単体テストがこれら 2 関数の挙動を広くカバーしています。

### ストリーミングクエリ実行とキャンセル

エディタからのクエリは `run_query_stream` (`commands/query.rs`) で実行され、結果は
イベント (`query-stream:columns` / `:rows` / `:done` / `:error`) として段階的に
フロントへ送られます。`run_query_stream` は Tokio タスクを spawn し、その
`AbortHandle` を `AppState.streams` にクライアント提供の `stream_id` で登録します。
`cancel_stream` がそのハンドルを abort し、ストリーミング future を drop することで
プールへ接続が返ります。`query_timeout_secs` が正のときは `tokio::time::timeout` で
実行全体をレースし、超過時は `AppError::Timeout` を返します。

「ドライラン」プレビュー (`preview_query_stream`) はトランザクション内で SQL を実行
してロールバックし、対象テーブルの before/after スナップショット (PK でペアリング) を
`preview-stream:*` イベントで返します。CSV インポート (`import_csv`) とインラインセル
編集 Apply (`run_query_transaction`) も同じストリーム/トランザクション方式
(all-or-nothing) を踏襲します。新しいストリーミングコマンドを足すときは、この
イベント命名・`register_stream`/`forget_stream`・`stream_id` フィルタの 3 点セットに
合わせてください。

### SSH トンネルとセッションのライフタイム

`SshTunnel` (`ssh/tunnel.rs`) は OS が割り当てるポートでローカル TCP リスナを開き、
`russh` で SSH サーバへ接続し、認証し、インバウンド接続ごとに `direct-tcpip`
チャネルを開いて双方向にバイト列をパイプする accept ループを spawn します。認証方式は
`SshAuthMethod` の 3 種 — `Key` (秘密鍵 + 任意のパスフレーズ)、`Agent` (ssh-agent に
署名を委譲)、`Password` (パスワード認証) — で、`ssh/auth.rs` が振り分けます。セッションと
accept タスクの `JoinHandle` は構造体が所有しています。**`impl Drop` がタスクを abort し、
`Arc<russh::client::Handle>` の drop によって SSH セッションがクローズします。**

接続が SSH を使う場合、`commands::connection::build_options` はまずトンネルを開き、
その後 `127.0.0.1:<tunnel.local_port>` を指す `DbConnectOptions` を構築します。
`SshTunnel` は `Session._tunnel: Option<SshTunnel>` として保持され、DB 接続と
ぴったり同じ期間生存します。**接続より先にトンネルを drop してはいけません —
そうしないと sqlx は存在しない経路に再接続してしまいます。** `disconnect` は
マップから `Arc<Session>` を取り除き、最後の参照が drop されたタイミングで
`conn.close()` とトンネルの `Drop` の両方がトリガーされます。

ホスト鍵検証は `ssh/handler.rs::ClientHandler::check_server_key` における
**初回信頼方式 (TOFU)** です。known_hosts ファイルは `<data_dir>/known_hosts` で、
1 行 1 エントリの `host:port fingerprint` 形式です。不一致の場合は
`russh::Error::UnknownKey` を返して接続を中断します。復旧するには該当行を手動で
削除します。

### セッション

`AppState` (`state.rs`) は `RwLock<HashMap<SessionId, Arc<Session>>>` と、進行中の
ストリームタスク用の `RwLock<HashMap<StreamId, AbortHandle>>` を保持します。`Session`
は `conn`・`profile_id`・`connect_options` (`mysqldump` など外部クライアント再構築用)・
`read_only` / `skip_history` フラグ・`_tunnel` を持ちます。セッション ID は独自
アルファベット (`0`/`o`/`l`/`1` のような紛らわしい文字を含まない) から生成される、
8 文字の base32 風スラッグです。これらは keyring のターゲットプレフィックスとしても
使われるため、クロスプラットフォーム上で安全であるようアルファベットの選定が重要です。
セッションは常に `state.get(&id).await.ok_or(AppError::SessionNotFound(id))` で
参照してください。パターンは `commands::query::run_query` を参照し、セッションを扱う
新しいコマンドでも同じ方式を踏襲してください。

### プロファイルと秘密情報 — 厳密な分離

- `profiles.json` (`directories::ProjectDirs` の data_dir — Windows では
  `%APPDATA%/noobDB`) には**秘密でない情報**をすべて保存します: 名前、ドライバ、
  ホスト、ポート、ユーザ、データベース、SSH ホスト / ポート / ユーザ / 認証方式 /
  鍵パス、`group`・`color`・`is_production`・`read_only`・`skip_history`、SQLite の
  `file_path` など。`profiles/store.rs` は load/save-all と upsert/delete の API を
  提供します。
- OS の keyring (`keyring` クレート) には**秘密情報のみ**を保存します:
  `<profile_id>/db_password`・`<profile_id>/ssh_passphrase`・`<profile_id>/ssh_password`
  の 3 種を、サービス名 `noobDB` のもとに格納します。詳細は `profiles/secrets.rs`
  を参照してください。
- `save_profile` は秘密情報を `Option<String>` として受け取り、空文字列に意味を
  持たせます: `None` は変更なし、`Some("")` は keyring から削除、`Some(v)` は値を設定。
- `delete_profile` は孤立した資格情報を残さないよう、最初に `secrets::delete_all`
  を呼びます。
- **秘密情報を `profiles.json` に入れてはいけません**。また、ログにも出力しないで
  ください (`commands/connection.rs` の `log_attempt` はエンドポイントのメタ情報
  のみを記録します)。`password` / `passphrase` が空の接続要求は、`profile_id` をキー
  にした keyring の参照にフォールバックします (`resolve_password` /
  `resolve_passphrase` / `resolve_ssh_password` を参照)。

### クエリ履歴

`history/store.rs` は data_dir 内の `history.sqlite` に SQLite (`sqlx`) で履歴を
記録します。プールは初回利用時に遅延オープンされ、`query_history` テーブルとインデックス
を `CREATE TABLE IF NOT EXISTS` で用意するため、新規インストールでもマイグレーション
手順は不要です。記録はストリーミング実行パスと書き込みパス (`run_query_transaction`・
`import_csv`) のみが行い、ページングや編集用の内部クエリは履歴を汚しません。記録は
ベストエフォートで、失敗してもログに残すだけで呼び出し元には伝播しません。`skip_history`
フラグが立ったセッションは一切記録しません。検索は SQL 本文への大小無視部分一致で、
LIKE ワイルドカードはエスケープされます。

### スニペット

`snippets/store.rs` は保存済み SQL を JSON ファイルに永続化します。`Snippet` は
`folder`・`tags`・対象 `driver` (任意)・`scope` (`SnippetScope`: `Any` / `Profile` /
`Group`) を持ち、scope で「どの接続のときに表示するか」を絞り込めます。プロファイルと
同じ 8 文字スラッグを ID に使います。

### エクスポート / ダンプ / インポート

- `commands/export.rs`: 結果グリッドの内容を CSV / JSON へ書き出します
  (`export_query_result`)。CSV は RFC4180 風のクオート、BLOB は `0x...` で出力。
- `commands/dump.rs`: `mysqldump` を呼ぶ DB ダンプ (MySQL 専用)。資格情報は
  プロセス引数や環境変数に出さないよう、一時オプションファイル (unix では mode 0600)
  経由で渡し、終了後に削除します。`mysqldump` が PATH にない場合は分かりやすい
  エラーを返します。
- `commands/import.rs`: CSV を `import_rows` でテーブルへ一括投入します
  (`encoding_rs` でエンコーディング指定可、NULL トークン・列マッピング対応)。読み取り
  専用セッションでは拒否されます。進捗は `csv-import:*` イベントで通知します。

### IPC 表面

すべての `#[tauri::command]` は `lib.rs::run()` 内の `invoke_handler!` マクロで
登録されます。現在のコマンド群: 接続 (`test_connection` / `connect` / `disconnect`)、
クエリ (`run_query` / `run_query_transaction` / `run_query_stream` /
`preview_query_stream` / `cancel_stream`)、スキーマ (`list_databases` /
`list_tables` / `describe_table` / `schema_overview`)、プロファイル
(`list_profiles` / `save_profile` / `delete_profile`)、スニペット
(`list_snippets` / `save_snippet` / `delete_snippet`)、履歴 (`list_history` /
`clear_history`)、エクスポート/ダンプ/インポート (`export_query_result` /
`dump_database` / `parse_csv_preview` / `import_csv`)。完全なリストは
`src/api/tauri.ts` の `api` オブジェクトにミラーされています。**コマンドを追加する
ときは: Rust ハンドラを追加し、`lib.rs` で登録し、`tauri.ts` に型付けされたラッパー
(とストリーミングなら対応する `listen*` ヘルパー) を追加します — これらの間でズレが
発生するとフロントエンドが暗黙のうちに壊れます。** エラーは `AppError` として上に
伝搬し、その `Display` 文字列としてシリアライズされます (`error.rs::Serialize` を
参照)。フロントエンドは reject された Promise の中で `string` として受け取ります。

### テスト専用 API

`lib.rs` は `pub mod __test_api` (`#[doc(hidden)]`) を公開しており、
`src-tauri/tests/` 配下の統合テストが Tauri を経由せずに `db::Connection` の
経路を駆動できるようにしています。`connect`・`parse_mysql_url`・
`parse_postgres_url`・`sqlite_options`・`mysql_exec_text` などを提供します。新しい
テスト用エントリポイントが必要な場合は、内部モジュールを公開するのではなく、
ここに追加してください。

### Tauri capabilities

`src-tauri/capabilities/default.json` は意図的に最小限です: ウィンドウ / app /
イベントのデフォルトに加え、`dialog:allow-open` / `dialog:allow-save` のみ。
具体的な必要性がない限り、権限を追加しないでください — フロントエンドはバックエンドの
コマンドを呼び出すべきで、シェルや fs の API を直接叩くべきではありません。

### フロントエンド構成 (`src/`)

- `App.tsx` — 全体のシェル。タブ (table / query / explain)、接続状態、ストリーミング
  購読、インラインセル編集 (`components/cellEdit.ts`)、テーマを束ねるルート。
- `api/tauri.ts` — 全 IPC の型付きラッパーとイベント購読ヘルパー (上述)。
- `components/` — `ConnectionList`/`ConnectionForm` (接続)、`QueryEditor`
  (CodeMirror 6 + スキーマ補完)、`QueryBuilder`、`ResultGrid`/`PreviewGrid`
  (TanStack Table)、`TabBar`、`HistoryList`、`SnippetList`/`SnippetForm`、
  `ExportModal`/`DumpModal`/`ImportModal`、`ExplainViewer`、`SettingsView`、
  `HelpView`、`DangerousQueryDialog`、`CellValueViewer` など。
- `settings.ts` — `useSyncExternalStore` ベースの設定ストア (シンタックスカラー、
  自動 LIMIT、本番接続確認、危険クエリ確認、タブ復元モード、クエリタイムアウト等)。
- `dangerousSql.ts` — WHERE なし UPDATE/DELETE・DROP・TRUNCATE を検出する
  フロント側の安全網 (バックエンド `is_read_only_sql` と同じくリテラル/コメントを
  マスクするベストエフォート判定)。`DangerousQueryDialog` の確認に使われます。
- `i18n.ts` — 日本語/英語の文字列テーブルと `useT` フック。
- `tabPersistence.ts` — プロファイルごとの開きタブを localStorage に保存/復元。
- `errorHints.ts` — DB エラー文字列を人間向けのヒントに対応付け。
