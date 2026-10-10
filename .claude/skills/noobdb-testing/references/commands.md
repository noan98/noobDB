# コマンドと統合テストの環境変数

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
cargo nextest run --lib --test '*'                  # CI が使うテストランナー
cargo test --test external mysql_integration::      # 統合テストのファイル単位で実行 (下の注参照)
cargo test mysql_roundtrip_when_env_set             # テスト名を指定して単体で実行
```

> **統合テストは 4 本の実行ファイルに束ねてある** (`src-tauri/Cargo.toml` の `[[test]]`、
> `autotests = false`)。Tauri / sqlx / russh を含むテストバイナリのリンクをファイル数ぶん
> 繰り返すと、CI (特に Windows) で大きな固定コストになるため。個々のテストは従来どおり
> `src-tauri/tests/<名前>.rs` に置き、`tests/groups/{golden,integration,external}.rs` が
> `#[path]` で取り込む。**新しい `tests/*.rs` を足したら該当グループに `mod` を 1 行足す**
> (足し忘れるとそのテストは走らない)。ファイル単位で動かすときは
> `cargo test --test <golden|integration|external> <ファイル名>::`。`serde_schema_parity` だけは
> `#![recursion_limit]` の都合で単独の実行ファイル。プロセスを共有するため
> `cargo test` ではファイルをまたぐ共有状態 (環境変数・ユーザデータの JSON) に注意
> (nextest はテストごとにプロセスを分けるので影響しない)。

ミューテーションテスト (#528) — `cargo install cargo-mutants` でインストール後:

```sh
# 安全網関数限定で実行 (推奨。スコープは src-tauri/.cargo/mutants.toml が定める)
cargo mutants

# 変異候補の一覧のみ確認 (テストを走らせない)
cargo mutants --list

# 既存ビルドを流用して高速実行 (--in-place)
cargo mutants --in-place
```

**運用方針**: スコープは**ファイル単位ではなく安全網関数単位** (#1168)。単一ソースは
`src-tauri/.cargo/mutants.toml` の `examine_globs` (対象ファイル) + `examine_re` (変異名の
関数名フィルタ) で、`mutants.yml` もフラグ無しで読むだけ。対象は `db/mod.rs`
(`is_read_only_sql*` / `apply_auto_limit*` / `has_stacked_statements*`)、
`db/{mysql,postgres,sqlite}.rs` の `is_query_shape`、`mysql.rs` の `with_cte_is_mutation`、
`mysql.rs` / `sqlite.rs` / `sync.rs` の `quote_ident`、`data_diff.rs` の `sql_literal`、
`lib.rs` の `__test_api` ディスパッチ。`quote_ident` / `sql_literal` は SQL
インジェクション隣接の引用/エスケープで、共有ゴールデン (#880) で固定した後に
その有効性を可視化する目的で含めています。関数を足す・外すときは `mutants.toml` だけを
直し、`cargo mutants --list` で確認する。cargo-mutants は構造体フィールド削除
(`delete field ...`) の変異に `--re` を適用しないため、`examine_globs` でもファイルを
絞っている。CI トリガは
`.github/workflows/mutants.yml` の `workflow_dispatch` (手動) のみで、PR では
走らせない。**fail させない** (可視化のみ) — バンドルサイズ (#443) ・カバレッジ
(#482) と同じ漸進方針。生き残り変異 (MISSED) が出たら `db::tests` に境界ケースを
追記して潰す。生成物 `mutants.out/` は `.gitignore` 済み。

フロント (TS) 安全網のミューテーションテスト (#1358) — Stryker Mutator
(`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`、devDependency 導入済み):

```sh
# 4 モジュールすべて (concurrency 2。数十分かかる)
pnpm run mutants:js

# 1 モジュールだけ回す (推奨。dangerousSql.ts で約 5 分)
pnpm exec stryker run --mutate src/dangerousSql.ts
```

**運用方針**: 対象は `src/dangerousSql.ts` / `src/sqlScript.ts` /
`src/components/preflight.ts` / `src/components/cellEdit.ts` (単一ソースは
`stryker.conf.json` の `mutate`)。実行するテストは `vitest.mutants.config.ts` の
`include` に列挙した純ロジックのテスト (共有ゴールデン含む) に限る — 全スイートを
変異ごとに回すと初回ドライランがタイムアウトする。対象モジュールを検証するテストを
足したら `include` にも足す。Stryker は TypeScript 7 の JS API 非互換のため
`tsconfigFile` に存在しないパスを指定して tsconfig の書き換えを避けている。
CI トリガは `.github/workflows/js-mutants.yml` の `workflow_dispatch` (手動) のみで、
PR では走らせない。**fail させない** (可視化のみ) — mutants.yml と同じ漸進方針で、
Job Summary にスコアとモジュール別の生存数、アーティファクト `stryker-report` に
HTML/JSON レポートを出す。生き残り変異 (Survived / NoCoverage) は `reports/mutation/mutation.html`
で確認し、対応する `*.test.ts` に境界ケースを追記して潰す (等価変異や性能目的の
キャッシュ分岐は無理に潰さない)。生成物 `reports/mutation/` / `.stryker-tmp/` は `.gitignore` 済み。
`tsconfigFile` の `__stryker_skip_tsconfig_rewrite__.json` は意図的に存在しない名前
(Stryker による tsconfig 書き換えを避けるため)。

直近の実測 (#1358 レビュー対応後、cellEdit.ts + preflight.ts): cellEdit 87.98% (84.63% から)、
preflight 93.22%、合計 88.97%。残る生存は主に等価変異または対象外 —
i18n キー文字列・`validateCellInput` / `classifyEditType` の分類 (安全網のリテラル生成とは別経路)、
`i <= rows.length` 等の境界 (範囲外は直後の `if (!row) continue` で吸収される)、
`encodePkPart` のタグ単独除去 (単独では値域が衝突しない)、プリフライトの `depth` ガードや
`\s*` の正規表現 (マスク済み文字列では到達しない/結果が同じ)。

統合テストは対応する環境変数が設定されていない限りスキップされます (SQLite を除く):

```sh
NOOBDB_TEST_MYSQL_URL=mysql://root:rootpw@127.0.0.1:3306/testdb \
  cargo test --test external mysql_integration::
NOOBDB_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/testdb \
  cargo test --test external postgres_integration::
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
  cargo test --test external ssh_integration::
```

`tests/sqlite_integration.rs` は外部サーバを必要とせず、`std::env::temp_dir()`
に一時ファイルを作って**常に**実行されます。
