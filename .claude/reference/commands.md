# コマンドリファレンス

開発・テスト・ミューテーションテスト・統合テストの実行方法。

フロントエンド (リポジトリのルートから実行):

パッケージマネージャは **pnpm** (>= 10) を使います。Node 同梱の `corepack enable`
で有効化でき、バージョンは `package.json` の `packageManager` フィールドで固定して
います。

```sh
pnpm install
pnpm dev               # vite 開発サーバを http://localhost:1420 で起動
pnpm run build         # tsc による型チェック + vite ビルド → dist/
pnpm test              # Vitest によるフロントエンドロジックのユニットテスト (jsdom)
pnpm test:browser      # Vitest ブラウザモード (Playwright + Chromium) の画面テスト
pnpm test:e2e          # tauri-driver + WebDriverIO による実 webview E2E (Phase 3 PoC)
pnpm run knip          # 未使用エクスポート/依存/到達不能コード検出
pnpm run bundle-size   # dist の JS/CSS gzip 後サイズ計測 (可視化のみ)
pnpm tauri dev         # アプリ全体 (Tauri が beforeDevCommand 経由で vite を起動)
pnpm tauri build       # 本番バンドル (Windows では NSIS インストーラ)
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

ミューテーションテスト (#528) — `cargo install cargo-mutants` でインストール後:

```sh
# 安全網モジュール限定で実行 (推奨。フル実行は数十分かかる)
cargo mutants --file src/db/mod.rs --file src/db/mysql.rs \
  --file src/db/sync.rs --file src/db/data_diff.rs

# 変異候補の一覧のみ確認 (テストを走らせない)
cargo mutants --list --file src/db/mod.rs --file src/db/mysql.rs

# 既存ビルドを流用して高速実行 (--in-place)
cargo mutants --file src/db/mod.rs --file src/db/mysql.rs --in-place
```

**運用方針**: スコープは安全網ロジックを持つ 4 ファイルに限定 —
`src/db/mod.rs` (`is_read_only_sql` / `apply_auto_limit` / `has_stacked_statements`)、
`src/db/mysql.rs` (`is_query_shape` / `with_cte_is_mutation`)、`src/db/sync.rs`
(`quote_ident`)、`src/db/data_diff.rs` (`sql_literal`)。後者 2 つは SQL
インジェクション隣接の引用/エスケープで、共有ゴールデン (#880) で固定した後に
その有効性を可視化する目的で追加しました。CI トリガは
`.github/workflows/mutants.yml` の `workflow_dispatch` (手動) のみで、PR では
走らせない。**fail させない** (可視化のみ) — バンドルサイズ (#443) ・カバレッジ
(#482) と同じ漸進方針。生き残り変異 (MISSED) が出たら `db::tests` に境界ケースを
追記して潰す。設定は `src-tauri/.cargo/mutants.toml`、生成物 `mutants.out/` は
`.gitignore` 済み。

統合テストは対応する環境変数が設定されていない限りスキップされます (SQLite を除く):

```sh
NOOBDB_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb \
  cargo test --test mysql_integration
NOOBDB_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/testdb \
  cargo test --test postgres_integration
NOOBDB_TEST_MSSQL_URL=mssql://sa:YourStrong!Passw0rd@127.0.0.1:1433/testdb \
  cargo test --test mssql_integration
```

SSH トンネル統合テスト (`tests/ssh_integration.rs`、#331) は `NOOBDB_TEST_SSH_URL`
(`ssh://user:password@host:port`) が設定されているときだけ実走します。鍵認証テストは
追加で `NOOBDB_TEST_SSH_KEY` (秘密鍵パス) を要し、未設定ならその 1 件のみスキップ
します。ローカルでは `scripts/ci-setup-sshd.sh` が apt の `openssh-server` で
127.0.0.1:2222 にテスト用 sshd を立て、両環境変数を出力します (CI ではこのスクリプトが
`$GITHUB_ENV` に追記)。トンネル越しの転送はテスト内の TCP エコーサーバへの
`direct-tcpip` フォワードで検証します (SQLite はファイルベースで TCP トンネルに
載らないため)。TOFU ホスト鍵検証の判定ロジックは `ssh/handler.rs` の単体テストが
known_hosts パスを制御して網羅済みです。

```sh
SSH_PORT=2222 bash scripts/ci-setup-sshd.sh   # sshd を起動し env を出力
NOOBDB_TEST_SSH_URL=ssh://sshtest:sshpw123@127.0.0.1:2222 \
NOOBDB_TEST_SSH_KEY=/tmp/noobdb-sshtest/client_key \
  cargo test --test ssh_integration
```

`tests/sqlite_integration.rs` は外部サーバを必要とせず、`std::env::temp_dir()`
に一時ファイルを作って**常に**実行されます。
