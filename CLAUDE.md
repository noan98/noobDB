# CLAUDE.md

このファイルは、本リポジトリのコードを扱う際に Claude Code (claude.ai/code) に
向けたガイダンスを提供します。

## 言語ポリシー

- **ユーザへの応答はすべて日本語で行ってください。** 説明・質問・確認プロンプト・
  ツール実行前の説明・進捗報告・エラー説明・最終サマリーなど、チャットに出力する
  すべての文章を日本語で記述します。これは Claude Code on the web (クラウド実行
  環境) を含む、本リポジトリで Claude Code が動作するすべての状況に適用される、
  例外のないルールです (コード・コマンド・識別子など本来英語で書くべきものは除く)。
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
cargo mutants --file src/db/mod.rs --file src/db/mysql.rs

# 変異候補の一覧のみ確認 (テストを走らせない)
cargo mutants --list --file src/db/mod.rs --file src/db/mysql.rs

# 既存ビルドを流用して高速実行 (--in-place)
cargo mutants --file src/db/mod.rs --file src/db/mysql.rs --in-place
```

**運用方針**: スコープは `src/db/mod.rs` / `src/db/mysql.rs` の安全網関数
(`is_read_only_sql` / `apply_auto_limit` / `has_stacked_statements` /
`is_query_shape` / `with_cte_is_mutation`) に限定。CI トリガは
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

CI は 2 つのワークフローに分かれています:

- `.github/workflows/ci.yml` — `main` への PR と `main` への push で起動。
  push トリガは**キャッシュを main スコープへ保存するため**にあります:
  pull_request 実行で保存される rust-cache / sccache / pnpm のキャッシュは PR の
  マージ ref スコープにしか残らず他の PR から参照できないため、main push 時に同じ
  ジョブを走らせて全 PR ブランチがフォールバック復元できる main スコープを温めます
  (これが無いと新規 PR ブランチの初回 Rust ビルドは毎回コールド)。マージ後の main
  の健全性確認も兼ねます。`dorny/paths-filter` で
  変更領域 (frontend / rust / workflow) を判定し、ジョブ単位の `if:` で出し分け
  します (ワークフロー丸ごとスキップにすると必須チェックが「待機中」で固まるため、
  ジョブを skip させる方式。push イベントでは paths-filter が git 履歴比較を行う
  ため `changes` ジョブは checkout してから filter を実行します)。frontend ジョブは `pnpm run build` に続けて
  `pnpm run bundle-size` (バンドルサイズ計測 → Job Summary。#443)、`pnpm run knip`
  (未使用エクスポート/到達不能コード検出。#470)、`pnpm test` (Vitest) を実行します。
  バンドルサイズはカバレッジと同じく当面は閾値による fail を設けず可視化のみで、
  `dist/` の JS/CSS の gzip 後サイズを Node 標準の zlib だけで集計します
  (`scripts/bundle-size.mjs`、size-limit 等の追加ツールは増やしません)。pnpm は
  各ジョブで `corepack enable` により用意し、`pnpm`
  ストアを `actions/cache` でキャッシュします (`actions/setup-node` の `cache: npm`
  は使いません)。`paths-filter` は `package-lock.json` ではなく `pnpm-lock.yaml` を
  監視します。Rust 系は 6 つのジョブに分かれます: `rust (clippy)` が
  `cargo clippy --all-targets --locked -- -D warnings` (clippy が rustc ドライバ
  として型チェックを内包するので別途 `cargo check` は走らせません)、`rust (test)`
  が MySQL 8 と PostgreSQL 16 のサービスコンテナに対し `cargo llvm-cov nextest`
  (カバレッジ計装下で nextest を実走) を実行します。`rust (test)` は加えて
  `scripts/ci-setup-sshd.sh` で apt の `openssh-server` を 127.0.0.1:2222 に立て、
  `NOOBDB_TEST_SSH_URL` / `NOOBDB_TEST_SSH_KEY` を `$GITHUB_ENV` に渡すことで SSH
  トンネル統合テスト (#331) も実走します (サービスコンテナはイメージ pull が要るため
  使わず、apt 構成で再現性を確保)。`rust (fmt)` が
  `cargo fmt --all -- --check` を、`rust (deny)` が
  `cargo deny --manifest-path src-tauri/Cargo.toml check` (依存ライセンスの許可
  リスト検査と RustSec Advisory DB による脆弱性チェック。設定は
  `src-tauri/deny.toml`) を実行します。`rust (deny)` は cargo metadata を読むだけで
  コンパイル不要なため、Tauri のシステム依存やフロントエンドビルドは要らず軽量に
  走ります (cargo-deny は他ツールと同じく `taiki-e/install-action` でプリビルド
  バイナリを導入)。`rust (test)` には MySQL 用の
  `NOOBDB_TEST_MYSQL_URL` と PostgreSQL 用の `NOOBDB_TEST_POSTGRES_URL` を両方
  渡しており、両ドライバの統合テストが CI で実走します (SQLite は環境変数不要で
  常に走る)。カバレッジは `cargo llvm-cov report` で lcov を生成しつつ、サマリ表を
  Job Summary に出力して PR ごとに可視化し、加えて `--fail-under-lines` で行
  カバレッジの**下限を強制**します。閾値は**ラチェット式 (下げない)** で運用し
  (#482)、テスト整備で実測が上がったら実測をわずかに下回る値へ段階的に引き上げます
  (現在 Rust 60 / フロント `vite.config.ts` の `lines: 26`)。当面は branch/function/
  per-file ではなく lines 全体のみで運用します (誤検出回避)。閾値割れで落ちても
  Job Summary には実測が残るよう、強制ステップはサマリ出力の後に置いています。
  llvm-cov の計装には `llvm-tools-preview` コンポーネントと `cargo-llvm-cov` が
  必要で、いずれもこのジョブで導入しています。
  clippy (cargo check 相当) と nextest (実バイナリ生成) は cargo が成果物を共有
  しないため、同一ジョブで直列にすると依存ツリーが二重コンパイルされて積み上がり
  ます。これを別ジョブで**並列**に走らせて壁時計時間を縮めています (rust-cache の
  `key` を `clippy` / `test` に分けてキャッシュを分離)。両 Rust ジョブとも CI では
  無益な incremental コンパイルを `CARGO_INCREMENTAL=0` で無効化しています。
  残る 2 つの `rust (windows clippy)` / `rust (windows test)` は `windows-latest`
  上でそれぞれ `cargo clippy` と `cargo nextest run` を実行し、Windows 固有
  (keyring・ファイルパス・改行コード・MSVC リンカ `lld-link`) のリグレッションを
  PR 段階で検出します (#392)。Linux と同じ理由 (check と codegen+link の成果物
  非共有) で clippy と nextest を並列ジョブに分割しており、単一ジョブで直列実行
  していた頃は Windows がワークフロー全体のクリティカルパスでした。MySQL/
  PostgreSQL の URL 環境変数を渡さないため統合テストはスキップされ、外部サービス
  不要の SQLite 統合テストのみ実走します。Tauri の全スタックビルド (WebView2 等) は
  不要で MSVC toolchain だけで足り、rust-cache の `key` は `windows-clippy` /
  `windows-test` で Linux と分離しています。
  さらに `rust (clippy)` / `rust (test)` / `rust (windows clippy)` /
  `rust (windows test)` の各コンパイルジョブは
  **sccache** を `RUSTC_WRAPPER` として有効化し (`taiki-e/install-action` で導入)、
  `SCCACHE_DIR` を `actions/cache` で永続化してブランチ跨ぎでコンパイル単位を再利用
  します (#417)。rust-cache が `target` ディレクトリをキャッシュするのに対し sccache
  は rustc 呼び出し単位をキャッシュする役割分担で、キャッシュキーは
  `sccache-<os>-<job>-<Cargo.lock ハッシュ>` で分離します。`config.toml` の sccache
  設定はコメントアウトのままで、CI 限定で環境変数により有効化しています。なお
  `rust (test)` のカバレッジ計装ビルド (`-C instrument-coverage`) は sccache が
  キャッシュ対象外として素通しするため、sccache の効果は主に clippy/windows ジョブと
  依存クレートのコンパイルに現れます。
  **必須チェックを設定する場合は `rust (check + clippy + test)` や旧
  `rust (windows)` ではなく `rust (clippy)` と `rust (test)` (必要なら
  `rust (deny)` / `rust (windows clippy)` / `rust (windows test)`) を
  指定してください** (ジョブ分割でチェック名が変わったため)。
- `.github/workflows/release.yml` — `v*` タグまたは `workflow_dispatch` を
  トリガに、`windows-latest` 上で `tauri-action` 経由の NSIS バンドルを生成します。
  `main` への push でもキャッシュ温め目的でビルドが走ります。ビルド後の
  `Report bundle artifact sizes` ステップが、出荷バイナリ (NSIS インストーラ・
  `.exe`、将来の `.dmg` / `.AppImage` / `.deb`) のサイズを Job Summary に出力します
  (#549)。これは JS/CSS を測るバンドルサイズ可視化 (#443) の**アプリ本体版**で、方針も
  同じく**当面は閾値で fail させず可視化のみ** (カバレッジ #482 と同じ漸進方針)。
  追加ツールは増やさず `stat` + `awk` のシェル標準機能だけで集計し、cache-warm /
  リリースの両ビルド経路の後に `if: always()` で 1 回測ります。macOS/Linux バンドルを
  追加したら (本 Epic の別 Issue) `.dmg` / `.AppImage` / `.deb` のグロブが自動的に
  対象へ含まれます。起動時間の監視は計測の安定性が難しいため本 Issue のスコープ外
  (任意/将来拡張) としています。

Linux CI では Tauri 2 のシステムパッケージ (`libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libxdo-dev`,
`libayatana-appindicator3-dev`) が必要です。

### ビルド高速化

ローカルと CI の Rust ビルドを速くするための設定をいくつか入れています。

- `src-tauri/Cargo.toml` の `[profile.dev]` で `debug = "line-tables-only"` を
  指定し、dev ビルドの debuginfo を行テーブルのみに削減しています。リンク時間が
  減り dev ビルドの反復が速くなる一方、バックトレースのファイル:行情報は維持され
  ます。ツール導入不要で全環境に効きます。
- `src-tauri/Cargo.toml` の `[lib] crate-type` は **`["rlib"]` のみ**にしています。
  `staticlib` / `cdylib` はモバイル (iOS/Android) 専用の生成物で、デスクトップ
  専用の本プロジェクトでは不要です。これらを残すとリリースビルドで依存ツリー全体を
  含む cdylib(.dll) の最適化リンクが余計に走るため、`rlib` 限定でその分を削減して
  います。**モバイル対応する場合は `["staticlib", "cdylib", "rlib"]` に戻す**こと。
- `src-tauri/.cargo/config.toml` が **Linux x86_64 ターゲットのリンカに
  `clang` + `mold`** を指定しています。インクリメンタルビルドではリンクが所要
  時間の大半を占めるため、効果が大きいです。**Linux で開発・テストする場合は
  `clang` と `mold` のインストールが必須**です (`sudo apt install clang mold`
  など)。未導入だと `cargo build` / `clippy` / `test` がリンカを見つけられず
  失敗します。用意できない場合は同ファイルの `-fuse-ld=mold` を `-fuse-ld=lld`
  に変えるか、`[target.*]` ブロックをコメントアウトしてください。この設定は
  Linux x86_64 ターゲット限定で、Windows のリリースビルドや macOS には影響
  しません。
- 同ファイルが **Windows (MSVC) ターゲットのリンカに LLVM の `lld-link`** を
  指定しています。既定の `link.exe` は巨大バイナリのリンクが遅く、リリースビルド
  (`release.yml`) の最終リンクを縮められます。GitHub Actions の `windows-latest`
  ランナーには LLVM がプリインストール済みで `lld-link` が PATH 上にあります。
  **ローカルで Windows ビルドする場合は LLVM (lld-link) が必須**で、未導入なら
  `[target.x86_64-pc-windows-msvc]` ブロックをコメントアウトすれば既定の `link.exe`
  に戻ります。Linux / macOS のビルドには影響しません。
- 同ファイルに **sccache** (`[build] rustc-wrapper`) の設定をコメントアウト
  状態で同梱しています。プロジェクト/ブランチを跨いでコンパイル成果物を再利用
  したい場合は `cargo install sccache` してから該当行を有効化してください。
  クリーンビルドや `Cargo.lock` 変更時のビルドに効きます (リンク時間は短縮
  されないので mold と併用すると効果的)。**CI では `config.toml` を書き換えず**、
  `ci.yml` の各コンパイルジョブで `RUSTC_WRAPPER=sccache` を環境変数として与える
  方式で有効化しています (`SCCACHE_DIR` を `actions/cache` で永続化)。ローカルの
  挙動を変えたくないため config はコメントアウトのままにしています。
- CI (`ci.yml` の rust ジョブ) では上記 config に合わせて `clang` と `mold` を
  apt で導入済みで、`cargo nextest` のテストバイナリ群のリンクが mold で高速化
  されます。加えて `rust (clippy)` / `rust (test)` / `rust (windows clippy)` /
  `rust (windows test)` では
  **sccache** を `RUSTC_WRAPPER` で有効化し、コンパイル単位のキャッシュをブランチ
  跨ぎで再利用します (詳細は上の CI セクションを参照)。

### unwrap / expect / panic の lint 運用 (#527)

Rust 本体コードでの `unwrap()` / `expect()` / `panic!` によるクラッシュを構造的に
抑止するため、`src-tauri/src/lib.rs` の先頭に
`#![warn(clippy::unwrap_used, clippy::expect_used, clippy::panic)]` を置いています。
CI の clippy ジョブは `-D warnings` でこれをエラーに昇格させるため、**新規に
unwrap/expect/panic を本体コードに入れると CI が自動で fail** します。テストコードは
`src-tauri/clippy.toml` の `allow-unwrap-in-tests = true` 等で除外済みなので、既存の
テストには影響しません。どうしても本体コードに残す必要がある箇所 (回復不能な起動失敗など)
には `#[allow(clippy::unwrap_used)]` / `#[allow(clippy::panic)]` + **なぜ
panic/unwrap が妥当かの日本語根拠コメント**を必ず付けてください。

JS のリンタは設定されていません。フロントエンドは `tsc` (`pnpm run build` 経由) で
型チェックされます。`tsconfig.json` では `strict`、`noUnusedLocals`、
`noUnusedParameters` が有効になっているため、未使用の import やパラメータがあると
ビルドが失敗します。テストランナーには **Vitest** を採用しており、`pnpm test`
(`vitest run`) で `src/__tests__/` 配下のユニットテストを実行します。テスト対象は
SQL の安全網・リテラル生成・方言判定など安全性に直結する純粋ロジック
(`dangerousSql.ts`・`components/cellEdit.ts`・`components/sqlDialect.ts` など) です。
テストファイルは `src/` 配下にあるため `tsc` の型チェック対象にも含まれます。CI
(`ci.yml`) の frontend ジョブが `pnpm run build` に続けて `pnpm test` を実行します。

### 実ブラウザでの画面テスト (Vitest ブラウザモード / #306)

上記の `pnpm test` (jsdom) は純ロジックとコンポーネント挙動を見るもので、**実際に
ブラウザで本物の CSS と一緒に画面が描画された結果**は検証しません。これを補うため、
**Vitest ブラウザモード (Playwright provider + headless Chromium)** で主要画面を実
ブラウザにマウントするテストを別系統で用意しています (#306)。Chakra UI 全面移行
(#271) はレイアウト/テーマ追従の退行が最も起きやすい局面で、その自動検出網です。

- 設定は **`vitest.browser.config.ts`** に分離しています (jsdom の `vite.config.ts`
  とは実行環境が異なるため)。テストは `src/__tests__/browser/**/*.browser.test.tsx`
  の専用 glob に限定し、jsdom スイート (`*.test.tsx`) とは `vite.config.ts` 側の
  `exclude` で互いに衝突しないようにしています。
- 実行: **`pnpm test:browser`** (比較) / **`pnpm test:browser:update`** (ベース
  ライン更新)。ローカルで走らせるには Playwright の Chromium が必要です
  (`pnpm exec playwright install --with-deps --only-shell chromium`)。
- `src/__tests__/browser/render.tsx` が `vitest-browser-react` の `render` を実
  アプリと同じ `ChakraProvider` + `ToastProvider` でラップします。
  `setup.browser.ts` が Tauri ランタイム (`window.__TAURI_INTERNALS__`) をスタブ
  して `invoke` を無害化し (実 DB 不要で任意の画面状態を props 注入できる。#289 と
  共有するモックシームと同じ発想)、アニメーションを無効化し、ロケールを固定します。
- **Phase 1 (`screens.browser.test.tsx`)**: 接続フォーム・結果グリッド・危険クエリ
  確認ダイアログ・設定・ヘルプの主要画面が例外なく描画され、要のロール/テキストが
  可視であることを確認します。
- **シナリオテスト (`scenarios.browser.test.tsx`、#564)**: `<App />` 全体をマウント
  し、ユーザ操作の主要フロー — 複数接続の切替 (タブのプロファイル単位退避/復元)・
  ストリーミング結果の段階表示・実行キャンセル・インラインセル編集 → pending →
  Apply・タブ復元 — を実 Chromium で再現します。バックエンドは
  **`tauriMock.ts` のフェイク Tauri ランタイム**で差し替えます:
  `window.__TAURI_INTERNALS__` をコマンドディスパッチ + イベント購読/発火
  (`plugin:event|listen`) のプロトコルごと実装するため、`api/tauri.ts` の型付き
  ラッパ・zod 検証・`listenQueryStream` の streamId フィルタは**実コードのまま**
  実行経路に乗り、テストは `emitTauriEvent` で `query-stream:*` イベントを任意の
  タイミングで注入できます (実 DB 不要)。未登録のアプリコマンドが呼ばれると明示的に
  落ちるので、モック漏れに気付けます。ロケータは Playwright の `name` が部分一致で
  ある点に注意し、短い名前 (DB/テーブル/セル値) は `exact: true` を指定します。
  これらのテストはベースライン PNG を持たないため、失敗時に Vitest が自動保存する
  スクリーンショット (`__screenshots__/scenarios.browser.test.tsx/`) は
  `.gitignore` 済みです。
- **Phase 2 (`visual.browser.test.tsx`)**: 結果グリッドと危険クエリ確認ダイアログを
  ライト/ダークの両テーマで `toMatchScreenshot` し、ビジュアル回帰を検出します。
  ベースライン PNG は `src/__tests__/browser/__screenshots__/` 配下に保存されます。
  ビジュアル回帰はコミット済みベースラインとの比較で、ベースラインが無い環境では
  `toMatchScreenshot` が (skip ではなく) **失敗**します。そのため `VITE_RUN_VISUAL=1`
  のときだけ実行する `describe.runIf` でゲートしており、通常の `pnpm test:browser`
  (および現状の CI) では**スキップ**されます。ベースラインを CI 上で生成・コミット
  したのち、CI 側で `VITE_RUN_VISUAL=1` を立てれば比較を必須化できます。
- **ベースラインは比較を行う CI と同一環境 (Linux/Chromium) で生成・コミット**します
  (OS/フォントの描画差による false positive を避けるため)。ローカル (macOS/Windows)
  では生成せず、意図的に見た目を変えたとき (および初回導入時) は
  **`.github/workflows/visual-baseline.yml` の手動トリガ (`workflow_dispatch`)** を
  対象ブランチで実行してベースラインを再生成・コミットします。失敗時の実測/差分
  画像 (`*-actual.png` / `*-diff.png`) は `.gitignore` 済みでコミットされません。
- CI では `ci.yml` の **`frontend (browser render + visual)` ジョブ**が Playwright の
  Chromium を導入して `pnpm test:browser` を実行します (jsdom の `frontend` ジョブ
  とは別ジョブ)。現状はスモークのみが走り、ビジュアル回帰はベースライン整備後に
  `VITE_RUN_VISUAL=1` で有効化する想定です。**必須チェックを設定する場合はこの
  ジョブ名にも注意**してください。
- 既知の限界: Chromium 上の検証であり、Tauri が実際に使う webview (Linux: WebKitGTK
  / Windows: WebView2) とは描画エンジンが異なります。移行に伴う Web 層のレイアウト/
  見た目退行は十分捕捉できますが、実 webview 固有の描画差はカバー範囲外です
  (将来のフル Tauri E2E = Phase 3 の領域)。

### Phase 3: tauri-driver による実 webview E2E 基盤 (#529 PoC)

**位置づけ**: Phase 2 (#306) の Chromium ブラウザモードは「Web 層のレイアウト/ビジュアル
退行」を検出するが、Tauri が実際に使う webview (Linux: WebKitGTK / Windows: WebView2)
上での **実 IPC 通信込みのエンドツーエンド動作**は検証できない。Phase 3 はその補完として
`tauri-driver` + `WebDriverIO` により実 webview を WebDriver プロトコル経由で駆動する
基盤の PoC であり、#529 で実現可能性を評価した。

#### 構成ファイル

| ファイル | 役割 |
|---|---|
| `e2e/wdio.conf.ts` | WebDriverIO の設定。`@wdio/tauri-service` を使い tauri-driver の起動/終了を自動化。アプリバイナリパスをプラットフォーム別に解決する |
| `e2e/tsconfig.e2e.json` | E2E 専用 tsconfig (主 tsconfig.json の対象外として分離し tsc エラーを防ぐ) |
| `e2e/specs/sqlite-happy-path.e2e.ts` | SQLite ハッピーパスのスペック。接続フォーム入力 → 接続確立 → SELECT 実行 → ResultGrid 表示 → セル編集 Apply (骨格) の 5 ステップ |
| `.github/workflows/e2e.yml` | `workflow_dispatch` 手動トリガの CI ワークフロー。Linux (Ubuntu 22.04) 上で `webkit2gtk-driver` + `xvfb` + `tauri-driver` を使う |

#### ローカル実行手順

```sh
# 1. tauri-driver をインストール (初回のみ)
cargo install tauri-driver --locked

# 2. Linux 追加パッケージ
sudo apt-get install -y webkit2gtk-driver xvfb

# 3. Tauri デバッグバイナリをビルド (初回 + Rust ソース変更時)
cd src-tauri && cargo build && cd ..

# 4. フロントエンドをビルド (dist/ を生成)
pnpm run build

# 5. E2E 実行 (Linux ヘッドレス)
xvfb-run -a pnpm test:e2e
# E2E 実行 (Linux ディスプレイあり / Windows)
pnpm test:e2e
```

#### #306 (Chromium) との違い・補完関係

| 観点 | Phase 2 (Chromium, #306) | Phase 3 (tauri-driver, #529) |
|---|---|---|
| 検証エンジン | headless Chromium (Playwright provider) | 実 WebKitGTK / WebView2 |
| Tauri IPC | スタブ (invoke を無害化) | **実 IPC** を駆動 |
| DB 接続 | 不要 (props 注入) | **実 SQLite** 接続を確立 |
| 検証対象 | UI レンダリング・CSS・レイアウト | IPC ラウンドトリップ・DB 動作 |
| 実行速度 | 数十秒 (Chromium 起動) | 数分〜 (Tauri バイナリビルド含む) |
| 安定性 | 高 (Chromium は成熟) | 中〜低 (WebKitGTK + xvfb は flaky になりやすい) |

Phase 2 がレイアウト/ビジュアルの退行検出に強く、Phase 3 が IPC を含む実動作の
エンドツーエンド検証に強い。両者は補完関係であり、競合しない。

#### 実現可能性の評価 (#529 実施時点)

- **技術的実現性**: `tauri-driver` + `@wdio/tauri-service` の組み合わせは公式に
  サポートされており、構成ファイルの整備は完了できた。
- **実行時間**: Rust デバッグバイナリのクリーンビルドで 10〜20 分、キャッシュ有りで
  4〜8 分程度。これに E2E テスト自体の 2〜5 分が加わり、PR ごとのゲートとして使うには
  コストが高い。
- **安定性 (flaky リスク)**: WebKitWebDriver + xvfb の組み合わせはウィンドウ描画タイミング・
  GTK 初期化順序に依存し、タイムアウトによる flaky が起きやすい。セレクタを
  role/text ベースで書いているため UI 変更で壊れるリスクもある。
- **メンテコスト**: tauri-driver は Tauri のバージョンに追従が必要。WebDriverIO
  のバージョン (`@wdio/tauri-service@1.0.0` は WebDriverIO v9 が必要) の固定管理も
  必要。
- **macOS 非対応**: WKWebView に WebDriver 実装がなく、tauri-driver は macOS を
  サポートしない (Linux / Windows のみ)。

#### CI 適用方針の結論

**方針: `workflow_dispatch` 手動トリガで PoC 運用。安定化後に nightly を検討。**

現時点での必須チェック化は行わない。理由:

1. **ビルド時間**: Tauri バイナリのビルドが PR ゲートを大幅に延ばし、#443/#482 の
   「漸進的品質向上」方針に反する (現在の CI 壁時計時間を倍増させるリスク)。
2. **flaky リスク**: WebKitWebDriver + xvfb は安定実績が浅く、false negative で
   マージをブロックし続ける運用負荷が大きい。
3. **補完対象が限定的**: 現在の E2E スペック (SQLite ハッピーパス 1 本) は
   Phase 2 が既にカバーする範囲と重複しており、差分の価値がまだ低い。

**nightly への昇格基準** (以下が揃ったら `schedule: cron` で週次に昇格を検討):
- テストが 3 回連続で安定してグリーンになること
- 実行時間が 15 分以内に収まること (キャッシュ暖機後)
- セレクタを `data-testid` で安定化させること (Phase 3 専用 testid を最小限追加)
- IPC 固有のアサーション (Chromium では検証不可なもの) が 1 件以上追加されること

コスト: High (Tauri ビルド + flaky 管理) / メリット: 3 (実 webview 検証は価値あるが
Phase 2 との差分は当面限定的) — まず PoC 運用で安定性を評価し、メリットが確認できた
段階で昇格する。

未使用エクスポート・到達不能コード・未使用依存の検出には **knip** (`pnpm run knip`)
を使います (#470)。`tsc` の `noUnusedLocals` はファイル内の未使用しか拾えませんが、
knip は「エクスポートされているがどこからも import されない関数」や「未使用の依存」
などモジュール跨ぎのデッドコードを検出し、IPC ラッパ (`api/tauri.ts`) ⇔ UI 利用の
ドリフト (到達できない機能) を防ぎます。設定は `knip.json` で、`ignoreExportsUsedInFile`
により「同一ファイル内でのみ使う export」は許容し、意図的な公開 API は JSDoc の
`@public` タグ (`tags: ["-public"]`) で許可リスト化してベースラインを green にして
います。CI の frontend ジョブが `pnpm run build` の後に `pnpm run knip` を実行し、
新規の未使用エクスポートが入ると fail します。

## アーキテクチャ

noobDB は MySQL / PostgreSQL / SQLite に対応した軽量デスクトップ DB クライアントで、
SSH トンネルをファーストクラスでサポートします。Rust バックエンド (`rust-version`
1.77、edition 2021) は `sqlx` 0.9 (`tls-rustls`)、`russh` 0.61、`keyring` 3 などに
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
3 バリアントを持ち、各操作 (`execute`, `begin_transaction` / `execute_in_transaction` /
`finish_transaction` / `transaction_active`, `health_check`,
`preview_execute_with_limit`, `execute_stream`, `import_rows`, `execute_transaction`,
`databases`, `tables`, `columns`, `schema_overview`, `foreign_keys`, `schema_objects`,
`object_definition`, `list_indexes`, `table_row_estimates`, `list_processes`,
`kill_process`, `close`, `driver_kind`) でバリアントに対してマッチします。**新しい
データベースを追加する場合は、`DriverKind` にバリアントを追加し、同じメソッド表面を
公開する `db/<name>.rs` モジュールを追加し、`db/mod.rs` の各 `match` アームを拡張します。**
SSH やセッション層には触らないでください — それらはドライバに依存しません。`schema_objects` /
`object_definition` (ビュー・ルーチン・トリガーの列挙と DDL 取得)、`list_indexes`、
`table_row_estimates` (統計情報ベースの概算行数)、`list_processes` / `kill_process`
(MySQL `PROCESSLIST` / PostgreSQL `pg_stat_activity`) もこの enum 表面の一部で、SQLite では
多くがサーバ機能非対応のため空や no-op で短絡します。

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

### TLS / SSL 設定 (#520)

MySQL / PostgreSQL の接続は TLS をファーストクラスでサポートします。
`DbConnectOptions` の `ssl_mode` (`SslMode` enum: `disable` / `prefer` / `require` /
`verify_ca` / `verify_full`) と証明書パス 3 種 (`ssl_root_cert` = CA、
`ssl_client_cert` / `ssl_client_key` = mTLS) がドライバ非依存の共通表現で、各ドライバの
`connect` 内の `apply_tls` がそれぞれの sqlx enum へマッピングします (PostgreSQL は
`PgSslMode`、MySQL は `MySqlSslMode`。`verify_full` は MySQL の `VerifyIdentity` に対応)。
`ssl_mode = None` は sqlx 既定 (`prefer`/`preferred`) を維持するため、TLS 設定が無い
旧プロファイルは**後方互換**で従来どおり接続できます。空の証明書パス (`Some("")`) は
`non_empty` で「未設定」として扱います。SQLite は TLS 非対象で常に `None`。**証明書はパス
のみが非秘密フィールドとして `profiles.json` に保存され、ファイルの中身は接続時に読み込む
だけで保存しません (keyring も不要)**。UI は `ConnectionForm` の TLS セクション。SSH
トンネル併用時はドライバが 127.0.0.1 に接続するため `verify_full` のホスト名検証が失敗
しうる点をヘルプ (`formTlsSshHint`) に明記しています。

**TLS 統合テスト方針**: 既存の MySQL/PostgreSQL 統合テスト (環境変数ゲート) と同様に、
TLS 有効サーバを要する検証は専用の環境変数 (未設定ならスキップ) でゲートする想定です。
`apply_tls` のモードマッピングとパス正規化 (`non_empty`) は `db/mysql.rs` /
`db/postgres.rs` の単体テストが network 不要でカバーしており、実 TLS サーバへの
ハンドシェイク検証 (CA 検証失敗時のエラー表面化を含む) は CI にサーバ証明書を配備した
うえで追加するのが次段です。

### セッション初期化 SQL (#522)

接続プロファイルは**セッション初期化 SQL** (`DbConnectOptions.init_sql`、複数文可) を
持てます。接続確立直後にドライバ層で **sqlx の `after_connect` フック**を通じて
**プールの各物理接続ごと**に実行されるため、`SET search_path` / `SET time_zone` /
`SET sql_mode` / `SET ROLE` / `statement_timeout`・SQLite の `PRAGMA` などを毎タブ
手動で流さなくても結果の再現性が保てます。各ドライバの `connect` が
`init_sql_of(opts)` で非空時のみ `after_connect(|conn, _| raw_sql(...))` を登録します
(`sqlx::raw_sql` は `;` 区切りの複数文を simple-query で実行)。`connect_with` が初回
接続を 1 本張って検証するため、初期化 SQL の実行失敗は**接続時のエラーとして表面化**
します。

**読み取り専用との整合方針**: 初期化 SQL は `db::is_session_init_sql` の安全網を通し、
**各文が `SET` / `PRAGMA` で始まるか、`is_read_only_sql` を通る読み取り専用文のみ**を
許可します (データ変更・DDL・`USE` は全体を不正として弾く)。書き込みを一切含まないため
読み取り専用セッションでも整合します。検証は `commands::connection::build_options` が
接続前に行い、不正なら `InvalidInput` を返します。コメント/文字列リテラルはマスクして
から `;` 分割するので、`'a;b'` 内のセミコロンは文境界と誤認しません。非秘密フィールド
として `profiles.json` に保存します。判定の単体テストは `db/mod.rs`、実行が各物理接続で
効くことの検証は `tests/sqlite_integration.rs` の `sqlite_init_sql_runs_on_each_connection`
(PRAGMA を設定して読み戻す。外部サーバ不要で常時実走) がカバーします。

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

読み取り専用判定は、バックの `is_read_only_sql` とフロントの `dangerousSql.ts`
`isReadOnlySql` で**独立に二重実装**されているため、両者の判定がズレないよう**共有
ゴールデンベクタ**で整合性を継続検証します (#444)。代表的な SQL とその期待値を
`src/__tests__/fixtures/readOnlySqlVectors.json` に 1 ファイルだけ置き、フロントは
Vitest (`readOnlyGolden.test.ts`) で import、バックは統合テスト
(`tests/read_only_golden.rs`) が `include_str!` で読み込んで `__test_api::is_read_only_sql`
に通します。スタック文・ロック付き SELECT・データ変更 CTE・マスク済みキーワードなどの
境界ケースを網羅しており、片方の実装だけ変えてズレるとどちらかのテストが落ちます。
**境界ケースを追加するときはこの JSON に追記**すれば両言語に反映されます。

**安全網には「強制レベル」の違いがある点に注意してください。** 同じ「安全網」でも、
バックエンドで強制されるものと、UI 上の確認に留まるものがあります。

- `read_only` (プロファイル) は**バックエンド強制**です。`commands::query` の各
  エントリポイントが `ensure_allowed_for_session` 経由で `is_read_only_sql` を通し、
  `import_csv` も `session.read_only` を拒否します。IPC を直接呼んでも書き込みは
  通りません。
- `is_production` の接続確認と `confirm_writes` (本番接続での書き込み承認) は
  **UI レベルの安全網 (UX ガード)** です。`confirm_writes` の判定はフロントの実行
  ゲート (`App.tsx` の `analyzeDangerousSql` / `isReadOnlySql`) でのみ行われ、
  バックエンドの `ensure_allowed_for_session` は `read_only` のみを強制し
  `confirm_writes` は参照しません。プロファイルには保持されますが (`profiles/mod.rs`)、
  IPC を直接呼べば承認なしに書き込めます。**誤操作防止が目的であり、権限強制では
  ありません。** 確実に書き込みを禁止したい場合は `read_only` か DB 側の権限設定を
  併用してください。この限界はアプリ内ヘルプ (`HelpView` の `helpConfirmWrites*`)
  と接続フォームのヘルプ文言 (`formConfirmWritesHelp`) にも明記しています。

なお、読み取り専用セッションでもドライランプレビュー (`preview_query_stream`) は
許可されます。これは「先頭 DML キーワード判定 + トランザクション内実行 + 必ず
ロールバック」で安全を担保しますが、加えて各ドライバの `preview_execute_with_limit`
は `db::has_stacked_statements` で**末尾以外にセミコロンを含む複数文を拒否**します
(MySQL の DDL 暗黙コミットでロールバックを逃れる積み重ねを防ぐため、sqlx の単一文
実行に依存せず明示的に弾く)。

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
  `file_path`、TLS 設定 (`ssl_mode`・`ssl_root_cert`・`ssl_client_cert`・
  `ssl_client_key` の各**パス**。#520)、セッション初期化 SQL (`init_sql`。#522) など。
  証明書はパスのみが非秘密で、ファイルの中身は接続時に読み込むだけで保存しません。
  `profiles/store.rs` は load/save-all と upsert/delete の API を提供します。
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

- `commands/export.rs`: 結果グリッドの内容を CSV / JSON / NDJSON へ書き出します
  (`export_query_result`)。CSV は RFC4180 風のクオート、BLOB は `0x...` で出力。
  NDJSON (`ExportFormat::Ndjson`) は 1 行 1 オブジェクトの改行区切り JSON で、値
  エンコードは JSON 配列経路 (`row_to_json_object`) と共有します。
  加えて `export_query_stream` は、グリッドに載っていない大きな結果セットを
  メモリに溜めず**ストリーミングで直接ファイルへ書き出す**経路です (`run_query_stream`
  と同じバッチ列を消費)。3 形式とも通常 / ストリーミングの両経路に対応します。
  **JSON 形式のときは実行クエリを出力に同梱**できます (`export_query_result` の
  `query` 引数 / `export_query_stream` は `sql` を流用)。同梱時は配列ではなく
  `{ "query": <sql>, "rows": [...] }` でラップします (キーは serde_json 既定の
  `BTreeMap` 出力に従いアルファベット順)。`query` が None/空、または CSV/NDJSON では
  従来どおり配列のまま (後方互換)。`ExportModal` (フロント) は出力内容のプレビュー欄
  (純ロジックは `components/exportPreview.ts` がバックエンドの書式をミラー) と、在
  グリッド全行を全文コピーするコピーアイコンを備えます。
- `commands/dump.rs`: `mysqldump` を呼ぶ DB ダンプ (MySQL 専用)。資格情報は
  プロセス引数や環境変数に出さないよう、一時オプションファイル (unix では mode 0600)
  経由で渡し、終了後に削除します。`mysqldump` が PATH にない場合は分かりやすい
  エラーを返します。`DumpOptions.format_sql` (既定オフ) を立てると、書き出した
  SQL を `db::format::format_sql` (`sqlformat` クレートの薄いラッパ) で整形して
  保存し直します — フロントの sql-formatter と方針 (2 スペース字下げ・キーワードの
  ケース保持) を揃えた可読性向上オプションです。
- `commands/import.rs`: CSV / JSON / NDJSON を `import_rows` でテーブルへ一括投入
  します (`encoding_rs` でエンコーディング指定可、NULL トークン・列マッピング対応)。
  読み取り専用セッションでは拒否されます。進捗は `csv-import:*` イベントで通知します。
  フォーマットは `ImportOptions.format` (`ImportFormat`: `csv` / `json` / `ndjson`、
  既定 `csv` で後方互換) で選択し、`parse_preview` / `parse_rows` がフォーマットで
  分岐します (#521)。JSON はトップレベル配列のオブジェクト (単一オブジェクトは 1 行)、
  NDJSON は 1 行 1 オブジェクトをパースし、`csv_index` は全レコードのキー和集合から
  作る**ヘッダ列 (first-seen 順、各オブジェクト内は BTreeMap でソート)** を指します
  (プレビューとインポートで同じ順序になり列対応がズレない)。ネスト値 (オブジェクト/
  配列) はコンパクトな JSON テキストに文字列化、`null`・欠損キーは SQL NULL、NULL
  トークンも CSV と同じく適用します。コマンド名 (`parse_csv_preview` / `import_csv`) と
  `CsvPreview` 型名は IPC 安定のため CSV 時代のまま据え置き、全フォーマットを扱います。
  `ImportModal` はフォーマット選択 (拡張子から既定推定) を持ち、JSON/NDJSON では
  CSV 専用フィールド (区切り/クオート/ヘッダ行) を隠します。

### 明示的トランザクション

ストリーミング/オートコミット経路 (`run_query` 等) とは別に、UI のインラインセル編集や
複数文の対話的実行のために**明示的なトランザクション境界**を張る IPC があります。
`begin_transaction` → `run_in_transaction` (複数回) → `finish_transaction(commit)` の
3 コマンドが `db::Connection` の `begin_transaction` / `execute_in_transaction` /
`finish_transaction` / `transaction_active` にマップされ、セッションが内部に抱える
トランザクションハンドル上で実行されます。`run_query_transaction` (all-or-nothing の
文配列をまとめて投入する従来経路) とは別物で、こちらは**開いたまま複数の往復**を
できる点が違います。読み取り専用セッションでは書き込み文が拒否される点は同じです。

### スキーマ・データ比較と同期 (Diff / Sync)

2 つの接続 (セッション) 間でスキーマとデータを突き合わせ、差分を埋める SQL を生成・
適用する機能です。**純粋計算層 (`db/`) と IPC 層 (`commands/`) を明確に分離**しており、
純粋層はドライバ非依存・副作用なしで単体テストが容易です。

- `db/diff.rs`: `compute_schema_diff` がテーブル/カラムのメタデータ 2 組を入力に
  `SchemaDiff` (各テーブル・カラムを `DiffStatus`: `SourceOnly` / `TargetOnly` /
  `Different` / `Same` で分類) を計算する純粋関数。`data_type` / `key` / `extra` は
  大小無視、`default` は厳密比較など、フィールドごとに比較基準を変えています。
- `db/data_diff.rs`: `compute_data_diff` がプライマリキーで行をペアリングして
  `RowDiff` を計算し、`generate_data_sync_sql` がそこから INSERT / UPDATE / DELETE を
  生成します。リテラルはドライバ別にエスケープ (MySQL はバックスラッシュも二重化)。
- `db/sync.rs`: `generate_sync_sql` が `SchemaDiff` から対象ドライバの DDL 方言に
  合わせた `SyncPlan` (`SyncStatement` 列 + `warnings`) を生成。MySQL は `MODIFY COLUMN`、
  PostgreSQL は facet 単位の `ALTER COLUMN`、SQLite は in-place 変更不可のため warning に
  降格、と方言差を吸収します。`SyncKind::order()` で CREATE → ADD → ALTER → DROP →
  INSERT/UPDATE/DELETE の安全な適用順を決めます。
- `commands/diff.rs`: `compare_schema` / `compare_table_data` が両セッションから
  メタデータ・行を取得して上記純粋関数に渡す IPC ラッパー。両セッションが同一ドライバで
  あること、データ比較対象テーブルにプライマリキーがあることを要求し、データ比較は
  `MAX_DATA_ROWS=5000` / `DEFAULT_DATA_ROWS=1000` で上限を設けます (マスターデータ向け)。
- `commands/sync.rs`: `generate_sync_sql` / `generate_data_sync_sql` (純粋生成) と
  `apply_sync_sql` (ターゲットセッションでトランザクション実行) を公開。`allow_destructive`
  (`DROP`) / `allow_delete` (`DELETE`) フラグで破壊的操作をオプトインにし、読み取り専用
  セッションへの適用は拒否します。MySQL は DDL の暗黙コミットのため best-effort 逐次、
  他ドライバは all-or-nothing。

### プロセス管理

`commands/process.rs` の `list_processes` / `kill_process` が、サーバのアクティブな
接続/クエリ (MySQL `PROCESSLIST`、PostgreSQL `pg_stat_activity`) を `ProcessInfo` として
列挙し、選択したプロセス/接続を強制終了します。`list_processes` は読み取り操作なので
読み取り専用セッションでも許可しますが、`kill_process` はサーバ状態を変えるため
読み取り専用セッションを明示的に拒否します (SQL 文ではないので `is_read_only_sql` の
経路外、コマンド側で別途ガード)。SQLite はサーバプロセスを持たないため空を返します。
なお #587 で `performance_schema` 無効時に MySQL のプロセス一覧が空になる問題を修正済み。

### ログシステム

`logs.rs` が `tracing` のイベントを `<data_dir>/noobdb.log` に書き込む**ファイルバックド
ログシンク** (`LogStore` + `MakeWriter` 実装の `LogWriter`) です。総容量 ~1 MiB を
active + backup の 2 セグメントで回し、active が半分に達したら rename してローテートします。
`lib.rs` 起動時に `logs::init()` を呼び、data_dir が取れない環境では stdout のみへ graceful
fallback します。`commands/logs.rs` の `read_logs` / `clear_logs` が設定画面のログビューア
向けに内容 (両セグメント連結) とファイルパスを返し、クリアします。

### ファイル読み込み

`commands/file.rs` の `read_text_file` は、エディタへドラッグ&ドロップされた `.sql` /
`.txt` ファイルをバックエンド経由で読み込むコマンドです。フロントから fs プラグインを
直接叩かず capabilities を最小に保つのが目的で、サイズ上限 8 MiB (`MAX_TEXT_FILE_BYTES`)、
不正 UTF-8 はロッシーデコード、空パス/不存在は拒否します。

### IPC 表面

すべての `#[tauri::command]` は `lib.rs::run()` 内の `invoke_handler!` マクロで
登録されます。現在のコマンド群:

- 接続: `test_connection` / `connect` / `disconnect`
- クエリ: `run_query` / `run_query_transaction` / `run_query_stream` /
  `preview_query_stream` / `cancel_stream`
- 明示的トランザクション: `begin_transaction` / `run_in_transaction` /
  `finish_transaction`
- スキーマ: `list_databases` / `list_tables` / `describe_table` /
  `schema_overview` / `foreign_keys` / `list_indexes` / `list_schema_objects` /
  `get_object_definition` / `table_row_estimates`
- プロセス管理: `list_processes` / `kill_process`
- 比較・同期 (Diff/Sync): `compare_schema` / `compare_table_data` /
  `generate_sync_sql` / `generate_data_sync_sql` / `apply_sync_sql`
- プロファイル: `list_profiles` / `save_profile` / `delete_profile` /
  `export_profiles` / `import_profiles`
- スニペット: `list_snippets` / `save_snippet` / `delete_snippet`
- 履歴: `list_history` / `clear_history`
- ログ: `read_logs` / `clear_logs`
- エクスポート/ダンプ/インポート: `export_query_result` / `export_query_stream` /
  `dump_database` / `parse_csv_preview` / `import_csv`
- ファイル: `read_text_file`

完全なリストは
`src/api/tauri.ts` の `api` オブジェクトにミラーされています (`src/__tests__/
ipcCommandParity.test.ts` が Rust 側登録と `tauri.ts` の対応をテストで突き合わせます)。
**コマンドを追加する
ときは: Rust ハンドラを追加し、`lib.rs` で登録し、`tauri.ts` に型付けされたラッパー
(とストリーミングなら対応する `listen*` ヘルパー) を追加します — これらの間でズレが
発生するとフロントエンドが暗黙のうちに壊れます。** エラーは `AppError` として上に
伝搬し、その `Display` 文字列としてシリアライズされます (`error.rs::Serialize` を
参照)。フロントエンドは reject された Promise の中で `string` として受け取ります。

### テスト専用 API

`lib.rs` は `pub mod __test_api` (`#[doc(hidden)]`) を公開しており、
`src-tauri/tests/` 配下の統合テストが Tauri を経由せずに `db::Connection` の
経路を駆動できるようにしています。`connect`・`parse_mysql_url`・
`parse_postgres_url`・`sqlite_options`・`mysql_exec_text`・`is_read_only_sql`
(ゴールデンベクタ検証用)・`kill_process_inner` (Tauri State 不要のプロセス強制終了)
などを提供します。新しいテスト用エントリポイントが必要な場合は、内部モジュールを
公開するのではなく、ここに追加してください。

### Tauri capabilities

`src-tauri/capabilities/default.json` は意図的に最小限です: ウィンドウ / app /
イベントのデフォルトに加え、`dialog:allow-open` / `dialog:allow-save` のみ。
具体的な必要性がない限り、権限を追加しないでください — フロントエンドはバックエンドの
コマンドを呼び出すべきで、シェルや fs の API を直接叩くべきではありません。

### フロントエンド構成 (`src/`)

UI は Chakra UI に全面移行済み (#271)。ルートは `App.tsx`、Chakra システム設定は
`theme.ts`、実行時アクセント色は `accent.ts`、アニメーションは `motion.ts` が司ります。

- `App.tsx` — 全体のシェル。タブ (table / query / explain)、接続状態、ストリーミング
  購読、インラインセル編集 (`components/cellEdit.ts`)、テーマを束ねるルート。
- `api/tauri.ts` — 全 IPC の型付きラッパーとイベント購読ヘルパー (上述)。各 `invoke`
  ラッパーは `api/schemas.ts` の **zod スキーマ**でレスポンスを実行時検証し、Rust の
  serde 構造体と TS 型のズレを早期検出します (未知フィールドは破棄で前方互換)。
- `components/` (接続・クエリ) — `ConnectionList`/`ConnectionForm` (接続)、`QueryEditor`
  (CodeMirror 6 + スキーマ補完)、`QueryBuilder`、`ResultGrid`/`PreviewGrid`
  (TanStack Table)、`TabBar`、`HistoryList`、`SnippetList`/`SnippetForm`、
  `ExportModal`/`DumpModal`/`ImportModal`、`ExplainViewer`、`SettingsView`、
  `HelpView`、`DangerousQueryDialog`、`CellValueViewer`、`ERDiagramView`
  (`@xyflow/react` + `@dagrejs/dagre` による ER 図。レイアウト/グラフ構築の純ロジックは
  `erDiagram.ts` に分離してテスト)。
- `components/` (発展機能) — `ChartView` (結果のグラフ化。チャートライブラリ非依存で
  SVG 描画、純ロジックは `chartData.ts`)、`CommandPalette` (Cmd/Ctrl+K の横断検索。
  `commandPaletteSearch.ts`)、`ObjectSearchModal` (スキーマ全体のオブジェクト検索。
  `objectSearch.ts`)、`ParameterInputModal` (`{{name}}` プレースホルダのパラメータ化
  クエリ。`queryParams.ts` が型別に安全なリテラル/識別子へ展開)、`BatchResultsView`
  (複数文スクリプトのバッチ実行結果。文分割は `sqlScript.ts`)、`CreateTableModal`
  (CREATE TABLE ウィザード。`createTable.ts`)、`RowInsertModal` / `RowInspector` /
  `RenameTableDialog` (行追加・行インスペクタ・テーブル名変更)、`SchemaCompareView`
  (スキーマ/データ比較 → 同期 SQL 生成 UI。バックの Diff/Sync コマンドを駆動)、
  `ProcessListPanel` (プロセス監視・KILL。`processList.ts`)、`ProfileImportDialog`
  (プロファイルインポートの ID 衝突解決)、`ShortcutCheatSheet` (`?` キーのチートシート。
  `shortcuts.ts` が単一ソース)、`TitleBar` (Tauri `decorations: false` のカスタム
  ウィンドウクローム。色決定は `titleBarContext.ts`)。
- セル整形ユーティリティ — `cellTypeMeta.ts` (カラム型を 9 種の `CellKind` へ分類)、
  `cellFormat.ts` (JSON コンパクト表記・日時のロケール整形。**表示専用**で実値は不変)、
  `cellConditionalFormat.ts` (データバー/ヒートマップ。表示専用。色は下記
  `colorScale.ts` を参照)。
- データ可視化カラースケール (#525) — `colorScale.ts` が、データを色で符号化する表面
  (チャート系列・ヒートマップ・データバー・将来のコスト/NULL 率ミニバー) が共有する
  **単一のスケール体系**を純ロジックとして定義する。**sequential** (単一色相の連続、CB
  セーフ) / **categorical** (CB 配慮の順序付き離散色、チャート系列用) / **diverging**
  (中央が淡い発散) の 3 系統と、値 → 色の純関数 (`sampleRamp` / `categoricalColor`) ・
  塗り面上の可読インク (`readableInk`) を公開する。`ChartView` と
  `cellConditionalFormat.ts` はここを参照し色を二重定義しない (`colorScale.test.ts` が
  最小/最大/NaN などの境界を固定)。`ChartView` の系列描画/出現アニメーションは
  `motion.ts` の共有プリセットに沿い、reduced-motion で自動抑制される (#526)。
- 結果グリッドの分析サマリ — `gridStats.ts` (#523/#524)。`selectionSummary` が矩形範囲
  選択セルの件数/非NULL数/数値数/合計/平均/最小/最大を集計し `ResultGrid` の
  ステータスバーへ表示 (#523)。`columnStats` が在メモリ (取得済み行) の列値から件数/
  NULL率/DISTINCT/数値レンジ/文字列長/代表値を計算し、ヘッダーメニューの「列の統計」
  ポップオーバー (`ColumnStatsMenu`) へ表示 (#524)。`buildColumnStatsSql` がドライバ方言で
  識別子をクオートした全件集計 SQL を生成し、`parseFullColumnStats` が単一行結果を位置で
  構造化する (全件集計ボタンは `App` から `api.runQuery` を束ねた `onRunStatsQuery` が
  渡るときだけ出る)。すべて副作用なしの純関数で `gridStats.test.ts` がテスト。数値化は
  `cellConditionalFormat.toNumber` を共有。
- 基盤モジュール — `shortcuts.ts` (全ショートカット定義の単一ソース)、`keyboardNav.ts`
  (`useFocusTrap` / `useRovingFocus` / `useReturnFocus` の a11y フック)、
  `tableQuickAccess.ts` (お気に入り + 最近使ったテーブルを localStorage 永続化)、
  `queryHistoryNav.ts` (エディタの ↑/↓ 履歴ナビ)、`clipboard.ts`、
  `tableMaintenance.ts` (TRUNCATE/DROP/RENAME の方言別 SQL 生成)、`rowEstimate.ts`
  (`~1.2K` 形式の概算行数表示)。
- `settings.ts` — `useSyncExternalStore` ベースの設定ストア。シンタックスカラー
  (`syntaxColors` light/dark)・プレビューハイライト色・表示行数 (`defaultDisplayCount` /
  `streamPrefetchSize`)・自動 LIMIT (`autoLimitEnabled` / `autoLimitCount`)・本番接続確認
  (`confirmProductionConnect`)・危険クエリ確認 (`confirmDangerousQueries`)・新規タブ実行
  (`resultsInNewTab`)・タブ復元 (`tabRestoreMode`)・クエリタイムアウト
  (`queryTimeoutSecs`)・フォントサイズ (`fontSizePx`) / フォントファミリ
  (`monoFontFamily` / `uiFontFamily`)・アクセント色 (`accentColor`)・UI 密度
  (`density`)・自動リフレッシュ間隔 (`autoRefreshDefaultSecs`)・グリッド表示モード
  (`resultGridMode` scroll/paginate, `resultGridPageSize`)・セル編集の blur 挙動
  (`cellEditOnBlur`)・リッチセル描画 (`richCellRendering`)・テーマプリセット
  (`themePreset` default/dracula/high-contrast/colorblind。後者 2 つは light/dark
  追従でアクセシビリティ向け。#558) などを保持します。
- `dangerousSql.ts` — WHERE なし UPDATE/DELETE・DROP・TRUNCATE を検出する
  フロント側の安全網 (バックエンド `is_read_only_sql` と同じくリテラル/コメントを
  マスクするベストエフォート判定)。`DangerousQueryDialog` の確認に使われます。
- `i18n.ts` — 日本語/英語の文字列テーブルと `useT` フック。
- `tabPersistence.ts` — プロファイルごとの開きタブを localStorage に保存/復元。
- `errorHints.ts` — DB エラー文字列を人間向けのヒントに対応付け。
