# CLAUDE.md

このファイルは、本リポジトリのコードを扱う際に Claude Code (claude.ai/code) に
向けたガイダンスを提供します。**詳細は `.claude/rules/` と `.claude/reference/` に
分割してあります** — 下の「ドキュメント索引」から、作業に関係するファイルだけを
読んでください。

## 絶対に守るルール

### 言語 (例外なし)

- **ユーザへの応答はすべて日本語で行ってください。** 説明・質問・確認プロンプト・
  ツール実行前の説明・進捗報告・エラー説明・最終サマリーなど、チャットに出力する
  すべての文章を日本語で記述します (コード・コマンド・識別子など本来英語で書くべき
  ものは除く)。Claude Code on the web (クラウド実行環境) を含むすべての状況に適用。
- **PR のタイトル・本文・サマリー・テスト計画もすべて日本語で記述してください。**
- このルールは `.claude/settings.json` (`language` 設定 + `UserPromptSubmit`
  フック) で強制しています。設定を変更した場合は `/hooks` を一度開くか、
  セッションを再起動しないと反映されません。
- 詳細: `.claude/rules/language.md`

### Issue と PR

- 新規 Issue には**必ずコストとメリットのラベルを両方**付ける
  (`cost:Low|Mid|High` / `benefit:1`〜`benefit:5`)。
- 関連 Issue がある PR は**本文の独立行に `Closes #123`** を必ず入れる
  (タイトルの `(#123)` や本文中の `#123` 単独では close されない)。Epic は最後の
  子を解消する PR でのみ閉じる。
- 詳細: `.claude/rules/issues-and-prs.md`

### コードの不変条件

これらを破ると CI が落ちるか、実行時に静かに壊れます。

- **秘密情報 (パスワード / パスフレーズ) を `profiles.json` に書かない・ログに出さない。**
  秘密は OS keyring のみ。非秘密フィールド (ホスト・パス・TLS 証明書の**パス**など) は
  `profiles.json`。唯一の例外は `reveal_profile_secret` (#938)。
- **Tauri capabilities を増やさない。** フロントは fs / shell を直接叩かず、必ず
  Rust コマンド経由にする (`src-tauri/capabilities/default.json` は意図的に最小)。
- **`lib.rs::run()` の `.setup(...)` 内で `tokio::spawn` を使わない** —
  Tokio ランタイム外なので panic する。`tauri::async_runtime::spawn` を使う。
- **IPC は 3 点セットで揃える**: Rust ハンドラ追加 → `lib.rs` の
  `generate_handler!` に登録 → `src/api/tauri.ts` に型付きラッパー (+ ストリーミング
  なら `listen*` ヘルパー) を追加し、**UI から実際に呼ぶ**。ズレるとパリティテスト
  (`ipcCommandParity` / `apiReachabilityParity` / `commandRegistrationParity`) が落ちます。
- **本体 Rust コードの `unwrap()` / `expect()` / `panic!` は CI が fail させます。**
  やむを得ない場合は `#[allow(...)]` + 日本語の根拠コメントを必ず添える。
- **64bit 整数のデコードは `Value::from_*_lossless` を必ず経由する** — JS の安全整数
  を超えると丸められ、インラインセル編集が誤った行を書き換えます。
- **新しい DB ドライバを追加するときは** `DriverKind` にバリアントを追加し、
  `db/<name>.rs` で同じメソッド表面を実装し、`db/mod.rs` の**全 `match` アーム**を
  拡張する。SSH / セッション層には触らない (ドライバ非依存)。
- **安全網の強制レベルを混同しない**: `read_only` は**バックエンド強制**、
  `confirm_writes` / `is_production` は**UI レベルの誤操作防止のみ** (IPC を直接
  叩けば素通り)。
- **共有ゴールデンベクタ (`src/__tests__/fixtures/*.json`) を経由する判定ロジックを
  変えるときは、必ず JSON に境界ケースを追記する** — Rust とフロントの二重実装が
  ズレると片方のテストが落ちます。
- 詳細: `.claude/rules/code-conventions.md`

## よく使うコマンド

パッケージマネージャは **pnpm** (>= 10、`corepack enable`)。

```sh
pnpm dev               # vite 開発サーバ (http://localhost:1420)
pnpm run build         # tsc 型チェック + vite ビルド
pnpm test              # Vitest ユニットテスト (jsdom)
pnpm test:browser      # Vitest ブラウザモード (Playwright + Chromium)
pnpm run knip          # 未使用エクスポート/依存/到達不能コード検出
pnpm tauri dev         # アプリ全体を起動
```

```sh
# src-tauri/ から実行
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test
```

> **Linux で開発する場合は `clang` と `mold` が必須です**
> (`src-tauri/.cargo/config.toml` がリンカに指定しているため。未導入だと
> `cargo build` / `clippy` / `test` が失敗します)。Windows ビルドには `lld-link`
> (LLVM) が必要。

統合テストは環境変数ゲート方式で、未設定ならスキップされます (SQLite / DuckDB は
常時実走)。ミューテーションテスト・TLS/SSH 統合テストの手順を含む全コマンドは
`.claude/reference/commands.md` を参照。

## アーキテクチャ (要約)

noobDB は MySQL / PostgreSQL / SQLite / DuckDB / Microsoft SQL Server 対応の軽量
デスクトップ DB クライアントで、SSH トンネルをファーストクラスでサポートします。

- **フロントエンド** (`src/`): React 19 + TypeScript + Vite + Chakra UI。Rust への
  通信は `src/api/tauri.ts` の型付きラッパー (`invoke`) のみ。ストリーミング結果は
  戻り値ではなくイベント (`listen`) で受け取る。
- **バックエンド** (`src-tauri/src/`): Tauri 2 + Tokio。`lib.rs::run()` が IPC
  ハンドラを登録し `AppState` を管理ステートとして持つ。
- **DB レイヤ**: トレイトオブジェクトではなく手書きの `enum db::Connection` で
  ドライバをディスパッチ (`db/mod.rs`)。
- **秘密情報**: `profiles.json` (非秘密) と OS keyring (秘密) を厳密に分離。

## ドキュメント索引

作業内容に応じて、以下から**必要なものだけ**を読んでください。

### ルール (`.claude/rules/`)

| ファイル | 読むタイミング |
|---|---|
| `language.md` | 応答・PR の言語ポリシー全文 |
| `issues-and-prs.md` | Issue を作る / ラベルを付ける / PR を作るとき |
| `code-conventions.md` | Rust の unwrap lint、TS の tsc/Vitest/knip 運用 |

### リファレンス (`.claude/reference/`)

| ファイル | 読むタイミング |
|---|---|
| `commands.md` | テスト実行方法、ミューテーションテスト、統合テストの環境変数 |
| `ci.md` | CI が落ちた / ワークフローを変える / 必須チェック名・依存更新・ビルド高速化 |
| `testing.md` | ブラウザモードのテスト (#306) やビジュアル回帰、実 webview E2E (#529) |
| `architecture-overview.md` | 2 プロセス構成、`setup` フックの制約 |
| `db-drivers.md` | ドライバ追加/修正、`enum Connection`、MSSQL 固有事情、TLS、セッション初期化 SQL、型デコード |
| `sql-safety.md` | 読み取り専用ガード、自動 LIMIT、リテラルマスク、共有ゴールデンベクタ |
| `sessions-and-streaming.md` | ストリーミング実行/キャンセル、SSH トンネル (多段)、セッション管理、再接続 |
| `profiles-and-storage.md` | プロファイル/秘密情報、クエリ履歴、スニペット、ログ、ファイル読み書き |
| `data-io.md` | エクスポート / ダンプ / インポート、明示的トランザクション |
| `diff-sync-sandbox.md` | スキーマ・データ比較と同期、サンドボックス (壊せる砂場) |
| `admin-and-tools.md` | プロセス管理、ユーザ/権限管理、ローカル横断クエリ、アプリ内自動更新 |
| `ipc.md` | IPC コマンドの追加/変更、エラーの `kind`、`__test_api`、capabilities |
| `frontend.md` | UI コンポーネント、各フロントモジュールの責務と設計判断 |

### メンテナ向けのセットアップ (未完了だと機能しません)

- **自動更新の署名鍵**: `tauri.conf.json` の `plugins.updater.pubkey` は
  **プレースホルダ**。`pnpm tauri signer generate` で鍵ペアを作り、公開鍵で差し替え、
  秘密鍵を Secrets `TAURI_SIGNING_PRIVATE_KEY` に登録する
  (詳細: `.claude/reference/admin-and-tools.md`)。
- **ビジュアルベースライン更新**: Secrets `VISUAL_BASELINE_PAT` の登録を推奨
  (詳細: `.claude/reference/testing.md`)。
- **CodeRabbit レビュー起動**: PAT (`CODERABBIT_PAT`) が無い間は no-op
  (詳細: `.claude/reference/ci.md`)。
