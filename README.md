# noobDB

Rust で書かれた軽量なデスクトップ DB クライアントで、SSH トンネルをファーストクラスでサポートしています。[Tauri 2](https://tauri.app/) と React で構築されており、Windows をターゲットにしています。

## 機能 (初期版)

- MySQL / PostgreSQL / SQLite 接続 (`sqlx` + `rustls`)
- ローカルポートフォワーディングによる **SSH トンネル** (`russh`) — MySQL / PostgreSQL
  - 秘密鍵認証 (パスフレーズ対応)
  - 初回信頼方式 (TOFU) の known_hosts ファイル (`%APPDATA%/noobDB/known_hosts`)
- 接続プロファイルは `%APPDATA%/noobDB/profiles.json` に保存
- DB のパスワードと SSH 鍵のパスフレーズは OS の資格情報ストアに保存
  (`keyring` クレート経由で Windows 資格情報マネージャーを利用)
- SQL エディタ (CodeMirror 6) と結果グリッド (TanStack Table)
- スキーマブラウザ: データベース / テーブル / カラム
  - PostgreSQL では UI 上の「データベース」階層にスキーマ (例: `public`) が表示されます
  - SQLite では「データベース」階層は `main` 固定で、ファイル 1 つ = 1 DB として扱われます

内部のドライバ層は `enum Connection` で構成されており、ディスパッチは
`src-tauri/src/db/mod.rs` で行われます。新しいドライバを追加する場合は、バリアントと
新しいモジュールを追加するだけでよく、SSH やセッション層に手を入れる必要はありません。

## プロジェクト構成

```
src/                   React + TypeScript のフロントエンド
  motion.ts            共有モーションプリセット (duration / easing / spring / variants)
src-tauri/             Tauri 2 の Rust バックエンド
  src/
    db/                ドライバ enum と各 DB 実装 (mysql / postgres / sqlite)
    ssh/               russh ベースのトンネル (TOFU ホスト鍵)
    profiles/          profiles.json と keyring 用ヘルパー
    commands/          #[tauri::command] による IPC エントリポイント
    state.rs           AppState (セッション)
```

## モーション (アニメーション)

UI のアニメーションは [motion](https://motion.dev/) (旧 framer-motion) を使い、
共有プリセットを `src/motion.ts` に集約しています。各コンポーネントは duration /
easing / spring / variants をインラインで散らかさず、`durations` / `easings` /
`springs` / `transitions` / `variants` を参照します。値は CSS のモーショントークン
(`src/App.css` の `--ease` / `--ease-out` / `--dur-*`) と思想を揃えており、JS と
CSS のどちらで書いても動きの印象が一致します。

**`prefers-reduced-motion` 方針** — OS の「動きを減らす」設定への対応は 2 系統で
自動的に効くため、個々のアニメーションで分岐を書く必要はありません。

- **motion (JS):** ルートの `<MotionConfig reducedMotion="user">` (`src/main.tsx`)
  が `motion/react` ツリー全体へ伝播し、transition / spring を即時切替にします。
  新規アニメは通常どおり React ツリー内 (MotionConfig 配下) で書けば自動で抑制されます。
- **CSS:** `src/App.css` 末尾の `@media (prefers-reduced-motion: reduce)` が全要素の
  transition / animation を実質無効化します。

**「CSS のまま残す / Motion 化する」の境界** — 単純な hover / focus / active の色・影・
枠線などの transition (要素の出入りを伴わない 1 プロパティ補間) は CSS (`--dur-*` /
`--ease`) のまま残します。要素の出入り (`AnimatePresence`)、レイアウト遷移
(`layout` / `layoutId`)、複数プロパティの協調、spring など CSS だけでは煩雑になるものを
Motion 化します。

この境界は Epic で確定済みで、確定リストは `src/motion.ts` のヘッダコメントに
あります。要点:

- **CSS のまま残す:** `TitleBar` のウィンドウ操作ボタン、`ConnectionForm` などの
  フォーム入力の focus/hover、共通ボタン・タブ・ツリー行・コンテキストメニュー項目の
  hover/focus 配色とフォーカスリング、キャレット (▸) の回転、ステータスドットの
  色/影遷移や脈動・スピナー回転などの CSS アニメーション。
- **Motion 化する:** モーダル開閉、タブの追加/削除とアクティブインジケータ、トースト、
  ツリーの展開/折りたたみとリスト項目の出入り、コンテキストメニューの出現、空表示の
  fade-in、`Switch` のつまみ、アイコン/バッジのクロスフェード。

## 開発

前提条件: Rust stable (>= 1.77)、Node.js >= 20、pnpm (>= 10、`corepack enable`
で有効化できます)。Linux では
[Tauri 2 のシステム要件](https://tauri.app/start/prerequisites/) をインストールしてください。

```sh
pnpm install
pnpm tauri dev
```

## ビルド (Windows)

Windows インストーラは GitHub Actions (`.github/workflows/release.yml`) により、
`windows-latest` ランナー上で [`tauri-action`](https://github.com/tauri-apps/tauri-action)
を使って生成されます。`v0.1.0` のようなタグをプッシュするか、`workflow_dispatch` を
手動で起動してください。

Windows でローカルにビルドする場合:

```pwsh
pnpm install
pnpm tauri build
```

成果物は `src-tauri/target/release/bundle/nsis/` 配下の NSIS インストーラです。

## テスト

```sh
cd src-tauri
cargo test
```

実際の MySQL / PostgreSQL 経路を検証するには対応する環境変数を設定します:

```sh
NOOBDB_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb \
  cargo test --test mysql_integration

NOOBDB_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/testdb \
  cargo test --test postgres_integration
```

SQLite の統合テスト (`tests/sqlite_integration.rs`) は外部サーバを必要とせず、
一時ファイルに対して常に実行されます。

## セキュリティに関する注意

- known_hosts ファイルは初回接続時に作成されます (TOFU)。サーバ鍵が後から変更された
  場合、接続は `russh::Error::UnknownKey` で拒否されます。再度信頼するには
  該当エントリを削除してください。
- 資格情報は OS のキーリングに保存され、`profiles.json` には保存されません。
- Tauri の capabilities セットは意図的に最小限にしてあります。詳細は
  `src-tauri/capabilities/default.json` を参照してください。

## ロードマップ

- SSH パスワード認証 + ssh-agent
- クエリ履歴、複数の結果タブ
- CSV / JSON エクスポート
