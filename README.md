# noobDB

Rust で書かれた軽量なデスクトップ DB クライアントで、SSH トンネルをファーストクラスでサポートしています。[Tauri 2](https://tauri.app/) と React で構築されており、Windows をメインターゲットにしています (開発・テストは Linux でも可能)。

## 機能

### 接続

- MySQL / PostgreSQL / SQLite 接続 (`sqlx` + `rustls`)
- ローカルポートフォワーディングによる **SSH トンネル** (`russh`) — MySQL / PostgreSQL
  - 秘密鍵認証 (パスフレーズ対応) / **ssh-agent** / **パスワード認証** の 3 方式
  - 初回信頼方式 (TOFU) の known_hosts ファイル (`%APPDATA%/noobDB/known_hosts`)
- 接続プロファイルは `%APPDATA%/noobDB/profiles.json` に保存 (グループ・色・本番フラグなど)
- DB のパスワード・SSH 鍵のパスフレーズ・SSH パスワードは OS の資格情報ストアに保存
  (`keyring` クレート経由。Windows 資格情報マネージャー等)
- プロファイルのインポート / エクスポート (ID 衝突解決つき)
- 複数接続の同時利用とタブ単位のプロファイル退避 / 復元

### クエリ

- SQL エディタ (CodeMirror 6) — スキーマ補完・`.sql` / `.txt` ドラッグ&ドロップ読み込み
- 結果グリッド (TanStack Table) — スクロール / ページング表示、リッチセル描画、条件付き書式
- **ストリーミング実行** とキャンセル、クエリタイムアウト
- インラインセル編集 (pending → Apply のトランザクション適用)
- **明示的トランザクション** (begin / 複数往復 / commit・rollback)
- 複数文スクリプトの**バッチ実行**
- `{{name}}` プレースホルダによる**パラメータ化クエリ**
- クエリビルダ、クエリ履歴 (エディタからの ↑/↓ ナビ)、SQL スニペット (フォルダ・タグ・スコープ)
- コマンドパレット (Cmd/Ctrl+K)、スキーマ全体のオブジェクト検索

### 安全網

- **読み取り専用ガード** — 読み取り専用プロファイルで書き込み/DDL をバックエンドで強制拒否
- **自動 LIMIT** — 素の `SELECT` に保守的に `LIMIT` を付与
- **危険クエリ検出** — WHERE なし UPDATE/DELETE・DROP・TRUNCATE を確認ダイアログで警告
- **ドライランプレビュー** — トランザクション内実行 → ロールバックで before/after を表示
- 本番接続の確認・書き込み承認 (UX ガード)

### スキーマと運用

- スキーマブラウザ: データベース / テーブル / カラム / インデックス / 外部キー
  - PostgreSQL では UI の「データベース」階層にスキーマ (例: `public`) が表示されます
  - SQLite では「データベース」階層は `main` 固定で、ファイル 1 つ = 1 DB として扱います
- ビュー・ルーチン・トリガーの列挙と DDL 取得、概算行数 (統計ベース)
- **ER 図** (`@xyflow/react` + dagre)、結果の**グラフ化** (SVG 描画)
- CREATE TABLE ウィザード、行追加 / 行インスペクタ、テーブル名変更・TRUNCATE / DROP
- **スキーマ・データの比較と同期** — 2 接続間の差分を計算し同期 SQL を生成・適用
- **プロセス管理** — MySQL `PROCESSLIST` / PostgreSQL `pg_stat_activity` の監視と KILL

### 入出力

- 結果の CSV / JSON エクスポート (大きな結果セットへのストリーミング書き出し対応)
- `mysqldump` による DB ダンプ (MySQL)
- CSV インポート (エンコーディング指定・NULL トークン・列マッピング)

### その他

- 日本語 / 英語の UI (i18n)
- テーマプリセット (default / dracula)、アクセント色・フォント・UI 密度などの設定
- カスタムウィンドウクローム、キーボードショートカット (チートシートつき)
- アプリ内ヘルプとファイルバックドのログビューア

内部のドライバ層は `enum Connection` で構成されており、ディスパッチは
`src-tauri/src/db/mod.rs` で行われます。新しいドライバを追加する場合は、バリアントと
新しいモジュールを追加するだけでよく、SSH やセッション層に手を入れる必要はありません。

## プロジェクト構成

```
src/                   React + TypeScript のフロントエンド
  api/                 型付き IPC ラッパー (tauri.ts) と zod スキーマ
  components/          接続・クエリ・比較・各種モーダルなどの UI
  motion.ts            共有モーションプリセット (duration / easing / spring / variants)
  settings.ts          設定ストア / i18n.ts  日英の文字列テーブル
src-tauri/             Tauri 2 の Rust バックエンド
  src/
    db/                ドライバ enum と各 DB 実装 (mysql / postgres / sqlite)
                       + diff / data_diff / sync の純粋計算層
    ssh/               russh ベースのトンネル (TOFU ホスト鍵)
    profiles/          profiles.json と keyring 用ヘルパー
    history/           history.sqlite へのクエリ履歴記録
    snippets/          SQL スニペットの永続化
    commands/          #[tauri::command] による IPC エントリポイント
    state.rs           AppState (セッション / 進行中ストリーム)
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
Linux x86_64 でのビルドには `clang` と `mold` が必要です (リンカ設定。未導入の場合は
`src-tauri/.cargo/config.toml` の該当ブロックを調整してください)。

```sh
pnpm install
pnpm tauri dev
```

主なフロントエンドコマンド:

```sh
pnpm dev               # vite 開発サーバ (http://localhost:1420)
pnpm run build         # 型チェック (tsc) + vite ビルド
pnpm test              # Vitest ユニットテスト (jsdom)
pnpm test:browser      # Vitest ブラウザモード (Playwright + Chromium)
pnpm run knip          # 未使用エクスポート / 依存 / 到達不能コード検出
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
一時ファイルに対して常に実行されます。SSH トンネルの統合テスト
(`tests/ssh_integration.rs`) は `NOOBDB_TEST_SSH_URL` が設定されているときだけ実走します
(`scripts/ci-setup-sshd.sh` でローカル用 sshd を立てられます)。

フロントエンドのユニットテスト (Vitest) はリポジトリのルートから `pnpm test` で実行します。

## セキュリティに関する注意

- known_hosts ファイルは初回接続時に作成されます (TOFU)。サーバ鍵が後から変更された
  場合、接続は `russh::Error::UnknownKey` で拒否されます。再度信頼するには
  該当エントリを削除してください。
- 資格情報は OS のキーリングに保存され、`profiles.json` には保存されません。
- 読み取り専用プロファイルは**バックエンドで強制**されますが、本番接続確認・書き込み承認は
  誤操作防止のための **UI レベルの安全網**です。確実に書き込みを禁止するには読み取り専用
  プロファイルまたは DB 側の権限設定を併用してください。
- Tauri の capabilities セットは意図的に最小限にしてあります。詳細は
  `src-tauri/capabilities/default.json` を参照してください。

## ロードマップ

実装済みの主な項目: SSH パスワード認証 / ssh-agent、クエリ履歴、複数の結果タブ、
CSV / JSON エクスポート、CSV インポート、スキーマ・データ比較と同期、プロセス管理、
ER 図・グラフ化、コマンドパレット、パラメータ化クエリ。

今後の検討項目は GitHub の Issue / Epic を参照してください。
