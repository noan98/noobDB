# tableX

Rust で書かれた軽量なデスクトップ MySQL クライアントで、SSH トンネルをファーストクラスでサポートしています。[Tauri 2](https://tauri.app/) と React で構築されており、Windows をターゲットにしています。

## 機能 (初期版)

- MySQL 接続 (`sqlx` + `rustls`)
- ローカルポートフォワーディングによる **SSH トンネル** (`russh`)
  - 秘密鍵認証 (パスフレーズ対応)
  - 初回信頼方式 (TOFU) の known_hosts ファイル (`%APPDATA%/tableX/known_hosts`)
- 接続プロファイルは `%APPDATA%/tableX/profiles.json` に保存
- DB のパスワードと SSH 鍵のパスフレーズは OS の資格情報ストアに保存
  (`keyring` クレート経由で Windows 資格情報マネージャーを利用)
- SQL エディタ (CodeMirror 6) と結果グリッド (TanStack Table)
- スキーマブラウザ: データベース / テーブル / カラム

内部のドライバ層は `enum Connection` で構成されており、ディスパッチは
`src-tauri/src/db/mod.rs` で行われます。後から PostgreSQL や SQLite を追加する場合は、
バリアントと新しいモジュールを追加するだけでよく、SSH やセッション層に手を入れる必要はありません。

## プロジェクト構成

```
src/                   React + TypeScript のフロントエンド
src-tauri/             Tauri 2 の Rust バックエンド
  src/
    db/                ドライバ enum と MySQL 実装
    ssh/               russh ベースのトンネル (TOFU ホスト鍵)
    profiles/          profiles.json と keyring 用ヘルパー
    commands/          #[tauri::command] による IPC エントリポイント
    state.rs           AppState (セッション)
```

## 開発

前提条件: Rust stable (>= 1.77)、Node.js >= 20、npm。Linux では
[Tauri 2 のシステム要件](https://tauri.app/start/prerequisites/) をインストールしてください。

```sh
npm install
npm run tauri dev
```

## ビルド (Windows)

Windows インストーラは GitHub Actions (`.github/workflows/release.yml`) により、
`windows-latest` ランナー上で [`tauri-action`](https://github.com/tauri-apps/tauri-action)
を使って生成されます。`v0.1.0` のようなタグをプッシュするか、`workflow_dispatch` を
手動で起動してください。

Windows でローカルにビルドする場合:

```pwsh
npm install
npm run tauri build
```

成果物は `src-tauri/target/release/bundle/nsis/` 配下の NSIS インストーラです。

## テスト

```sh
cd src-tauri
cargo test
```

実際の MySQL 経路を検証するには `TABLEX_TEST_MYSQL_URL` を設定します:

```sh
TABLEX_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb \
  cargo test --test mysql_integration
```

## セキュリティに関する注意

- known_hosts ファイルは初回接続時に作成されます (TOFU)。サーバ鍵が後から変更された
  場合、接続は `russh::Error::UnknownKey` で拒否されます。再度信頼するには
  該当エントリを削除してください。
- 資格情報は OS のキーリングに保存され、`profiles.json` には保存されません。
- Tauri の capabilities セットは意図的に最小限にしてあります。詳細は
  `src-tauri/capabilities/default.json` を参照してください。

## ロードマップ

- PostgreSQL / SQLite ドライバ
- SSH パスワード認証 + ssh-agent
- クエリ履歴、複数の結果タブ
- CSV / JSON エクスポート
