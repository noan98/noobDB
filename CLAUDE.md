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
cargo check --all-targets
cargo test                                   # ユニットテスト
cargo test --test mysql_integration          # 統合テストファイルを単体で実行
cargo test mysql_roundtrip_when_env_set      # テスト名を指定して単体で実行
```

統合テストは `NOOBDB_TEST_MYSQL_URL` が設定されていない限り何もしません:

```sh
NOOBDB_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb cargo test --test mysql_integration
```

CI (`.github/workflows/release.yml`) は Linux 上で MySQL 8 のサービスコンテナに
対して `cargo check --all-targets` と `cargo test` を実行し、`v*` タグもしくは
手動ディスパッチをトリガーに `tauri-action` 経由で Windows 用 NSIS バンドルを
生成します。Linux CI では Tauri 2 のシステムパッケージ
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`,
`libxdo-dev`, `libayatana-appindicator3-dev`) が必要です。

JS のリンタやテストランナーは設定されていません。フロントエンドは `tsc`
(`npm run build` 経由) でのみ型チェックされます。`tsconfig.json` では `strict`、
`noUnusedLocals`、`noUnusedParameters` が有効になっているため、未使用の import や
パラメータがあるとビルドが失敗します。

## アーキテクチャ

### 2 プロセス構成

- **フロントエンド** (`src/`): React 18 + TypeScript + Vite。UI の状態はすべて
  ここで保持しますが、セッションやプロファイルに関してはバックエンドの状態が
  正となります。UI から Rust への通信は `invoke(...)` のみ — `src/api/tauri.ts`
  が Tauri コマンド全体への型付けされた単一のラッパーです。JS 側の引数名は
  camelCase の規約 (例: `sessionId`) で、Tauri が自動的に Rust 側の `snake_case`
  に変換します。
- **バックエンド** (`src-tauri/src/`): Tauri 2 + Tokio。`lib.rs::run()` で IPC
  ハンドラを登録し、`AppState` を Tauri 管理ステートとしてインストールします。
  `main.rs` は薄いシムで、`noobdb_lib::run()` を呼ぶだけです。

### ドライバのディスパッチ: `enum Connection`

DB レイヤは意図的に手書きの enum で実装されており、トレイトオブジェクトではありません。
`src-tauri/src/db/mod.rs` の `db::Connection` は、各操作 (`execute`, `databases`,
`tables`, `columns`, `close`) でバリアントに対してマッチします。**新しいデータベース
(Postgres, SQLite) を追加する場合は、`DriverKind` にバリアントを追加し、同じメソッド
表面を公開する `db/<name>.rs` モジュールを追加し、`db/mod.rs` の各 `match` アームを
拡張します。** SSH やセッション層には触らないでください — それらはドライバに依存しません。

`db::types::{Value, Column, QueryResult, TableColumnInfo}` がドライバ横断のワイヤ
フォーマットです。`Value` は `#[serde(untagged)]` なので、JSON では直接プリミティブ
として見えます。BLOB は JSON で安全に扱えるよう 16 進エンコードした文字列
(`Value::Bytes`) になります。MySQL 実装の `mysql::decode_cell` では型に応じた明示的な
デコードを行っています — カラム型を追加する際は「型付きで試して失敗したら String に
フォールバック」というパターンに従ってください。

`MySqlConn::execute` は SQL の先頭
(`select`/`show`/`describe`/`desc`/`explain`/`with`) を見てクエリかエグゼキュートかを
判断します。マッチしないステートメントは `.execute()` を使い、`rows_affected` を返して
カラム / 行は空にします。

### SSH トンネルとセッションのライフタイム

`SshTunnel` (`ssh/tunnel.rs`) は OS が割り当てるポートでローカル TCP リスナを開き、
`russh` で SSH サーバへ接続し、公開鍵で認証し、インバウンド接続ごとに
`direct-tcpip` チャネルを開いて双方向にバイト列をパイプする accept ループを spawn
します。セッションと accept タスクの `JoinHandle` は構造体が所有しています。
**`impl Drop` がタスクを abort し、`Arc<russh::client::Handle>` の drop によって
SSH セッションがクローズします。**

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

`AppState` (`state.rs`) は `RwLock<HashMap<SessionId, Arc<Session>>>` を保持します。
セッション ID は独自アルファベット (`0`/`o`/`l`/`1` のような紛らわしい文字を含まない)
から生成される、8 文字程度の base32 風スラッグです。これらは keyring のターゲット
プレフィックスとしても使われるため、クロスプラットフォーム上で安全であるよう
アルファベットの選定が重要です。セッションは常に
`state.get(&id).await.ok_or(AppError::SessionNotFound(id))` で参照してください。
パターンは `commands::query::run_query` を参照し、セッションを扱う新しいコマンドでも
同じ方式を踏襲してください。

### プロファイルと秘密情報 — 厳密な分離

- `profiles.json` (`directories::ProjectDirs` の data_dir — Windows では
  `%APPDATA%/noobDB`) には**秘密でない情報**をすべて保存します: 名前、ホスト、
  ポート、ユーザ、データベース、SSH ホスト / ポート / ユーザ / 鍵パスなど。
  `profiles/store.rs` は load/save-all と upsert/delete の API を提供します。
- OS の keyring (`keyring` クレート) には**秘密情報のみ**を保存します: DB の
  パスワードと SSH 鍵のパスフレーズで、`<profile_id>/db_password` および
  `<profile_id>/ssh_passphrase` をキーに、サービス名 `noobDB` のもとに格納します。
  詳細は `profiles/secrets.rs` を参照してください。
- `save_profile` は `db_password` / `ssh_passphrase` を `Option<String>` として
  受け取り、空文字列に意味を持たせます: `None` は変更なし、`Some("")` は keyring
  から削除、`Some(v)` は値を設定。
- `delete_profile` は孤立した資格情報を残さないよう、最初に `secrets::delete_all`
  を呼びます。
- **秘密情報を `profiles.json` に入れてはいけません**。また、ログにも出力しないで
  ください。`password` / `passphrase` が空の接続要求は、`profile_id` をキーにした
  keyring の参照にフォールバックします (`commands/connection.rs` の
  `resolve_password` / `resolve_passphrase` を参照)。

### IPC 表面

すべての `#[tauri::command]` は `lib.rs::run()` 内の `invoke_handler!` マクロで
登録されます。完全なリストは `src/api/tauri.ts` の `api` オブジェクトにミラーされて
います。**コマンドを追加するときは: Rust ハンドラを追加し、`lib.rs` で登録し、
`tauri.ts` に型付けされたラッパーを追加します — これらの間でズレが発生すると
フロントエンドが暗黙のうちに壊れます。** エラーは `AppError` として上に伝搬し、
その `Display` 文字列としてシリアライズされます (`error.rs::Serialize` を参照)。
フロントエンドは reject された Promise の中で `string` として受け取ります。

### テスト専用 API

`lib.rs` は `pub mod __test_api` (`#[doc(hidden)]`) を公開しており、
`src-tauri/tests/` 配下の統合テストが Tauri を経由せずに `db::Connection` の
経路を駆動できるようにしています。新しいテスト用エントリポイントが必要な場合は、
内部モジュールを公開するのではなく、ここに追加してください。

### Tauri capabilities

`src-tauri/capabilities/default.json` は意図的に最小限です: ウィンドウ / app /
イベントのデフォルトに加え、`dialog:allow-open` / `dialog:allow-save` のみ。
具体的な必要性がない限り、権限を追加しないでください — フロントエンドはバックエンドの
コマンドを呼び出すべきで、シェルや fs の API を直接叩くべきではありません。
