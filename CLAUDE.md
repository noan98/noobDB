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

CI は 2 つのワークフローに分かれています:

- `.github/workflows/ci.yml` — `main` への PR と `main` への push で起動。
  push トリガは**キャッシュを main スコープへ保存するため**にあります:
  pull_request 実行で保存される rust-cache / sccache / pnpm のキャッシュは PR の
  マージ ref スコープにしか残らず他の PR から参照できないため、main push 時に同じ
  ジョブを走らせて全 PR ブランチがフォールバック復元できる main スコープを温めます
  (これが無いと新規 PR ブランチの初回 Rust ビルドは毎回コールド)。マージ後の main
  の健全性確認も兼ねます。`dorny/paths-filter` で
  変更領域 (frontend / rust / workflow / crosslang) を判定し、ジョブ単位の `if:` で
  出し分けします (ワークフロー丸ごとスキップにすると必須チェックが「待機中」で固まるため、
  ジョブを skip させる方式。push イベントでは paths-filter が git 履歴比較を行う
  ため `changes` ジョブは checkout してから filter を実行します)。`frontend`
  ジョブ (チェック名 `frontend (build + browser tests)`) は
  typecheck/build・実ブラウザでの描画/ビジュアル回帰テストの両方を 1 ジョブに
  まとめています (#908。旧来は `frontend` / `frontend-visual` の 2 ジョブに分かれて
  いましたが、両ジョブが独立して `pnpm install --frozen-lockfile` を実行し Vite の
  依存プリバンドルも別個にコールドスタートしていた重複 — Rust ジョブ側の同型の
  重複を解消した #796 の横展開対象 — を統合で解消しました。詳細な判断根拠は
  `ci.yml` の `frontend` ジョブ直前のコメントを参照)。ジョブ本体は
  `pnpm run build` に続けて
  `pnpm run bundle-size` (バンドルサイズ計測 → Job Summary。#443)、`pnpm run knip`
  (未使用エクスポート/到達不能コード検出。#470)、`pnpm test --coverage` (Vitest
  jsdom + カバレッジ閾値)、さらに `pnpm exec playwright install` +
  `pnpm test:browser` (Vitest ブラウザモード。#306) を順に実行します。
  バンドルサイズはカバレッジと同じく当面は閾値による fail を設けず可視化のみで、
  `dist/` の JS/CSS の gzip 後サイズを Node 標準の zlib だけで集計します
  (`scripts/bundle-size.mjs`、size-limit 等の追加ツールは増やしません)。pnpm は
  各ジョブで `corepack enable` により用意し、`pnpm`
  ストアを `actions/cache` でキャッシュします (`actions/setup-node` の `cache: npm`
  は使いません)。`frontend` ジョブは加えて Vite の依存プリバンドルキャッシュ
  (`node_modules/.vite`) と Playwright の Chromium バイナリ (`~/.cache/ms-playwright`)
  も `actions/cache` でブランチ跨ぎに温めます (#908。ブラウザテスト側の
  「install/トランスパイル部」の壁時計短縮が目的で、pnpm store キャッシュと同じ
  パターンでキー付けします)。`paths-filter` は `package-lock.json` ではなく
  `pnpm-lock.yaml` を監視します。**旧チェック名 `frontend (typecheck + build)` /
  `frontend (browser render + visual)` を必須チェックに指定していた場合は、新しい
  `frontend (build + browser tests)` へ設定し直してください** (#908 のジョブ統合で
  チェック名が変わったため)。

  **`crosslang parity` ジョブ (#853)**: `ipcCommandParity.test.ts` (`?raw`
  インポートで `src-tauri/src/lib.rs` を読む) / `ipcArgParity.test.ts` /
  `streamEventParity.test.ts` (いずれも `import.meta.glob` で `src-tauri/src/`
  配下の `.rs` を網羅的に読む。前者は `commands/*.rs` 限定、後者は
  `src-tauri/src/**/*.rs` 再帰。#970) と
  `readOnlyGolden.test.ts` / `errorKindGolden.test.ts` / `errorHintGolden.test.ts` /
  `schemaParity.test.ts` / `sqlQuotingGolden.test.ts` (#880) /
  `exportFormatGolden.test.ts` (#879) (Rust の統合テストと
  共有するフィクスチャ `src/__tests__/fixtures/*.json` を検証する)、および
  `apiReachabilityParity.test.ts` (#907。Rust ソースは読まないが、UI 未到達
  ラッパーの削除は `ipcCommandParity` = Rust 側登録と連動して直す必要があるため
  同じ起動条件で同居させる)、`commandRegistrationParity.test.ts` (#1031。
  `import.meta.glob` で `src-tauri/src/commands/**/*.rs` を再帰的に読み、
  実在する `#[tauri::command] pub (async) fn <name>` を抽出して `generate_handler!`
  登録集合の部分集合であることを検証する。3 点コントラクト
  [`generate_handler!` 登録 ⇔ `tauri.ts` ラッパ ⇔ UI 到達性] のうち
  `ipcCommandParity`/`apiReachabilityParity` が塞がない残る 1 辺
  — 「定義したのに登録し忘れた」死蔵コマンド — を塞ぐ。doc コメント
  [`//` `///` `//!`] 中に `#[tauri::command]` という記法自体が説明文として
  出現する箇所 [`commands/query.rs::run_query_inner` /
  `commands/sync.rs::apply_sync_sql_inner` の直前など] を誤検出しないよう、
  抽出前に行コメントを除去する) は「相手言語のソースを実行時に読む」
  言語横断のパリティ/ゴールデンテストです。これらは元々 `frontend` ジョブの
  `pnpm test` に含まれていたため `frontend==true` (`src/**` の変更) でしか走らず、
  `src-tauri/**` のみを変更する PR ではまさにその変更を捕まえるべきテストが
  1 本も実行されないという穴がありました (#853)。対応として、対象ファイルだけを
  `pnpm vitest run <files...>` でピンポイントに実行する軽量な専用ジョブ
  `crosslang parity` を新設しました。**起動条件は
  `(rust==true && frontend!=true) || workflow==true` です** (#1029。新設時点
  (#853) は `frontend==true || rust==true || workflow==true` でしたが、この
  ジョブが実行する 11 本の Vitest ファイルは `frontend` ジョブの
  `pnpm test --coverage` (Vitest 全スイート) にも既に含まれているため、
  `frontend==true` の PR (`src/__tests__/fixtures/**` ⊂ `src/**` なのでフィクスチャ
  のみの PR も該当) では `frontend` ジョブが直前に実走した 11 本を、このジョブが
  独自の checkout/setup-node/`pnpm install --frozen-lockfile` を挟んで別ランナーで
  再実行するだけの純粋な重複になっていました。このジョブの存在意義は「`frontend`
  ジョブが走らない rust 専用 PR の穴埋め」なので、`frontend==true` はその正当化の
  範囲外として起動条件から外し、`rust==true && frontend!=true` (rust 専用差分) と
  `workflow==true` (このワークフロー自身の変更は常に検証) に絞りました。カバレッジは
  次の 4 経路で不変です: `src/**` のみの変更は `frontend` ジョブがカバー、
  `src-tauri/**` のみの変更は本ジョブがカバー、`src/__tests__/fixtures/**` のみの
  変更はフィクスチャが `src/**` の部分集合なので `frontend` ジョブがカバー
  (Rust 側は次段落の `crosslang` フィルタが別途カバー)、ワークフローファイルのみの
  変更は `workflow==true` により本ジョブが常に実走します。逆方向
  (Rust 側のゴールデンテスト `serde_schema_parity.rs` / `read_only_golden.rs` /
  `error_kind_golden.rs` / `error_hint_golden.rs` / `sql_quoting_golden.rs` /
  `export_format_golden.rs` が `include_str!` で読む共有
  フィクスチャだけを変更する PR で `rust (test)` がスキップされる問題) は
  `changes` ジョブに追加した `crosslang` フィルタ (`src/__tests__/fixtures/**`
  限定) を `rust (test)` の `if:` へ OR で足すことで塞いでいます (#1029 でも
  変更していません)。**必須チェックを設定する場合はこの `crosslang parity`
  ジョブも対象に含めてください。**

  Rust 系は 6 つのジョブに分かれます: `rust (clippy)` が
  `cargo clippy --all-targets --locked -- -D warnings` (clippy が rustc ドライバ
  として型チェックを内包するので別途 `cargo check` は走らせません)、`rust (test)`
  が MySQL 8 と PostgreSQL 16 のサービスコンテナに対し `cargo llvm-cov nextest`
  (カバレッジ計装下で nextest を実走) を実行します。起動条件は通常の
  `rust==true` に加え、上述の `crosslang` フィルタ (`src/__tests__/fixtures/**`)
  も OR で見ています (#853。フィクスチャのみの変更でも言語横断ゴールデンテストを
  確実に実走させるため)。`rust (test)` は加えて
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
  成果物 (インストーラ + `.sig` + `latest.json`) は**タグと同名の公開済みリリース**へ
  添付されます (`releaseDraft: false`。GitHub UI で先にリリースを公開してタグを
  生成する運用に対応。リリースが存在しないタグ push では公開リリースを新規作成
  するため、リリースノートは後から編集します)。`releaseDraft: true` に戻しては
  いけません — tauri-action は true だと未公開ドラフトしかタグ名で探さないため、
  公開済みリリースがあると成果物が誰にも見えない別ドラフトへ迷子になります
  (v0.8.2 で発生)。`main` への push でもキャッシュ温め目的でビルドが走ります。
  ビルド後の `Report bundle artifact sizes` ステップが、出荷バイナリ (NSIS
  インストーラ・`.exe`、将来の `.dmg` / `.AppImage` / `.deb`) のサイズを Job
  Summary に出力します (#549)。これは JS/CSS を測るバンドルサイズ可視化 (#443) の
  **アプリ本体版**で、方針も同じく**当面は閾値で fail させず可視化のみ**
  (カバレッジ #482 と同じ漸進方針)。追加ツールは増やさず `stat` + `awk` の
  シェル標準機能だけで集計し、cache-warm / リリースの両ビルド経路の後に
  `if: always()` で 1 回測ります。macOS/Linux バンドルを追加したら (本 Epic の
  別 Issue) `.dmg` / `.AppImage` / `.deb` のグロブが自動的に対象へ含まれます。
  起動時間の監視は計測の安定性が難しいため本 Issue のスコープ外 (任意/将来拡張)
  としています。
  **キャッシュ温めビルドはパス変更でゲートされます (#919)。** `ci.yml` と同型の
  `changes` ジョブ (`dorny/paths-filter`) を追加し、`rust` (`src-tauri/**`) /
  `frontend` (`src/**` など、`ci.yml` の `frontend` フィルタと同じ集合) の
  いずれも変更されていない**タグ以外の main push** では `build` ジョブ自体を
  skip します — README / CLAUDE.md / 無関係な workflow ファイルのみの push で
  90 分タイムアウトの Windows ランナーが浪費されるのを防ぎます。`changes`
  ジョブは push イベントでは git 履歴比較を行うため checkout してから filter を
  実行します (`ci.yml` の `changes` ジョブと同じ配慮、`fetch-depth: 2`)。
  **ゲート対象はキャッシュ温めビルドのみ**で、キャッシュ温めの本来の目的
  (タグビルドの初回コールド回避) を壊さないよう、以下の 3 経路はゲートを完全に
  迂回して常に `build` ジョブを実行します:
  - **タグ push** (`refs/tags/v*`): リリースビルドそのものであり、`changes`
    ジョブは比較対象コミットが無く意味を持たないため、`changes` 自体をこの
    条件で実行しません (`changes` の `if:` で除外)。
  - **`workflow_dispatch`** (手動実行): 明示的な手動トリガの意図を尊重し、
    変更内容に関わらず常にビルドします。
  - **`schedule`** (毎週月曜 03:00 UTC の定期温め): main push の温めビルドは
    paths ゲートのスキップや連続 push の concurrency キャンセルで長期間完走
    しないことがあり、GitHub Actions のキャッシュは 7 日間未アクセスで削除
    されるため、main スコープの rust-cache が失効した状態でタグビルドが毎回
    コールドスタートする退行が実際に起きました (DuckDB #709 の bundled C++
    ビルドが乗った v0.9.x でリリースビルドが 27〜35 分に悪化)。週次の定期
    実行でキャッシュを常に新鮮に保つのが目的なので、変更有無に関わらず
    ビルドします (`changes` は push 限定の `if:` により skip)。
  `build` ジョブの `if:` は `always() && (tag push || workflow_dispatch ||
  schedule || changes.outputs.rust == 'true' || changes.outputs.frontend ==
  'true')` で、`always()` は「`changes` が (タグ/手動実行/schedule で) skip
  されたときに `needs:` の既定動作 (`success()` 相当) で `build` まで連鎖 skip
  されてしまう」のを防ぐためのものです — 実際の実行可否は続く OR 条件が判定
  します。`changes` ジョブが何らかの理由で失敗した場合は outputs が空になり
  OR 条件が偽になるため、main push では安全側 (skip) に倒れます。
  **タグビルドでは rust-cache を保存しません (`save-if`)** — タグ ref スコープに
  保存されたキャッシュは main や他のタグの実行から参照できず、同じタグが再実行
  されることも無いため、保存 (~1 分) が純粋な無駄になるからです。タグビルドは
  main スコープのキャッシュを復元のみで利用します。

Linux CI では Tauri 2 のシステムパッケージ (`libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libxdo-dev`,
`libayatana-appindicator3-dev`) が必要です。

### 依存関係の自動更新と脆弱性監査 (#605)

Cargo (`src-tauri/`) / pnpm (フロント) / GitHub Actions の 3 エコシステムで、更新
PR の自動生成と脆弱性の可視化を次のように役割分担しています。追加サービス
(Renovate 等) は導入せず、GitHub ネイティブな Dependabot と既存の cargo-deny /
新設の pnpm audit で完結させています。

- **Dependabot (`.github/dependabot.yml`) — 更新 PR の自動生成**。`cargo`
  (`/src-tauri`)・`npm` (pnpm、`/`)・`github-actions` (`/`) の 3 エコシステムを
  それぞれ `schedule.interval: weekly` で監視します。`groups` は各 `updates` エントリ
  配下に置く構文 (`updates[].groups`) で、`minor`/`patch` 更新を 1 本の PR へまとめ
  (`cargo-minor-and-patch` / `npm-minor-and-patch`) PR ノイズを抑えます (major は
  グルーピング対象外で個別 PR になります)。`cooldown` (`semver-patch-days: 3` /
  `semver-minor-days: 7` / `semver-major-days: 30`) でリリース直後の不安定な
  バージョンを一定期間避けます。`open-pull-requests-limit: 5` で同時オープン数を
  抑制。**自動マージ**は本設定固有の仕組みではなく、`.github/workflows/automerge.yml`
  (CI 成功 + 未解決レビュースレッド 0 件を条件にする汎用の自動マージ) が Dependabot
  PR を含むすべての適格な PR に対して既に機能しており、実績として多数の Dependabot
  PR (`dependabot/cargo/...` 等) がこの経路でマージされています。
- **cargo-deny (`ci.yml` の `rust (deny)` ジョブ) — Rust 依存のライセンス +
  脆弱性ゲート**。依存ライセンスの許可リスト検査に加え、RustSec Advisory DB による
  既知脆弱性チェックを **PR ごとに強制**します (fail する)。設定は
  `src-tauri/deny.toml`。詳細は上記 CI セクションを参照。
- **pnpm audit (`.github/workflows/audit.yml`) — フロント依存の脆弱性可視化**。
  cargo-deny に対になるフロント側の仕組みが無かったため新設しました。
  `schedule: cron` (毎週月曜) + `workflow_dispatch` で定期実行し、`pnpm audit` の
  結果を Job Summary に出力します。pnpm は既存 CI と同じく `corepack enable` で
  用意します。バンドルサイズ (#443) ・カバレッジ (#482) と同じ漸進方針で、
  **当面 fail させず可視化のみ**とし (`|| true` で吸収)、PR ごとではなく週次
  スケジュールにしているのは、依存を変更しない PR でも毎回外部の npm advisory DB
  に問い合わせるコストを避けるためです。

### CodeRabbit レビューゲート (#1055)

PR のレビュー層は CodeRabbit が担い、`.github/workflows/` の 3 ワークフローが
連携します。**CodeRabbit はこのリポジトリでは自動レビューを行いません** — star 数が
閾値 (10) 未満の OSS リポジトリは対象外という CodeRabbit 側の仕様で、PR には毎回
「This repository does not receive automatic reviews because it has fewer than 10
stars」というサマリコメントが付き、コミットステータスも
`Review skipped: manual review required for this OSS repository` で **success** に
なります。

この「恒久 skip」は、レートリミットによる一過性の skip と**まったく別物**です。
以前はどちらも `skip review by coderabbit.ai` という同じマーカーで表現されるため
`automerge.yml` が一括りに「待っても進まないので通す」と判定しており、結果として
**レビューが 1 度も行われないまま自動承認 → 自動マージまで通り、しかもその事実が
パイプライン上のどこにも異常として現れませんでした** (#1055。#1042〜#1050 が
この状態でマージされています)。現在は次の 3 段構えで解消しています。

- **`coderabbit-request-review.yml` (新設) — レビューの明示起動**。coderabbitai[bot]
  のサマリコメントに `skip review by coderabbit.ai` マーカーを検出したら、その PR の
  現在の head SHA に対して `@coderabbitai review` を **1 回だけ**投稿します
  (CodeRabbit 自身が案内している正規の回避手段)。重複と無限ループの抑止は
  `coderabbit-fallback-approve.yml` と同じく、投稿本文へ head SHA 入りの識別タグ
  `<!-- coderabbit-request-review: <sha> -->` を埋める方式です。push で head が
  進めば新しい SHA として再度 1 回だけ起動します。CodeRabbit の設定変更や star 数の
  増加で自動レビューが復活したら、skip マーカーが出なくなるので自然に無効化されます。
- **`automerge.yml` の Step 5a — 待機と可視化**。skip 宣言を検出したら、まず現在の
  head に対する CodeRabbit のレビュー提出を確認し、あれば skip フラグを下ろして
  通常経路 (Step 5b/6) へ委ねます。無ければ明示起動の識別タグ付きコメントの作成時刻を
  読み、**猶予時間 `CR_REVIEW_GRACE_SECONDS` (1200 秒 = 20 分) 以内なら待ちます**。
  猶予を過ぎた場合、またはそもそも明示起動が記録されていない場合は、**マージは
  継続しますが** `::warning::` アノテーションと Job Summary に「レビューゲートが
  素通りしています」を出力します (黙って通さない)。マージを止めない理由は、
  レビュー起動が何らかの理由で失敗し続けると自動マージが恒久停止するためで、
  バンドルサイズ (#443) ・カバレッジ (#482) と同じ「まず可視化」の漸進方針です。
- **`coderabbit-fallback-approve.yml` の条件 4 — レビュー未実施 PR を承認しない**。
  投稿条件だった「CodeRabbit のステータスが SUCCESS」「未解決スレッドが 0 件」は、
  **レビューが 1 度も行われていない PR でも自動的に満たされます** (上記のとおり
  status は success、スレッドは 1 件も作られないので 0 件)。本ワークフローが本来
  想定しているのは「CodeRabbit が指摘を出し、全スレッドを解決したのに自発的に
  Approved を出さない」ケースなので、**CodeRabbit のレビュー提出が 1 件も無い PR
  では承認を投稿せず、警告だけ残して抜けます**。head SHA との一致までは要求しません
  — 指摘を受けて修正を push した直後は最新 head へのレビューがまだ無いのが正常で、
  本来の用途を壊すためです (head へのレビュー提出待ちは `automerge.yml` の Step 5b が
  担います)。

**`skip review` マーカーの扱いを変更するときは 3 ファイルを揃えて見直してください。**
`automerge.yml` のコメントが述べる前提と実際の挙動が食い違うと、#1055 と同じ
「気付けない」状態に戻ります。

### ビルド高速化

ローカルと CI の Rust ビルドを速くするための設定をいくつか入れています。

- `src-tauri/Cargo.toml` の `[profile.dev]` で `debug = "line-tables-only"` を
  指定し、dev ビルドの debuginfo を行テーブルのみに削減しています。リンク時間が
  減り dev ビルドの反復が速くなる一方、バックトレースのファイル:行情報は維持され
  ます。ツール導入不要で全環境に効きます。
- `[profile.release]` は **`lto = "thin"` + `codegen-units` 既定**です。以前の
  `lto = "fat"` + `codegen-units = 1` は依存ツリー全体 (DuckDB #709 の bundled
  静的ライブラリを含む) を単一単位で再最適化するため、最終コンパイル + リンクが
  rust-cache でキャッシュできない毎回の固定コストとしてリリースビルド (タグ
  ビルド 30 分超) を支配していました。本アプリは処理の大半が DB I/O 待ちで
  fat LTO の実行時性能メリットは計測困難な一方、thin LTO でもクレート跨ぎの
  インライン化はほぼ得られます。バイナリサイズの微増は release.yml の出荷
  バイナリサイズ可視化 (#549) で追跡します。**fat に戻す変更はビルド時間との
  トレードオフを必ず再計測してから**にしてください。
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
  **`main` を選んで実行しないでください** — main はリポジトリルールで直接 push が
  禁止されている (`Changes must be made through a pull request`) ため、
  スクリーンショットの生成まで成功しても最後のコミット push で必ず失敗します
  (`GH013`)。見た目を変える**作業ブランチ上で**実行し、生成されたベースラインを
  その変更と同じ PR (または後追いの PR) でマージしてください。
- CI では `ci.yml` の **`frontend` ジョブ (チェック名 `frontend (build + browser
  tests)`)** が、jsdom 単体テスト等の後続ステップとして Playwright の Chromium を
  導入して `pnpm test:browser` を実行します。旧来は jsdom 側と別ジョブ
  (`frontend-visual`) でしたが、pnpm install・Vite トランスパイルの重複を解消する
  ため 1 ジョブに統合しています (#908。詳細は前掲の CI セクションと `ci.yml` の
  コメントを参照)。現状はスモークのみが走り、ビジュアル回帰はベースライン整備後に
  `VITE_RUN_VISUAL=1` で有効化する想定です。**必須チェックを設定する場合はこの
  ジョブ名 (`frontend (build + browser tests)`) を指定してください** (旧
  `frontend (typecheck + build)` / `frontend (browser render + visual)` は
  #908 で消えています)。
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

noobDB は MySQL / PostgreSQL / SQLite / Microsoft SQL Server (#729) に対応した
軽量デスクトップ DB クライアントで、SSH トンネルをファーストクラスでサポートします。
Rust バックエンド (`rust-version` 1.77、edition 2021) は `sqlx` 0.9 (`tls-rustls`、
MySQL/PostgreSQL/SQLite の 3 ドライバが使う)、MSSQL 専用の `tiberius` 0.12、
`russh` 0.61、`keyring` 3 などに依存しています。

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

#### `setup` フックでは `tokio::spawn` を使わないこと

`lib.rs::run()` の `.setup(...)` フックは、Tauri がイベントループの `Ready`
ハンドラ (= **メインスレッド**) から呼び出します (`tauri::app::setup`)。ここには
**Tokio ランタイムのコンテキストが入っていません** — Tauri は `setup` を
`async_runtime::block_on` で包まないためです。したがって `setup` の中で
`tokio::spawn` / `tokio::time` などスレッドローカルのランタイムハンドルを要求する
API を呼ぶと `there is no reactor running, must be called from the context of a
Tokio 1.x runtime` で **panic** します。**`setup` から常駐タスクを起動するときは
`tauri::async_runtime::spawn` を使ってください** (グローバルランタイムのハンドルへ
直接投げるためランタイム外から呼んでも安全。投入後のタスク内では通常どおり
`tokio::spawn` / `tokio::time::sleep` が使えます)。IPC コマンドハンドラ
(`#[tauri::command] async fn`) は Tauri の非同期ランタイム上で実行されるため、
そちらでの `tokio::spawn` は従来どおり問題ありません (`commands/query.rs` などの
ストリーミング経路)。

この panic は**ウィンドウ生成の後**に起きます (`tauri::app::setup` は設定ファイルの
ウィンドウを先に build してからユーザの `setup` を呼ぶ) — 症状は「真っ白なウィンドウが
一瞬表示された直後にプロセスが終了」で、リリースビルドは
`windows_subsystem = "windows"` によりコンソールを持たないため panic メッセージも
表示されません (v0.9.0 のインストール後クラッシュの原因)。`tracing` のログにも
残らないため、`<data_dir>/noobdb.log` は `noobDB starting` で途切れます。回帰テストは
`tasks/scheduler.rs` の `spawn_detached_works_outside_a_tokio_runtime` (素の
`#[test]` = ランタイム外から呼ぶことで本番と同じ条件を再現) が固定しています。

### ドライバのディスパッチ: `enum Connection`

DB レイヤは意図的に手書きの enum で実装されており、トレイトオブジェクトではありません。
`src-tauri/src/db/mod.rs` の `db::Connection` は `MySql` / `Postgres` / `Sqlite` /
`Mssql` の 4 バリアントを持ち (`Mssql` だけ `Box<mssql::MssqlConn>` — `tiberius::Client`
が sqlx の他 3 ドライバよりずっと大きく `clippy::large_enum_variant` に当たるため)、
各操作 (`execute`, `begin_transaction` / `execute_in_transaction` /
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
(MySQL `PROCESSLIST` / PostgreSQL `pg_stat_activity` / MSSQL `sys.dm_exec_sessions`
+ `sys.dm_exec_requests` / `KILL <spid>`) もこの enum 表面の一部で、SQLite では多くが
サーバ機能非対応のため空や no-op で短絡します。

**MSSQL ドライバ (`db/mssql.rs`、#729) は他 3 ドライバと異なり sqlx を使いません**
(sqlx に MSSQL バックエンドが無いため)。代わりに素の TDS クライアント `tiberius` を
直接使い、コネクションプールも `sqlx::Pool` ではなく本モジュール内に手書きの極小プール
(`MssqlPool` — `std::sync::Mutex<Vec<Client>>` の idle リスト + `tokio::sync::Semaphore`
で同時接続数を制限。同期 Mutex を使うのは `PooledConn` の `Drop` から async を経由せずに
接続をプールへ返せるようにするため) を実装しています。エラー型も `AppError::Sqlx` では
なく専用の `AppError::Mssql(#[from] tiberius::error::Error)` です。他ドライバとの主な
差分:

- **スキーマ introspection は `dbo` スキーマに限定**しています。MSSQL は 1 データベース
  内に複数スキーマを持てますが、既存の「1 データベース = 1 名前空間」という他ドライバの
  抽象 (sync/export/import が生成する識別子はすべて単一パート想定) を崩さないための
  意図的なスコープ縮小です (`db/mssql.rs` のモジュール doc に詳細)。フロント側の
  `db.table` 参照もすべて `db.[dbo].table` の 3 パートで組み立てます
  (`cellEdit.ts`/`QueryBuilder.tsx`/`tableMaintenance.ts`/`createTable.ts` の
  `qualified`/`qualifiedTableRef`/`tableRef`/`qualifiedName` を参照)。
- **識別子クオートは `[ident]`** (`db::sync::quote_ident` の `DriverKind::Mssql` 分岐、
  フロントは `sqlDialect.ts::quoteIdentFor`)。**自動 LIMIT は `TOP (n)`** を
  `SELECT [DISTINCT]` の直後に挿入する専用実装 `db::apply_auto_limit_mssql`
  (`db::apply_auto_limit_for` がドライバで振り分け) — `WITH` (CTE) は対象外
  (「型を惑わせるより何もしない」方針、doc 参照)。フロントの `QueryBuilder.tsx` も
  同じ TOP 方式で生成する。
- **`server_metrics` / `query_stats_support` (ライブクエリ・インスペクタ) /
  `unused_indexes` は未実装**(SQLite と同じ `unsupported_driver` 縮退)。`dump_database`
  も未対応 (`commands/dump.rs` が `InvalidInput` を返す)。いずれも本 Issue の受け入れ
  条件の範囲外 — 将来 `sys.dm_exec_*` 系 DMV で実装可能。
- **手書きプールは「疑わしい接続を絶対に返さない」方針**。`PooledConn` の `Drop` は
  既定でアイドルリストへ接続を戻すため、失敗した操作の後にそのまま返すと壊れた TCP
  ソケットが次の無関係なリクエストへ配られます。そこで fallible な操作は
  `unwrap_or_discard` / `rows` / `exec` などのヘルパ経由に統一し、エラー時は必ず
  `mark_discard()` します (I/O エラーと SQL エラーを tiberius のエラー型から確実に
  見分けるのは難しいので、**迷ったら捨てる** — 接続 1 本のコストの方が小さい)。
  `execute_stream` / `preview_execute_with_limit` / `import_rows` は逆に
  **先に discard を立て、最後まで読み切って成功したときだけ `unmark_discard()`** し
  ます。この形なら `cancel_stream` の abort やタイムアウトで future が drop された
  場合も自動的に discard 扱いになり、**未消費の結果セットを抱えた接続**がプールへ
  戻りません (tiberius は読み切っていない `QueryStream` があると次のクエリの前に
  残りを flush するため、放置すると次の呼び出し元がそのツケを払います)。例外は
  `probe_failing_row` の行単位 INSERT 失敗で、これは想定内のデータエラーであり接続
  破損の証拠ではないので discard しません。
- **統合テストは `tests/mssql_integration.rs`**、`NOOBDB_TEST_MSSQL_URL`
  (`mssql://user:pass@host:port/db`) 環境変数ゲート (未設定ならスキップ)。CI の
  サービスコンテナは未追加 (ローカル/手動実行のみ、他ドライバと同じ導入パターンを
  踏襲すれば追加可能)。

`db::types::{Value, Column, QueryResult, TableColumnInfo, TableSchema,
PreviewResult, StreamBatch}` がドライバ横断のワイヤフォーマットです。`Value` は
`#[serde(untagged)]` なので、JSON では直接プリミティブとして見えます。BLOB は
JSON で安全に扱えるよう 16 進エンコードした文字列 (`Value::Bytes`) になります。
各ドライバの `decode_cell` 系では型に応じた明示的なデコードを行っています — カラム型を
追加する際は「型付きで試して失敗したら String にフォールバック」というパターンに
従ってください。

**64bit 整数は「JS の安全整数」を境に表現が変わります。** `Value` は
`#[serde(untagged)]` なので `Int`/`UInt` は JSON の素の数値としてシリアライズされ、
フロントの `JSON.parse` で IEEE754 倍精度の `number` になります。したがって
`Number.MAX_SAFE_INTEGER` (2^53-1) を超える整数はそのまま返すと**丸められて別の値に
なり**、表示・コピー・エクスポートが静かに誤るだけでなく、インラインセル編集が
丸めた値で `WHERE pk = ...` を組み立てるため**意図しない行を書き換えうる**。これを
避けるため、全ドライバの整数デコードは `Value::from_i64_lossless` /
`from_u64_lossless` / `from_i128_lossless` / `from_u128_lossless` (`db/types.rs`) を
通し、安全整数の外は十進文字列 (`Value::String`) にします (DECIMAL/NUMERIC が桁あふれ
時に文字列へ退避するのと同じ方針で、フロントの `cellEdit.ts` もこの前提で書かれて
います)。**新しい整数型の分岐を足すときは必ずこのヘルパを経由してください。**

**PostgreSQL のデコードは「非 NULL の値を `Value::Null` にしない」ことを不変条件と
します。** sqlx の通常の `try_get` は型互換チェックを通すため、`String` が受け付ける
TEXT/VARCHAR/BPCHAR/NAME/UNKNOWN/citext 以外 (uuid・配列・inet/cidr・macaddr・money・
interval・ユーザ定義 ENUM・ドメイン型など) は失敗し、`Vec<u8>` も BYTEA 以外は失敗
するため、素朴なフォールバックだと**実データが NULL として返り**ます。表示が消える
だけでなく、`db/data_diff.rs` の比較で両側とも `Null` になり Diff/Sync とサンドボックス
書き戻しが実差分を見逃します。`postgres.rs::decode_cell` は UUID・配列・INET/CIDR・
MACADDR・MONEY・INTERVAL・BIT/VARBIT・TID(`ctid`)・OID 系に明示分岐を持ち、最終
フォールバックは型互換チェックを飛ばす `try_get_unchecked`(String → 失敗時 `Vec<u8>` を
16 進) にして、**SQL NULL のときだけ `Value::Null`** を返します。JSON/JSONB は
`serde_json::Value` を経由すると `BTreeMap` でキーが並べ替わるため、生ワイヤバイト
(JSONB は先頭のバージョンバイトを剥がす) をそのまま返してサーバのキー順を保ちます
(MySQL はサーバ側が JSON のキーを正規化するので対象外)。

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

**TLS 統合テスト方針 (#520 の既知ギャップ、#795 で実装)**: `apply_tls` のモード
マッピングとパス正規化 (`non_empty`) は `db/mysql.rs` / `db/postgres.rs` の単体
テストが network 不要でカバーしていますが、実 TLS ハンドシェイク (CA 検証の成功/
失敗) は実サーバが要るため、既存の MySQL/PostgreSQL 統合テストと同じ環境変数ゲート
方式で `src-tauri/tests/tls_integration.rs` に追加しました。ゲートする環境変数は
`NOOBDB_TEST_MYSQL_TLS_URL` / `NOOBDB_TEST_POSTGRES_TLS_URL` (TLS 必須サーバの
接続 URL) と `NOOBDB_TEST_TLS_CA` (両サーバの証明書を発行した CA の PEM パス、
共通) の 3 つで、いずれか欠けている対応するテストはスキップされます。カバーする
観点は各ドライバにつき: `ssl_mode=require` での接続成立、`verify_ca`/`verify_full` +
正しい CA での接続成立、`verify_full` + CA 未指定 (システムのトラストストアには
自己署名 CA が入っていないため検証失敗) で `AppError` がエラーとして表面化する
こと (`connect` の戻り値は常に `Result<Connection, AppError>` なので `Err` である
こと自体が確認になる)。

**CI 配備 (`ci.yml` の `rust (test)` ジョブ) — 既存サービスコンテナとは別に TLS
必須の DB を独立して立てる方式を採用**: `scripts/ci-setup-tls-db.sh` が openssl で
自己署名 CA + サーバ証明書 (SAN に `127.0.0.1`/`localhost`) を生成し、
mysql-server/postgresql (ubuntu-latest ランナーに既定でプリインストール済み) を
**別ポート (3307/5433)** に TLS 必須 (`require_secure_transport=ON` /
`hostssl ... scram-sha-256` のみ許可) で起動して、上記 3 環境変数を `$GITHUB_ENV`
へ書き出します。既存の MySQL 8 / PostgreSQL 16 サービスコンテナ (3306/5432、平文)
はそのまま維持し、TLS インスタンスは完全に独立した並存構成です。

この方式を選んだ理由 (サービスコンテナの `services:` ブロックへ直接 TLS を組み込む
案との比較): GitHub Actions のサービスコンテナは**ジョブの他のどのステップよりも
前に起動する**ため、証明書をジョブ内で生成してからコンテナへ渡す手段が無く (ボリューム
マウントで後から流し込んでも mysqld/postgres は起動時にしか TLS 設定を読まない)、
かつ `services:` の workflow 構文には `command:` (エントリポイント引数の上書き) が
無いため、公式 postgres イメージへ `-c ssl=on -c ssl_cert_file=...` のような起動
引数を渡す手段も存在しません。対して「サービスコンテナに頼らず apt パッケージを
直接構成する」方式は、SSH トンネル統合テスト (#331、`scripts/ci-setup-sshd.sh`) で
既に実績のある同じパターンをそのまま踏襲でき、ローカルでも同一スクリプトで再現・
検証できます。CI ワークフロー本体の変更は「sshd と並列の background ステップ +
`wait:` への合流」1 箇所の追加のみで、既存のサービスコンテナ定義・カバレッジ計装・
ジョブ分割方針には一切手を入れていません (最小侵襲)。MySQL 側は Ubuntu の
AppArmor プロファイルがカスタム datadir/証明書パスを塞ぐことがあるため
`aa-complain` で complain モードに倒しています (プロファイルが存在しない環境では
no-op)。

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

**マスクはドライバごとに切り替えます (#852)。** バックスラッシュを文字列リテラルの
エスケープ文字と見なすのは **MySQL/MariaDB だけ**で、PostgreSQL
(`standard_conforming_strings = on`) / SQLite / DuckDB / MSSQL では `\` はただの
文字です。以前はどのドライバでも MySQL 流のマスク (`backslash_escapes = true`) を
使っていたため、`SELECT '\'; DELETE FROM t; --'` のような入力で「まだ文字列の中」と
誤読し、隠れた `;` も `delete` も見えないまま**フェイルオープン**していました
(`is_session_init_sql` だけは先に修正済みで、その判断を残り 3 つの安全網へ横展開した
のが #852)。現在の構成は:

- `mask_for_driver(driver, src)` が `driver_backslash_escapes(driver)` でマスク規則を
  選ぶ。`*_for(driver, ...)` 系の入口 — `is_read_only_sql_for` /
  `has_stacked_statements_for` / `apply_auto_limit_for` / `classify_write_kind_for` —
  はすべてこれを通る。呼び出し側 (`commands::query` の
  `ensure_allowed_for_session` / auto-refresh / broadcast ガード、`commands::export`、
  `commands::flight_recorder`、各ドライバの `preview_execute_with_limit`) は
  `session.conn.driver_kind()` を渡す。
- **ドライバを知らない呼び出し口** (`is_read_only_sql` / `has_stacked_statements` /
  `apply_auto_limit` / `classify_write_kind` の引数なし版) は
  `mask_for_analysis_conservative` に倒す。文字列リテラルは MySQL 流マスクより
  **早くしか閉じない**ため、キーワードは隠れず露出する方向 = fail-closed。
  タスクスケジューラ (`commands::tasks::validate_action` / `tasks::executor::run_once`)
  はプロファイル解決前に検証するのでこちら。フロントも同じ方針で、
  `isReadOnlySql(sql, driver?)` / `maskLiterals(sql, driver?)` は driver 省略時に
  保守的な解釈を採る (`components/sqlDialect.ts` のヘルパが未知ドライバを MySQL 扱い
  するのとは**逆**なので注意)。

**MSSQL のロック系テーブルヒント (#906)。** 他ドライバの `FOR UPDATE` /
`LOCK IN SHARE MODE` を拒否している設計意図 (読み取り専用セッションはロックを取らない)
に合わせ、T-SQL の `WITH (...)` ヒントのうち**共有読み取りより強いロックモード**
(`UPDLOCK` / `XLOCK` / `TABLOCKX`) と**文より長いロック保持期間**
(`HOLDLOCK` / `SERIALIZABLE` / `REPEATABLEREAD` / `READCOMMITTEDLOCK`) を
`has_locking_table_hint` で拒否します。`NOLOCK` / `READUNCOMMITTED` / `READPAST`
(ロックを減らす) と粒度のみのヒント (`ROWLOCK` / `PAGLOCK` / `TABLOCK`) は意図的に
対象外。判定は `WITH (…)` グループの内側に限定するので `updlock` という**列名**は
誤検出しません (入れ子括弧 `INDEX(0)` も追跡し、JOIN の 2 つ目のテーブルに付いた
ヒントも拾います)。全ドライバに適用します — `WITH (…)` がテーブル参照直後に来る形は
他方言では読み取り専用構文として成立しないため誤検出の余地が無く、共有ゴールデンの
期待値を文ごとに 1 つに保てるからです。`FROM t (UPDLOCK)` という `WITH` 無しの
レガシー形は既知の非対応 (通常の括弧式と区別できないため)。

**DuckDB のドライバ条件付き許可 (#1005)。** 許可リストの 6 プレフィックス
(`SELECT`/`SHOW`/`DESCRIBE`/`DESC`/`EXPLAIN`/`WITH`) は MySQL/PostgreSQL/SQLite
時代のままで、DuckDB (#709) 追加後の読み取り構文を欠いていたため、同一ドライバ内で
`db/duckdb.rs::is_query_shape` (クエリか実行かのルーティング判定) と `is_read_only_sql_for`
(読み取り専用ガード) が矛盾していました。`is_read_only_sql_masked` に `Option<DriverKind>`
を足して是正しています。**`VALUES (1),(2)` と `TABLE t`** (PostgreSQL/DuckDB/
MySQL 8.0.19+ の `SELECT * FROM t` 短縮形) は書き込みに転じる構文が存在しないため
**全ドライバ**で許可 (ドライバ非依存の呼び出し口も含む)。**`FROM t` 先頭省略構文と
`SUMMARIZE`** は DuckDB 固有の構文なので **DuckDB のみ**許可します。**`PRAGMA`** は
DuckDB でも照会形 (`PRAGMA database_list`) と設定形 (`PRAGMA memory_limit='1GB'`) の
両方があり後者は書き込みに準じるため、DuckDB でのみ、かつマスク後の本文に `=` を
含まない場合だけ許可します (設定形の構文は必ず `=` を伴い、照会形は伴わないという
近似)。SQLite の `PRAGMA foreign_keys=ON` のような設定形は書き込みであり、かつ
SQLite に「照会専用の PRAGMA」という失って困る用途も無いため、**PRAGMA は DuckDB
以外では一切許可しません** (fail-closed)。`is_query_shape` は変更していません
(並行ブランチ #971 が担当) — その結果 `FROM`/`TABLE` は読み取り専用ガードこそ通るように
なりましたが、`is_query_shape` がまだこの 2 語を認識しないため実行は `execute()`
経路 (行を返さない) に落ち、空の結果になる既知のギャップが残っています
(`tests/duckdb_integration.rs` の `duckdb_read_only_session_allows_new_read_only_syntax_via_ipc`
に明記)。フロントは `dangerousSql.ts` の `READ_ONLY_PREFIXES_ALL_DRIVERS` /
`READ_ONLY_PREFIXES_DUCKDB` が同じ許可集合をミラーし、共有ゴールデン
(`readOnlySqlVectors.json` の `readOnlyDuckdb` 次元) で両実装の一致を固定しています。

`apply_auto_limit` は、自前で行数を制限していない素の `SELECT` / `WITH ... SELECT` に
自動で `LIMIT n` を付与します。判定は保守的で、迷ったら `None` (ユーザの SQL をそのまま
実行) を返します。単一行集計 (`COUNT(*)` 等) や既存の `LIMIT`/`OFFSET`、ロック句がある
場合は付与しません。`db/mod.rs` の単体テストがこれら 2 関数の挙動を広くカバーしています。
**MSSQL 版 (`apply_auto_limit_mssql`) はトップレベルに `UNION`/`INTERSECT`/`EXCEPT` が
現れたら `None` を返します** — T-SQL の `TOP (n)` は自分が属する `SELECT` にしか効かず、
先頭ブランチだけを制限して残りを素通しするくらいなら何もしない方が安全なため (括弧の
深さを見るのでサブクエリ内の集合演算では諦めません)。

**キーワード許可リストでは原理的に見えない書き込み経路も拒否します。**
`SELECT * FROM OPENROWSET(..., 'UPDATE ...')` / `SELECT dblink_exec(..., 'DELETE ...')` /
`SELECT load_extension('...')` は、文全体が `SELECT` で始まり、実際の書き込み SQL は
**文字列リテラルの中** = マスクで空白化される領域に隠れるため、通常の書き込み
キーワード走査には一切引っかかりません。そこで `openrowset` / `openquery` /
`opendatasource` / `dblink` / `dblink_exec` / `load_extension` を全ドライバ共通で拒否
します (これらが読み取り専用クエリの識別子として正当に現れる可能性は極めて低く、
過検知のコストより見逃しのコストが桁違いに大きいため fail-closed)。

**マスクの前提を崩す設定は入口で塞ぎます。** `driver_backslash_escapes` は
「MySQL では `\` がエスケープ文字」という静的な前提を置くため、セッション初期化 SQL
(`is_session_init_sql`) が `SET sql_mode = 'NO_BACKSLASH_ESCAPES'` を通すとマスクと実
サーバの解釈が乖離します (`... WHERE x = '\' ; DROP TABLE users -- '` をマスクは「全部
文字列の中」と誤読)。そのため `sql_mode` への `NO_BACKSLASH_ESCAPES` 設定は
`InvalidInput` で拒否します。また MySQL の `/*! ... */` は**コメントではなく条件付き
実行構文**なので、マスクは中身を空白化せずキーワード走査の対象として残します
(「マスクされた領域 = 実行されない領域」という安全網の前提を保つため)。

読み取り専用判定は、バックの `is_read_only_sql` とフロントの `dangerousSql.ts`
`isReadOnlySql` で**独立に二重実装**されているため、両者の判定がズレないよう**共有
ゴールデンベクタ**で整合性を継続検証します (#444)。代表的な SQL とその期待値を
`src/__tests__/fixtures/readOnlySqlVectors.json` に 1 ファイルだけ置き、フロントは
Vitest (`readOnlyGolden.test.ts`) で import、バックは統合テスト
(`tests/read_only_golden.rs`) が `include_str!` で読み込んで `__test_api::is_read_only_sql`
に通します。スタック文・ロック付き SELECT・データ変更 CTE・マスク済みキーワードなどの
境界ケースを網羅しており、片方の実装だけ変えてズレるとどちらかのテストが落ちます。
**境界ケースを追加するときはこの JSON に追記**すれば両言語に反映されます。

ベクタは**ドライバ次元**を持ちます (#852)。`readOnly` は標準的な文字列リテラル解釈
(PostgreSQL / SQLite / DuckDB / MSSQL、およびドライバ非依存の呼び出し口) での期待値で、
MySQL のバックスラッシュエスケープ解釈で判定が変わるケースだけ `readOnlyMysql` を
併記します (省略時は `readOnly` と同じ)。MySQL のマスクは標準解釈より多くを文字列内へ
隠すため、`readOnlyMysql` が `readOnly` より厳しくなる (true→false) ことはありません。
両言語のテストは全ドライバでベクタを回し、加えて「MySQL だけ判定が分かれるケースが
最低 1 件は残っていること」も検証します (ドライバ次元の形骸化防止)。

**SQL 識別子引用 / リテラルエスケープも同じ方式で固定します (#880)。** 識別子引用は
Rust の `db::sync::quote_ident` (MySQL/SQLite ドライバの `quote_ident` はこれへ委譲する
薄いラッパー) と、フロントの `components/sqlDialect.ts::quoteIdentFor` /
`components/exportPreview.ts::quoteSqlIdent` に分散し、リテラルエスケープは
`db::data_diff::sql_literal` をフロントの `exportPreview.ts::sqlLiteral` がミラーします。
インジェクション隣接の安全性ロジックが方言分岐ごとコピーされているため、共有ベクタ
`src/__tests__/fixtures/sqlQuotingVectors.json` を `sqlQuotingGolden.test.ts` と
`tests/sql_quoting_golden.rs` の双方へ通して全実装の一致を固定しています (5 ドライバ ×
危険入力: 各方言の引用文字 / バックスラッシュ / NUL / マルチバイト / 非 BMP / 空文字列)。
BLOB だけはフロントが `Value::Bytes` を `Value::String` と区別できない (JSON 上はただの
16 進文字列) ため意図的に食い違い、その差分を `frontend` キーで明記しています。
`cargo-mutants` のスコープにも `src/db/sync.rs` / `src/db/data_diff.rs` を追加済み
(可視化のみ・fail させない既存方針)。

**自動行キャップ (LIMIT/TOP の挿入) も同じ方式で固定します (#990)。** `apply_auto_limit`
は末尾に `LIMIT n` を足す MySQL/PostgreSQL/SQLite/DuckDB 共有パス、`apply_auto_limit_mssql`
は `SELECT [DISTINCT]` の直後に `TOP (n)` を挿入する MSSQL 専用パスで、書き換え方式も
チェックするキーワード集合 (`limit`/`offset`/`fetch` vs `top`/`offset`/`fetch`) も異なる
ため、フロント側の実装が無いままバックのみで両パスの整合を固定する必要があります。共有
ベクタ `src/__tests__/fixtures/autoLimitVectors.json` を `tests/auto_limit_golden.rs` が
`include_str!` で読み込んで `__test_api::apply_auto_limit_for` の 5 ドライバ全てに通します。
各ケースの `expected` はドライバ名 → 期待書き換え結果 (または変更しないことを表す `null`)
のマップで、`FETCH FIRST … ROWS ONLY` (#969 の回帰ケース) / `WITH … SELECT` / `DISTINCT` /
ロッキング句 / 集約のみ / 既存の `LIMIT`・`OFFSET`・`TOP` / 末尾コメント・`;` /
トップレベル集合演算 (`UNION`/`INTERSECT`/`EXCEPT`) での MSSQL の `None` 返しなどを網羅
します。MSSQL は `limit` キーワードを、他 4 ドライバは `top` キーワードをそもそも
チェックしないため、互いの構文が紛れ込んだ入力ではどちらか一方だけが書き換えてしまう
非対称も意図的なケースとして固定しています (#852 の MySQL バックスラッシュマスク差分も
同様に個別ケースで固定)。

**ストリーミング実行器の fetch/execute 経路振り分け (`is_query_shape`) も同じ方式で
固定します (#971)。** `is_read_only_sql` (#444) や `quote_ident`/`sql_literal` (#880)
と異なり、こちらは共有関数ではなく `db/sqlite.rs` / `db/mysql.rs` / `db/postgres.rs` /
`db/duckdb.rs` / `db/mssql.rs` にそれぞれ private (`__test_api` から駆動できるよう
`pub(crate)` へ引き上げ済み) 関数として個別実装されています。5 実装が一致すべき境界
ケース (SELECT/SHOW/DESCRIBE/EXPLAIN/CALL/PRAGMA/SUMMARIZE/VALUES/TABLE の各ドライバ
固有分岐、データ変更 CTE の判定、コメント/文字列リテラル前置) を共有ベクタ
`src/__tests__/fixtures/queryShapeVectors.json` に集約し、`tests/query_shape_golden.rs`
が `include_str!` で読み込んで `__test_api::is_query_shape(driver, sql)` 経由で全ドライバへ
通します。`WITH` 分岐の「主文がデータ変更か」の判定 (`with_cte_is_mutation`) だけは
`db::mysql` に 1 つだけ実装され全ドライバがそのまま共有するため、この部分は原理的に
ドライバ間で割れません (ただし文字列リテラル中のバックスラッシュを方言に関わらず常に
MySQL 流のエスケープとして読む既知の限界があり、フィクスチャの `knownLimitation` /
該当ケースの note に明記しています — #852 のような driver-aware なマスクへの切り替えは
本 Issue のスコープ外。#1051 で追跡)。フロント側に `is_query_shape` 相当の分類ロジックは存在しない
(バックエンドの実行経路振り分け専用) ため、対になる Vitest テストはありません。

**コメント/リテラルのマスキングそのものも同じ方式で固定します (#988)。**
read-only 判定・auto-limit・stacked 検出・危険 SQL 検出・preflight の COUNT
プローブ・flight recorder は、いずれも「まずコメント/リテラルをマスクしてから
キーワード走査する」という同一の土台の上に立ちますが、その土台自体
(バックの `mask_for_analysis_conservative` / `mask_for_driver`、フロントの
`dangerousSql.ts::maskLiterals`) を突き合わせるゴールデンが無く、#444 の
read-only ベクタがたまたま踏む範囲でしか間接的にカバーされていませんでした。
共有ベクタ `src/__tests__/fixtures/maskVectors.json` を `maskGolden.test.ts` と
`tests/mask_golden.rs` の双方へ通して固定します。ドル引用・入れ子/未終端ブロック
コメント (**入れ子は非対応で最初の `*/` で閉じる仕様**、内側の残りが露出する
ことを含めて固定)・二重引用符/バックティック識別子・EOF 直前のバックスラッシュ・
引用符付き識別子内バックスラッシュ・MySQL の `/*! ... */` 条件付き実行構文などの
分岐を網羅します。ドライバ次元 (#852) は `masked` / `maskedMysql` の対で表現し、
`mask_for_analysis_conservative` (ドライバ非依存の呼び出し口) も検証対象です。
本ゴールデンの整備中に **フロント `maskLiterals` の未終端リテラル (EOF まで
閉じ引用符が来ない文字列/識別子) の末尾 1 文字がマスクされずに露出する**バグを
発見し修正しました — `blank(i + 1, j - 1)` が「ループはいつも閉じ引用符の直後で
終わる」前提を置いていたため、EOF に達して `break` を経由せず終了したケースでは
`j - 1` が実際には EOF 直前の実文字の位置を指してしまい、そこだけ空白化されずに
残っていました。修正はループの終了経路 (`closed` フラグ) を見て、閉じていない
場合は `j` まで (実文字を含めて) マスクするようにしています (fail-closed 方向の
修正で、閉じている場合の挙動は変えていません)。

**安全網には「強制レベル」の違いがある点に注意してください。** 同じ「安全網」でも、
バックエンドで強制されるものと、UI 上の確認に留まるものがあります。

- `read_only` (プロファイル) は**バックエンド強制**です。`commands::query` の各
  エントリポイントが `ensure_allowed_for_session` 経由で `is_read_only_sql` を通し、
  `import_csv` も `session.read_only` を拒否します。IPC を直接呼んでも書き込みは
  通りません。
- **緊急クエリ実行モード** (`Session.emergency_write`) は read_only の唯一の
  ランタイム例外です。読み取り専用セッションで緊急対応の書き込みが必要なとき、
  クエリエディタのトグル → **接続先名のタイプ確認** (`ConfirmDialog` の
  `typedConfirmation`、#675 と同じパターン) を経て IPC `set_emergency_mode` で
  有効化すると、`ensure_allowed_for_session` が書き込み文を通します (通過は
  `tracing::warn!` でログに残る)。適用範囲は SQL 実行経路のみで、`import_csv` /
  `apply_sync_sql` / `kill_process` の read-only 拒否は変わりません。フラグは
  `AtomicBool` としてセッション在命中のみ有効で、切断・`reconnect` のセッション
  差し替えで必ずオフに戻ります (フロントの UI ミラー `emergencySessions` も同じ
  タイミングでリセット)。緊急モード中の書き込みは、フロントの実行ゲートが
  `confirm_writes` と同じ毎回の承認ダイアログを要求します。なお有効化の合意
  (名前タイプ) は UI レベルの安全網であり、IPC を直接呼べば確認なしに有効化
  できます — 確実な書き込み禁止には DB 側の権限設定を併用してください。
  読み書き可能なセッションでの有効化要求は `InvalidInput` で拒否されます
  (常時実行テスト: `tests/sqlite_integration.rs` の `emergency_mode_*`)。
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

**`stream_id` はクライアントが指定する値なので、登録は世代トークンで守ります。**
`register_stream` は登録ごとにトークンを発行して返し、`forget_stream(stream_id, token)`
はトークンが一致する登録だけを消します。これが無いと「同じ id を再利用した新しい
タスクの登録を、先に終わった古いタスクの後始末が消す」競合が起き、`cancel_stream` が
`{cancelled: false}` を返す**キャンセル不能なストリーム**が DB 接続や SSH トンネルを
掴んだまま残ります (接続試行側の `register_connect`/`forget_connect` (#684) と同じ
方式です)。

`preview_query_stream` も `run_query_stream` と同じく `query_timeout_secs` を受け取り
`tokio::time::timeout` でレースします。ドライランは読み取り専用セッションからも呼べる
ため、タイムアウトが無いとロック待ちする `UPDATE` のプレビューで接続と行ロックを無期限に
握れてしまいます。

なお、プレビューの before/after スナップショットを組み立てる純粋ロジック
(ユーザの `WHERE` の抽出、BEFORE で捕まえた PK による AFTER の取り直し) は
**`db/preview.rs`** に集約し、MySQL と PostgreSQL が共有します。ここを共有していな
かった頃は PostgreSQL 側だけ「PK 昇順の先頭 N 件」を撮るだけの実装で、対象行が窓の外に
あると diff が「変更なし」に見える取りこぼしがありました。方言差 (ドル引用、
`RETURNING` の切り落とし、`UPDATE ... FROM` / `DELETE ... USING` の失格判定) は
`SqlFlavor` で分岐します。

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

**接続の全体タイムアウト・フェーズ進捗・キャンセル (#684)**: `connect` /
`test_connection` は `attempt_id` と `timeout_secs` を受け取り、`open_connection`
全体を `tokio::time::timeout` で包みます (既定 30s、5〜300s にクランプ。設定
`connectTimeoutSecs`)。超過時は詰まっていたフェーズを含む
`AppError::ConnectTimeout { phase, secs }` (kind `connectTimeout`) を返します。
接続中は `connect-progress:phase` イベントでフェーズ (`tunnel_connecting` /
`tunnel_authenticating` / `db_connecting`) を通知し (`SshTunnel::open_with_progress`
が SSH の接続/認証フェーズを報告)、フロントはフッターにフェーズ表示とキャンセルボタンを
出します。接続タスクは spawn して `AppState.connects` に `AbortHandle` を登録し、
`cancel_connect(attempt_id)` で中断できます (到達不能ホストで数分固まる問題の解消)。
`register_connect` は登録ごとにトークンを発行し、`forget_connect(attempt_id, token)` は
トークンが一致する登録のみ削除します — 同じ `attempt_id` を再利用した新しい試行の
ハンドルを、先に終わった旧タスクが誤って消してキャンセル不能にするのを防ぎます
(#684 レビュー対応)。

ホスト鍵検証は `ssh/handler.rs::ClientHandler::check_server_key` における
**初回信頼方式 (TOFU)** です。known_hosts ファイルは `<data_dir>/known_hosts` で、
1 行 1 エントリの `host:port fingerprint` 形式です。不一致の場合は
`russh::Error::UnknownKey` を返して接続を中断します。

**アプリ内での復旧 (#682)**: 不一致時、`ClientHandler` は新旧フィンガープリントを
共有スロットに記録し、`tunnel.rs` がそれを読んで
`AppError::SshHostKeyMismatch { host, port, expected, actual }` (kind
`sshHostKeyMismatch`。#683 の構造化エラー) を返します。known_hosts の読み書きは
`ssh/known_hosts.rs` に集約し (`list_known_hosts` / `forget_host_key` /
`set_host_key` / `parse` / アトミック書き込み `write_atomic`)、IPC
`list_known_hosts` / `forget_host_key` / `trust_host_key` で公開します。フロントは
接続失敗が `sshHostKeyMismatch` のとき `HostKeyMismatchDialog` (新旧 fingerprint
併記 + MITM 警告 + 「旧鍵を破棄して再接続」) を出し、設定画面の
`KnownHostsPanel` で一覧・個別破棄もできます。サーバ鍵ローテーション時に手編集は不要です
(旧来の手動削除も引き続き有効)。**再信頼はダイアログで承認した fingerprint を
`trust_host_key` で known_hosts に固定してから再接続します** (単なる forget + TOFU
では再接続時に提示された別の鍵まで信頼してしまうため。承認鍵をピン留めすることで、
再接続で別の鍵 = MITM が提示されたら再び不一致として拒否されます。#682 レビュー対応。
メッセージから fingerprint を取れない場合のみ従来の forget + TOFU にフォールバック)。

**`SshHostKeyMismatch` のメッセージ書式も #880 / #988 と同じ方式で固定します
(#1030)。** バック (`error.rs` の `#[error(...)]` テンプレート) がメッセージを
**生成**し、フロント (`parseHostKeyFingerprints`、
`src/components/hostKeyFingerprints.ts`) がそれを 2 本の正規表現で**パース**して
新旧 fingerprint と失敗ホップの `host:port` を復元する、という生成⇔パースの
二重実装が手写しの文字列リテラルだけで繋がっていた穴を埋めます。共有ベクタ
`src/__tests__/fixtures/sshHostKeyMismatchVectors.json` (`{host, port, expected,
actual}` の入力と厳密なレンダリング後メッセージ) を `sshHostKeyMismatchGolden.test.ts`
と `tests/ssh_host_key_mismatch_golden.rs` の双方へ通し、前者は
`parseHostKeyFingerprints` の抽出結果、後者は `AppError::SshHostKeyMismatch{..}.
to_string()` を固定します。IPv4/非標準ポート (多段トンネルの踏み台)/FQDN/レガシー
形式 fingerprint (SHA256 未移行) に加え、**IPv6 ホスト (`:` を含む)** も含めており、
これは endpoint 抽出用正規表現 `[^\s:]+` がホストに `:` を許さないため host/port の
抽出には失敗する既知の境界です (fingerprint 自体は引き続き抽出できるので
`parseHostKeyFingerprints` 全体が `null` になるわけではなく、ダイアログは host/port
なしの縮退表示にフォールバックします)。この境界は仕様として維持し、意図せず
挙動が変わったことに気付けるようゴールデンへ含めています。

### 多段 SSH トンネル (ProxyJump 相当) と ~/.ssh/config の読み込み (#708)

`SshTunnel` は踏み台 (bastion/jump ホスト) を 1 段だけ経由する多段構成に対応します
(ローカル → 踏み台 → 最終 SSH ホスト → DB、計 2 ホップまで)。プロトコルレベルで
`direct-tcpip` を入れ子にする実装ではなく、**既存のローカルポートフォワード
プリミティブをそのままチェーンする**設計です: 踏み台の `SshTunnel` を先に開いて
ローカルポートを得た後、最終ホップの SSH セッションは (踏み台の実アドレスではなく)
`127.0.0.1:<踏み台の local_port>` へダイヤルして張ります。ホスト鍵の検証/記録は
**ダイヤル先ではなく各ホップ自身の実 `host:port`** を使うため (`ClientHandler::new`
に渡す識別子と実際に接続するソケットアドレスを分離)、known_hosts には従来どおり
段ごとの実サーバが `host:port fingerprint` で記録されます。

- **型**: `SshConfig` (`ssh/tunnel.rs`) に `jump: Option<Box<SshJumpConfig>>` を
  追加。`SshJumpConfig` は `SshConfig` から `remote_host`/`remote_port` と自身の
  `jump` を除いた同形の構造体 (踏み台は常に「次のホップの実アドレス」へ転送する
  ため `remote_*` は暗黙)。プロファイル側も対称に `SshProfile.jump:
  Option<SshJumpProfile>` を持ちます。
- **ライフタイム/Drop 順序**: `SshTunnel` は自身の `_upstream: Option<Box<SshTunnel>>`
  を**構造体の最後のフィールド**として保持します。Rust の構造体フィールドは
  **宣言順に drop される**ため、`impl Drop` 本体 (accept タスク/転送タスクの
  abort) が走った後、`_session` (この段の SSH セッション) → `_upstream`
  (踏み台。再帰的に同じ Drop を辿る) の順で閉じます。これにより「DB 接続 → 末段
  (target) → 先頭段 (bastion)」の順序が保証され、既存の「トンネルは DB 接続より
  先に drop しない」不変条件がチェーン全体へ自然に拡張されます。
- **エラーの段別属性化**: `ssh::tunnel::tag_hop_error` (非公開) が `AppError::Ssh`
  / `AppError::SshKey` のメッセージへ `[jump host <host>:<port>]` /
  `[ssh host <host>:<port>]` のプレフィックスを付けます。`kind()` は変えない
  (フロントの分類は従来どおり `ssh`) — メッセージだけがどちらの段の失敗かを示す
  手がかりを増やします。`AppError::SshHostKeyMismatch` は元々 `host`/`port` を
  持つため追加のタグ付けは不要で、その `host`/`port` は常に**実際に不一致が
  起きた段**の識別子です (フロントの `parseHostKeyFingerprints` がメッセージから
  これを抽出し、`App.tsx` の再信頼フローはプロファイルの主 SSH ホストではなく
  こちらを使います — 踏み台側で鍵が変わった場合に正しいエンドポイントを
  pin できるようにするため)。
- **秘密情報**: 踏み台の passphrase / password は既存の `ssh_passphrase` /
  `ssh_password` (最終ホップ用、後方互換のため名前は据え置き) とは別の keyring
  kind (`ssh_passphrase_hop0` / `ssh_password_hop0`、`profiles/secrets.rs`) に
  保存します。`profiles::secrets::delete_all` も両方を消します。
- **reconnect (#712) との整合**: `Session.reconnect_ssh: Option<SshConfig>` は
  `jump` を含めたまま非秘密フィールドのみを保持し (`reconnect_ssh_from` が両
  ホップの secrets を空文字にする)、`reopen_transport` が再接続時に**踏み台側も**
  keyring から再解決します。
- **`~/.ssh/config` の読み込み**: `ssh::config_parser` (パス非依存の純粋パーサ、
  副作用なし) が `Host` ブロックから `HostName` / `Port` / `User` /
  `IdentityFile` / `ProxyJump` を解決します。ワイルドカードパターン・`Include`・
  `Match` は非対応、"first obtained value wins" という OpenSSH 本来の規則には
  従います。IPC `resolve_ssh_config_host(alias)` (`commands/ssh.rs`) が
  `~/.ssh/config` (`%USERPROFILE%\.ssh\config`) を読んで解決し、`ProxyJump` は
  `config_parser::parse_proxy_jump` で最初の 1 ホップのみ `host`/`port`/`user` に
  分解します (本アプリのトンネルが 2 ホップまでのため)。**読み取り専用・保存時
  一度きりのコピー**であり、接続時に設定ファイルを再参照することはありません。
  `ConnectionForm` の「SSH ホスト」欄にエイリアスを入力して
  「~/.ssh/config から読み込む」を押すと、解決された値 (と `ProxyJump` があれば
  踏み台欄) がフォームへ展開されます。

### セッション

`AppState` (`state.rs`) は `RwLock<HashMap<SessionId, Arc<Session>>>` と、進行中の
ストリームタスク用の `RwLock<HashMap<StreamId, AbortHandle>>` を保持します。`Session`
は `conn`・`profile_id`・`connect_options` (`mysqldump` など外部クライアント再構築用)・
`read_only` / `skip_history` フラグ・`reconnect_ssh` (再接続用の非秘密 SSH 設定。#712)・
`_tunnel` を持ちます。セッション ID は独自
アルファベット (`0`/`o`/`l`/`1` のような紛らわしい文字を含まない) から生成される、
8 文字の base32 風スラッグです。これらは keyring のターゲットプレフィックスとしても
使われるため、クロスプラットフォーム上で安全であるようアルファベットの選定が重要です。
セッションは常に `state.get(&id).await.ok_or(AppError::SessionNotFound(id))` で
参照してください。パターンは `commands::query::run_query` を参照し、セッションを扱う
新しいコマンドでも同じ方式を踏襲してください。

**切断からの再接続 (#712)**: `reconnect(session_id)` は、切れたセッションの接続を
**同じ `SessionId` のまま**その場で張り直します。`commands::connection::reconnect_inner`
が旧セッションの `connect_options` と `reconnect_ssh` (接続時に退避した非秘密 SSH 設定)
から、SSH トンネルを開き直し → 新しい `db::Connection` を確立し、**成功してから**
`AppState::replace` で `Arc<Session>` を差し替えます (差し替え後に旧 `conn.close()`、旧
トンネルは Arc drop で連動)。順序の不変条件は「新接続を先に確立、失敗したら旧セッションを
壊さずエラー」で、`reopen_transport` が失敗すれば旧セッションは無傷のまま `Err` を返します。
id が変わらないため、フロントのタブ・グリッド状態 (session id 紐付け) は退避/復元の往復なしで
生き続けます。秘密情報は `connect` と同方針 — DB パスワードは `connect_options` の保持値を
再利用し、SSH の passphrase / password は keyring から再解決するため**平文の保持を新たに
増やしません** (`reconnect_ssh` は非秘密フィールドのみ)。`read_only` / `skip_history`
フラグは保存されます。フロント (`App.tsx` の `runReconnectLoop`) は自動リトライ (指数
バックオフ) と手動フォールバックからこの `api.reconnect` を呼び、**本番プロファイル
(`is_production`) は自動リトライせず必ず手動**にします。再接続の常時実行テストは
`tests/sqlite_integration.rs::sqlite_reconnect_reestablishes_same_session` (接続を落として
→ 再接続 → 同じ id でクエリ成功、read_only 維持を検証。外部サーバ不要)。

### プロファイルと秘密情報 — 厳密な分離

- `profiles.json` (`directories::ProjectDirs` の data_dir — Windows では
  `%APPDATA%/noobDB`) には**秘密でない情報**をすべて保存します: 名前、ドライバ、
  ホスト、ポート、ユーザ、データベース、SSH ホスト / ポート / ユーザ / 認証方式 /
  鍵パス、`group`・`color`・`is_production`・`read_only`・`skip_history`、SQLite の
  `file_path`、TLS 設定 (`ssl_mode`・`ssl_root_cert`・`ssl_client_cert`・
  `ssl_client_key` の各**パス**。#520)、セッション初期化 SQL (`init_sql`。#522) など。
  証明書はパスのみが非秘密で、ファイルの中身は接続時に読み込むだけで保存しません。
  `profiles/store.rs` は load/save-all と upsert/delete の API を提供します。
  **JSON ストア 4 種 (`profiles` / `snippets` / `sandboxes` / `tasks`) は同じ 2 つの
  対策を必ず持ちます**: (1) `write_atomic` の一時ファイル名に PID **とプロセス内の
  単調増加カウンタ**を含める — Tauri の `#[tauri::command] async fn` は同一プロセス
  内で並行実行されるため、PID だけだと 2 本の `save_all` が同じ一時ファイルを
  `create`(truncate) して書き、混ざった内容が `rename` されて**アトミック書き込みの
  保証自体が壊れます**。(2) `load_all` → 変更 → `save_all` の read-modify-write 全体を
  ストア単位の `Mutex` で直列化する (`ssh/known_hosts.rs` の `KNOWN_HOSTS_LOCK` と
  同じパターン。poisoning は `into_inner` で回復) — 無いと後勝ちで他方の変更が消える
  lost update が起きます。ロックを持つ公開関数から内部の `*_locked` 版を呼ぶ構成に
  してあるので、**新しい read-modify-write を足すときは `*_locked` 側を使ってくださ
  い** (公開関数を呼ぶと同一 Mutex の再取得でデッドロックします)。
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
- **保存済み秘密の表示 (`reveal_profile_secret`、#938) はこの分離ポリシーの唯一かつ
  意図的な例外です。** 通常 `list_profiles` が返すのは `has_db_password` などの
  真偽値だけで値は含まれませんが、「自分で保存したパスワードを確認したい」ために
  資格情報マネージャ / Keychain / `secret-tool` を叩かせるのは体験が悪いため、
  接続フォームの目アイコンから明示的に呼ぶ読み出し口を用意しています。前提は
  「keyring を読めるのは OS ユーザ自身であり、そのユーザは同じ値を OS 標準ツール
  でも読める」こと — **アプリは新しい権限を得ておらず、既にあるアクセスへの導線を
  短くしているだけ**です。したがって守るべき性質は「値をどこにも残さない」ことに
  尽き、実装は次を満たします: 値をログに出さず**表示した事実だけ**を `warn` で
  監査記録する / 履歴・`profiles.json`・localStorage に一切書かない / フロントは
  `PasswordInput` の state にのみ保持し、再マスク・アンマウント・30 秒
  (`REVEAL_TIMEOUT_MS`) の経過で破棄する。**新しい秘密の種類を追加するときは
  `SecretKind` と `ProfileSecretKind` (フロント) の両方に足してください。**

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

- `commands/export.rs`: 結果グリッドの内容を CSV / JSON / NDJSON / Markdown /
  SQL INSERT へ書き出します (`export_query_result`)。CSV は RFC4180 風のクオート、
  BLOB は `0x...` で出力。NDJSON (`ExportFormat::Ndjson`) は 1 行 1 オブジェクトの
  改行区切り JSON で、値エンコードは JSON 配列経路 (`row_to_json_object`) と共有します。
  **Markdown** (`ExportFormat::Markdown`) は GFM テーブル (ヘッダ + 区切り行 +
  データ行) で、セル内の `|` を `\|`・改行を `<br>` にエスケープします (空結果でも
  ヘッダは出力)。**SQL INSERT** (`ExportFormat::Sql`) は対象テーブル・ドライバ・
  バッチサイズ (`SqlExportOpts`) を受け取り、`db::data_diff::sql_literal` と
  `db::sync::quote_ident` を共有したドライバ別エスケープで
  `INSERT INTO ... VALUES (...), (...);` を生成します (バッチサイズ単位で 1 文へ
  まとめ、空テーブル名は `exported_table` にフォールバック。在グリッド経路は
  ドライバを引数で受け取り、ストリーミング経路はセッションの方言を使う)。
  加えて `export_query_stream` は、グリッドに載っていない大きな結果セットを
  メモリに溜めず**ストリーミングで直接ファイルへ書き出す**経路です (`run_query_stream`
  と同じバッチ列を消費)。5 形式とも通常 / ストリーミングの両経路に対応します。
  **JSON 形式のときは実行クエリを出力に同梱**できます (`export_query_result` の
  `query` 引数 / `export_query_stream` は `sql` を流用)。同梱時は配列ではなく
  `{ "query": <sql>, "rows": [...] }` でラップします (キーは serde_json 既定の
  `BTreeMap` 出力に従いアルファベット順)。`query` が None/空、または CSV/NDJSON では
  従来どおり配列のまま (後方互換)。`ExportModal` (フロント) は出力内容のプレビュー欄
  (純ロジックは `components/exportPreview.ts` がバックエンドの書式をミラー) と、在
  グリッド全行を全文コピーするコピーアイコンを備えます。
  **「プレビュー = 実出力」は共有ゴールデンで固定します (#879)。**
  `exportPreview.ts::buildExportContent` は 5 書式をバックエンドと**バイト一致**する
  よう独立に再実装しているため、`src/__tests__/fixtures/exportFormatVectors.json` の
  同一入力を両実装へ通して突き合わせます (フロントは `exportFormatGolden.test.ts`、
  バックは `tests/export_format_golden.rs` が `__test_api::export_bytes` 経由で
  **実ファイル出力と同じ** `write_export_to` を `Vec<u8>` 相手に走らせる)。ベクタは
  #879 が名指しする既知のドリフト源 — 浮動小数の書式・JSON キーのソート順 (serde_json
  の `BTreeMap` = UTF-8 バイト順。非 BMP 絵文字は JS の素の文字列比較だとズレるので
  `compareCodePoints` が要る)・CSV インジェクション緩和 (`mitigate_formula_injection`)・
  空結果・クエリ同梱・SQL のバッチ分割 — をケース名で固定しています。BLOB だけは
  フロントが `Value::Bytes` を区別できないため意図的に食い違い、`frontendExpected` に
  明記します。
- `commands/dump.rs`: `mysqldump` を呼ぶ DB ダンプ (MySQL 専用)。資格情報は
  プロセス引数や環境変数に出さないよう、一時オプションファイル (unix では mode 0600)
  経由で渡し、終了後に削除します。`mysqldump` が PATH にない場合は分かりやすい
  エラーを返します。`DumpOptions.format_sql` (既定オフ) を立てると、書き出した
  SQL を `db::format::format_sql` (`sqlformat` クレートの薄いラッパ) で整形して
  保存し直します — フロントの sql-formatter と方針 (2 スペース字下げ・キーワードの
  ケース保持) を揃えた可読性向上オプションです。
  **進捗・キャンセル・SQLite ストリーミング (#686)**: ダンプはストリーミングコマンド
  (`register_stream`/`forget_stream`/`stream_id` の 3 点セット) で、`dump-stream:progress`
  (バイト数・経過秒・SQLite はテーブル数) と `:done` / `:error` を emit します。外部
  クライアント (`mysqldump` / `pg_dump`) は stdout をファイルへ逐次パイプしながらバイト数を
  計測し、`kill_on_drop(true)` + `PartialFileCleanup` で `cancel_stream` の abort 時に
  子プロセスを kill し書きかけファイルを削除します (エクスポート #494 と同じ後始末方針)。
  SQLite 経路はテーブル単位の逐次書き出しで、在メモリの全文字列構築をやめています。
  `DumpModal` は進捗表示 (バイト/テーブル数・経過時間) とキャンセルボタンを持ちます。
  **一時ファイルは `create_new` (`O_CREAT|O_EXCL`) で予約します** — 素の `create` は
  シンボリックリンクを辿るため、ダンプ先ディレクトリに書ける攻撃者が
  `.<name>.dumping.<pid>.<seq>` (PID から予測可能) をリンクとして仕込むと、ダンプ内容が
  任意のファイルへ書き込まれます (資格情報ファイル側は元から `create_new`。同じ防御に
  揃えました)。`AlreadyExists` なら候補名を進めて有限回リトライします。後始末の
  `PartialFileCleanup` は `run_dump` が一元的に所有し、rename 成功時にだけ commit
  します (途中の関数で commit すると整形や rename の失敗で書きかけが残る)。
  加えて、`DefaultsFile` / `PgPassFile` は `Drop` でしか消えず SIGKILL / OOM では
  **平文パスワードを含む `noobdb-dump-*.cnf` / `.pgpass` が一時領域に残る**ため、
  起動時に `cleanup_stale_dump_credential_files` が自分たちの命名規約に一致する
  ものだけを掃除します (`commands::local::cleanup_stale_local_files` と同じ位置・
  同じベストエフォート方針で `lib.rs` から呼びます)。
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
  **エラー行の扱い (#687)**: `ImportOptions.error_mode` (`ImportErrorMode`: `abort`
  既定 / `skip`) を持ちます。`abort` は従来どおり単一トランザクションの all-or-nothing で、
  失敗時は `Connection::probe_failing_row` (ロールバックする tx で 1 行ずつ再試行) が
  **副作用なしで先頭の不良レコードを特定**し、エラーに「レコード N (CSV は行 L)」を添えます。
  `skip` は `Connection::import_rows_skipping` (チャンク投入 → 失敗チャンクのみ 1 行ずつ
  再試行、良い行はコミット) で不良行を飛ばして続行し、スキップ行 (レコード番号 + CSV 行 +
  理由) を `csv-import:done` の `skipped` で返します。行番号は `parse_rows_with_lines` が
  CSV は `csv::Reader` の position から**引用符付き複数行フィールドも考慮した実ファイル行**を
  取得します (JSON/NDJSON はレコード番号のみ)。各ドライバは `try_insert_chunk` (auto-commit) と
  `probe_failing_row` (tx ロールバック) の 2 プリミティブを実装し、orchestration は
  `db/mod.rs` に集約します。`ImportModal` はモード選択とスキップ行一覧 (コピー可) を持ちます。
  **非トランザクションエンジン (MyISAM 等) の扱い**: probe/retry はロールバックを前提とする
  ため、`Connection::table_is_transactional` (MySQL のみ `information_schema` の `ENGINE` を
  参照。他ドライバは常に true) で判定し、非トランザクションなら `import_rows_skipping` は
  **バッチを 1 行に落とし** (1 行 INSERT は MyISAM でも原子的なので、失敗チャンクの再試行で
  行を重複させない)、MySQL の `probe_failing_row` は **probe をスキップ**して副作用を残さない
  (エラーはレコード特定なしで報告)。判定に失敗したときは InnoDB 既定とみなし従来のバッチ経路
  を維持します。**skip モードのキャンセル整合**: skip はチャンクごとに auto-commit するため
  途中キャンセルで一部行が残りうる。コミット済み件数を `StreamHandle.delivered_rows` に反映し、
  `cancel_stream` は `csv-import:cancelled` を emit して `deliveredRows` (= コミット済み行数) を
  返します (`abort` はロールバックするので 0)。`ImportModal` はキャンセル時にこの件数を表示。
  読み込みは `read_import_file` が空パス拒否 + `MAX_IMPORT_FILE_BYTES` (512 MiB) 上限を
  `commands::file` と同じく metadata + `take` の二段で強制します。

### 明示的トランザクション

ストリーミング/オートコミット経路 (`run_query` 等) とは別に、UI のインラインセル編集や
複数文の対話的実行のために**明示的なトランザクション境界**を張る IPC があります。
`begin_transaction` → `run_in_transaction` (複数回) → `finish_transaction(commit)` の
3 コマンドが `db::Connection` の `begin_transaction` / `execute_in_transaction` /
`finish_transaction` / `transaction_active` にマップされ、セッションが内部に抱える
トランザクションハンドル上で実行されます。`run_query_transaction` (all-or-nothing の
文配列をまとめて投入する従来経路) とは別物で、こちらは**開いたまま複数の往復**を
できる点が違います。読み取り専用セッションでは書き込み文が拒否される点は同じです。

**MySQL の DDL は非原子である点に注意 (#640)。** `run_query_transaction` /
`apply_sync_sql` が使う `execute_transaction` は「begin → 逐次実行 → commit、失敗時
rollback」の all-or-nothing 実装ですが、**MySQL/MariaDB は DDL (`CREATE` / `ALTER` /
`DROP` / `TRUNCATE` / `RENAME` 等) を実行した時点で暗黙コミット**します。そのため
`["CREATE TABLE t ...", "INSERT INTO t ... (失敗)"]` のような **DDL+DML 混在バッチ**では、
後続 DML が失敗してロールバックしても先行の `CREATE TABLE` は残り、all-or-nothing が
崩れます。これは MySQL 固有の制約で `execute_transaction` 側では吸収できないため、
**方針は「非原子性を明示する」**とし、`db/mysql.rs::execute_transaction` のドキュメント
コメントに詳細を記載しています (分割・事前検証はしない)。`apply_sync_sql` は既に MySQL で
best-effort 逐次のため整合します。**スキーマ変更の原子性が必要な呼び出し側は、1 回の
`execute_transaction` に DDL と DML を混ぜないでください。** PostgreSQL は
トランザクショナル DDL なので同シナリオで `CREATE` もロールバックされ、この問題は
ありません。ドライバ差は `mysql_integration::mysql_ddl_dml_mixed_batch_is_not_atomic` /
`postgres_integration::postgres_ddl_dml_mixed_batch_rolls_back` の対比テストで固定して
います (環境変数ゲート、未設定ならスキップ)。

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
  INSERT/UPDATE/DELETE の安全な適用順を決めます。MySQL の `DEFAULT` は
  `information_schema.COLUMNS.COLUMN_DEFAULT` が**クオート無し**で返るため
  `is_mysql_string_default_type` に該当する型 (文字列系に加え `date`/`datetime`/
  `timestamp`/`time`/`year`/`binary`/`varbinary`/`blob` 系/`json`) では再クオートします
  — 漏れると `DEFAULT 2020-01-01` のような構文エラーの DDL になります。式の
  デフォルト (`CURRENT_TIMESTAMP` 等) は `extra` の `DEFAULT_GENERATED` を見て
  手前で逐語出力へ分岐するので二重クオートにはなりません。
- `commands/diff.rs`: `compare_schema` / `compare_table_data` が両セッションから
  メタデータ・行を取得して上記純粋関数に渡す IPC ラッパー。両セッションが同一ドライバで
  あること、データ比較対象テーブルにプライマリキーがあることを要求し、データ比較は
  `MAX_DATA_ROWS=5000` / `DEFAULT_DATA_ROWS=1000` で上限を設けます (マスターデータ向け)。
- `commands/sync.rs`: `generate_sync_sql` / `generate_data_sync_sql` (純粋生成) と
  `apply_sync_sql` (ターゲットセッションでトランザクション実行) を公開。`allow_destructive`
  (`DROP`) / `allow_delete` (`DELETE`) フラグで破壊的操作をオプトインにし、読み取り専用
  セッションへの適用は拒否します。MySQL は DDL の暗黙コミットのため best-effort 逐次、
  他ドライバは all-or-nothing。

### サンドボックス (壊せる砂場・ブランチ、#747)

選択したテーブル群 (+ 任意で FK の推移的閉包) をローカル SQLite ファイルへコピーし、
独立したセッションとして開く機能です。既存のエディタ/グリッド/セル編集 UI をそのまま
使え、何をしても元の接続には一切影響しません。差分計算・SQL 生成・適用は新規コマンドを
最小限に留め、既存の Diff/Sync 機能 (`generate_sync_sql` / `generate_data_sync_sql` /
`apply_sync_sql`) をそのまま再利用します — サンドボックスの書き戻しは、元 DB から見れば
ただの sync apply です。

- `db/sandbox.rs`: 純粋・ドライバ非依存のロジック。テーブルごとに複製する
  「凍結された base スナップショット」の命名規約 (`shadow_table_name` =
  `__noobdb_sandbox_base__<table>` プレフィックス、`is_shadow_table_name` でテーブル
  ツリーから隠す判定に使う)、行数上限のクランプ (`clamp_row_limit`、既定 5,000 / 上限
  100,000)、FK 推移的閉包 (`fk_closure`。参照先方向のみの片方向 — `schemaExport.ts` の
  双方向閉包とは意図的に異なる)、`Value` → `import_rows` 用セル文字列変換
  (`value_to_cell` / `row_to_cells`)、**競合検出** (`detect_conflicts` — サンドボックス側
  [live vs base] の diff と元 DB 側 [current vs base] の diff を同じ base に対して
  計算し、両方に現れる主キーを競合として突き合わせる)、競合を「スキップ」解決した行を
  除く `filter_out_keys`、スキーマの外部競合テーブル一覧 `schema_conflict_tables` を
  持ちます。
- `sandboxes/store.rs`: サンドボックスの非秘密メタデータ (`SandboxRecord`: 名前・
  ソースプロファイル/ドライバ/DB・テーブル一覧・行数上限・SQLite ファイルパス・作成日時)
  を `sandboxes.json` に永続化する、`profiles::store` / `snippets::store` と同じ
  JSON ファイルストアパターン。SQLite ファイル自体は `<data_dir>/sandboxes/<id>.sqlite`。
- `commands/sandbox.rs`:
  - `create_sandbox`: 選択テーブル (+ FK 閉包) の列メタデータを取得し、
    `compute_schema_diff` + `generate_sync_sql` を **SQLite 方言**で走らせて
    CREATE TABLE 一式を生成・実行 (テーブルごとに実名 + `shadow_table_name` の 2 つを
    作成)、行データは `import_rows` で両方へ投入します。作成した SQLite 接続はそのまま
    通常のセッションとして `AppState` に登録して返します。
  - `list_sandboxes` / `discard_sandbox` (セッションを閉じ、SQLite ファイル + メタデータを
    削除)。
  - `sandbox_table_diff` / `sandbox_schema_diff`: サンドボックスの live テーブルと
    shadow (base) テーブルを比較した「書き戻し案」(`desired`。`target_driver` は元 DB の
    ドライバなので、そのまま `generate_data_sync_sql` / `generate_sync_sql` に渡せる) と、
    任意で渡された元 DB セッションの現在値を同じ base と比較した「外部変更」を
    `detect_conflicts` / `schema_conflict_tables` で突き合わせた競合情報を返します。
  - `filter_sandbox_data_diff`: 競合を「スキップ」解決した行を desired diff から除く
    純粋コマンド (`generate_data_sync_sql` へ渡す前にフロントが呼ぶ)。
  - `sandbox_advance_base`: 書き戻し成功後に呼び、適用済みの行だけ shadow (base) を
    現在値へ進めます。呼ばないと、同じ行が次回の差分計算で「サンドボックス側も元 DB
    側も変化した」という偽の競合として出続けます (`allow_delete` を
    `generate_data_sync_sql` と揃え、実際に削除されなかった `TargetOnly` 行の base は
    残す)。
  - 適用そのものは新規コマンドを作らず、既存の `apply_sync_sql` をそのまま使います
    (read_only セッション拒否・トランザクション適用などの安全網もそのまま効きます)。
  - **`sandbox_session_id` を受け取るコマンドは、そのセッションが本当にその
    サンドボックスのものかを検証してから使います** (`get_sandbox_session`。
    `SandboxRecord` の SQLite ファイルパスとセッションの `connect_options.file_path`
    を突き合わせる。`commands/local.rs::get_local_session` と同じ発想)。検証が無いと
    IPC を直接叩いて任意のセッション — 本番の読み取り専用接続を含む — を対象にでき、
    `sandbox_advance_base` は `execute_transaction` を直接呼ぶ経路なので
    `ensure_allowed_for_session` も通りません。`sandbox_advance_base` には
    `apply_sync_sql` と同じ read_only 拒否も入れてあります。
  - **予約プレフィックスの検査は FK 閉包を展開した後にも適用します。** ユーザ指定の
    `tables` だけを見ていると、`__noobdb_sandbox_base__*` という名前の実テーブルが
    `fk_closure` 経由で紛れ込み、影テーブルと実名が衝突して差分計算が壊れます
    (黙って除外すると閉包が不完全になり後段で気付けないため、エラーで弾きます)。
- フロントは `sandbox.ts` の純ロジック (影テーブル判定・行数上限クランプ・FK 閉包の
  プレビュー・競合解決状態の集計) に加え、**`SandboxRecord` を非永続の合成
  `ConnectionProfile` に変換する `sandboxToProfile`** が肝です。これにより、
  サンドボックスは `save_profile` を一切経由せずに複数同時接続レジストリ
  (`openConnections`)・タブ復元・切替など既存の仕組みへそのまま乗ります (`id` は
  `sandbox:<id>` という予約プレフィックスで通常のプロファイル id と衝突しません)。
  接続先への無影響を常時明示するため、専用色 (violet、`SANDBOX_BAND_COLOR`) と
  `SandboxBadge` (タイトルバー下端の帯・バッジ) で他の接続と視覚的に区別します。
  UI は `ConnectionList` の DB 右クリックメニューから開く `SandboxCreateModal`
  (テーブル選択・FK 自動追加・行数上限・方言近似の限界を明記)、サイドバーの専用
  セクション `SandboxSection` (通常のプロファイルツリー/並べ替えとは独立 — 詳細は
  同コンポーネントのコメント)、変更確認・書き戻しの `SandboxReviewModal` (スキーマ/
  データ差分表示・競合行ごとの上書き/スキップ選択・SQL 生成プレビュー・適用。本番
  接続への適用は `SchemaCompareView` と同じ型入力確認を経由) の 3 つです。

### プロセス管理

`commands/process.rs` の `list_processes` / `kill_process` が、サーバのアクティブな
接続/クエリ (MySQL `PROCESSLIST`、PostgreSQL `pg_stat_activity`) を `ProcessInfo` として
列挙し、選択したプロセス/接続を強制終了します。`list_processes` は読み取り操作なので
読み取り専用セッションでも許可しますが、`kill_process` はサーバ状態を変えるため
読み取り専用セッションを明示的に拒否します (SQL 文ではないので `is_read_only_sql` の
経路外、コマンド側で別途ガード)。SQLite はサーバプロセスを持たないため空を返します。
なお #587 で `performance_schema` 無効時に MySQL のプロセス一覧が空になる問題を修正済み。

### ユーザ / 権限管理 (#732)

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
### ローカル横断クエリ (#740)

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
不正 UTF-8 はロッシーデコード、空パス/不存在は拒否します。同ファイルの
`write_binary_file` は逆方向で、フロントが生成したバイト列 (チャート/ER 図の PNG・SVG
など。#643) を保存ダイアログ (`dialog:allow-save`) で選んだパスへ書き出します。同じく
fs プラグインを使わず capabilities を増やさないための経路で、サイズ上限 32 MiB
(`MAX_WRITE_FILE_BYTES`)・空パスを拒否します。チャート (`ChartView`) と ER 図
(`ERDiagramView`) の画像エクスポートは `components/imageExport.ts` (`html-to-image`
で計算済みスタイルを焼き込み、テーマ色をライト/ダーク両対応で反映) と
`components/ImageExportButton.tsx` (PNG 保存 / SVG 保存 / クリップボードコピーの
メニュー) が担い、ER 図は `getNodesBounds` で全景を `scale(1)` で書き出すため現在の
ズーム/パンに依存しません。

### アプリ内自動更新 (Tauri updater プラグイン統合、#705)

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

### IPC 表面

すべての `#[tauri::command]` は `lib.rs::run()` 内の `invoke_handler!` マクロで
登録されます。現在のコマンド群:

- 接続: `test_connection` / `connect` / `disconnect` / `reconnect` /
  `ping_session` / `cancel_connect`
- SSH known_hosts: `list_known_hosts` / `forget_host_key` / `trust_host_key`
- SSH config: `resolve_ssh_config_host` (`~/.ssh/config` エイリアス解決。#708)
- クエリ: `run_query` / `run_query_transaction` / `run_query_stream` /
  `preview_query_stream` / `cancel_stream` / `set_emergency_mode`
- 明示的トランザクション: `begin_transaction` / `run_in_transaction` /
  `finish_transaction`
- スキーマ: `list_databases` / `list_tables` / `describe_table` /
  `schema_overview` / `foreign_keys` / `list_indexes` / `list_schema_objects` /
  `get_object_definition` / `table_row_estimates`
- プロセス管理: `list_processes` / `kill_process`
- ユーザ / 権限管理: `list_db_users` / `list_user_privileges` /
  `generate_create_user_sql` / `generate_drop_user_sql` / `generate_alter_password_sql` /
  `generate_grant_sql` / `generate_revoke_sql` / `apply_privilege_sql`
- 比較・同期 (Diff/Sync): `compare_schema` / `compare_table_data` /
  `generate_sync_sql` / `generate_data_sync_sql` / `apply_sync_sql`
- サンドボックス (壊せる砂場、#747): `create_sandbox` / `list_sandboxes` /
  `discard_sandbox` / `sandbox_table_diff` / `sandbox_schema_diff` /
  `filter_sandbox_data_diff` / `sandbox_advance_base`
- プロファイル: `list_profiles` / `reveal_profile_secret` / `save_profile` /
  `delete_profile` / `export_profiles` / `import_profiles`
- スニペット: `list_snippets` / `save_snippet` / `delete_snippet`
- 履歴: `list_history` / `clear_history`
- ログ: `read_logs` / `clear_logs`
- エクスポート/ダンプ/インポート: `export_query_result` / `export_query_stream` /
  `dump_database` / `parse_csv_preview` / `import_csv`
- ファイル: `read_text_file` / `write_binary_file`

完全なリストは
`src/api/tauri.ts` の `api` オブジェクトにミラーされています (`src/__tests__/
ipcCommandParity.test.ts` が Rust 側登録と `tauri.ts` の対応をテストで突き合わせます)。
**コマンドを追加する
ときは: Rust ハンドラを追加し、`lib.rs` で登録し、`tauri.ts` に型付けされたラッパー
(とストリーミングなら対応する `listen*` ヘルパー) を追加します — これらの間でズレが
発生するとフロントエンドが暗黙のうちに壊れます。**

**さらに「UI からそのラッパーに到達できるか」も検証します (#907)。**
`ipcCommandParity` が担保するのは「lib.rs 登録 ⇔ `tauri.ts` ラッパ」の集合一致まで
で、その先の到達性は誰も見ていませんでした。`api` は単一オブジェクトとして export され
UI で使われているため **knip では原理的にプロパティ単位の未使用を検出できず**、逆に
`ipcCommandParity` は集合完全一致を強制するので UI 未接続のラッパーを消すと CI が
落ちる — 結果としてデッドラッパーが構造的に不可視でした。
`src/__tests__/apiReachabilityParity.test.ts` が `Object.keys(api)` と `src/` 配下
(`api/tauri.ts` と `__tests__/` を除く) の `api.<name>` 参照を突き合わせ、**どこからも
呼ばれないラッパーがあれば落ちます**。逃げ道の許可リスト
`INTENTIONALLY_UNREACHABLE` は**空のまま維持するのが理想**で、追加するときは理由を
併記してください (「まだ UI を作っていない」は理由になりません — UI を足すか、
ラッパーと Rust コマンドを一緒に消す)。この方針で #907 では
`run_captured_write` / `precheck_captured_write` を IPC ごと削除しました (書き込み記録は
`run_query_stream({ capture: true })` に一本化済み。`run_captured_write_inner` は
その共通コアとして残る)。`clear_flight_records` / `clear_task_runs` は同じ調査で
UI 未接続と分かりましたが、#910 が `FlightRecorderPanel` の「全消去」/ `TaskManager`
の「実行履歴をクリア」導線を追加して解消済みです。

**「3 点コントラクト」の残る 1 辺 (#1031)。** `ipcCommandParity` は `generate_handler!`
の**登録**集合を「正」とみなして `tauri.ts` と突き合わせるため、`#[tauri::command]`
が付いているのに `generate_handler!` から**登録し忘れた**関数はどちらの集合にも
現れず不可視のまま (`apiReachabilityParity` は Rust ソースを読まないので対象外、
knip は TS 限定で Rust の未使用関数を検出しない)。
`src/__tests__/commandRegistrationParity.test.ts` が `import.meta.glob` で
`src-tauri/src/commands/**/*.rs` を再帰的に読み、実在する `#[tauri::command]
pub (async) fn <name>` を抽出して `generate_handler!` 登録集合の部分集合であることを
検証し、この最後の 1 辺を塞ぎます。抽出前に行コメント (`//` 始まり、`///`/`//!` も
同じ手法で除去可能) を取り除くのが要点で、そうしないと「The `#[tauri::command]`
wrapper above is intentionally a one-liner over this.」のような**説明文中の記法**
(`commands/query.rs::run_query_inner` / `commands/sync.rs::apply_sync_sql_inner` /
`commands/sandbox.rs` のモジュール doc に実例あり) を誤って属性だと検出してしまいます。

エラーは `AppError` として上に
伝搬し、`{ kind, message }` の**構造化 JSON** としてシリアライズされます
(`error.rs::Serialize` / `AppError::kind()` を参照。#683)。`kind` はバリアント由来の
安定した判別子 (`ssh` / `sshHostKeyMismatch` / `timeout` / `readOnly` /
`connectionLost` / `invalidInput` / `db` ...) で、`message` は従来の `Display` 文字列
です。フロントの `src/api/tauri.ts` の `invoke` ラッパーが reject 値を
`BackendError` (`.kind` / `.message` を持つ。`toString()` は `message` を返すので
既存の `String(e)` 経路は不変) に正規化し、**旧形式の素の文字列も後方互換で受け付け**
ます (`normalizeBackendError`)。`src/errorHints.ts` は「`kind` による確実な分類
(`hintForKind`) → `message` パターンはフォールバック (`matchErrorHint`)」の 2 段構成
(`resolveErrorHint`) で、SSH 系 (認証失敗 / エージェント不在 / 鍵・パスフレーズ /
ホスト鍵不一致) のヒントもここで解決します。`kind` → ヒントの対応はフロント/バック
共有ゴールデン (`src/__tests__/fixtures/errorKindVectors.json` を
`errorKindGolden.test.ts` と `tests/error_kind_golden.rs` が突き合わせ) で固定して
います。**`error.rs` にバリアントを追加するときは `kind()` の分岐も更新**してください。

### テスト専用 API

`lib.rs` は `pub mod __test_api` (`#[doc(hidden)]`) を公開しており、
`src-tauri/tests/` 配下の統合テストが Tauri を経由せずに `db::Connection` の
経路を駆動できるようにしています。`connect`・`parse_mysql_url`・
`parse_postgres_url`・`sqlite_options`・`mysql_exec_text`・`is_read_only_sql`
(ゴールデンベクタ検証用)・`kill_process_inner` (Tauri State 不要のプロセス強制終了)
などを提供します。新しいテスト用エントリポイントが必要な場合は、内部モジュールを
公開するのではなく、ここに追加してください。

**コマンド層の常時実行カバレッジ (#881)。** `commands/inspector.rs` /
`commands/server.rs` / `commands/process.rs` は env ゲートの MySQL/PostgreSQL
統合テストからしか実行されておらず、`rust (windows test)` ジョブや env 変数を
設定しないローカルの `cargo test` (= SQLite のみ) では**コマンド境界が 1 度も
走りません**でした。各コマンドの State なしコア
(`query_stats_support_inner` / `sample_live_queries_inner` /
`sample_statement_stats_inner` / `server_info_inner` / `server_metrics_inner` /
`list_processes_inner`) を `__test_api` から公開し、常時実走の
`tests/sqlite_integration.rs` が「SQLite 短絡パスの戻り値 (縮退レスポンス /
非対応エラー)」「未知セッション ID での `SessionNotFound`」「読み取り操作は
read_only セッションでも通ること」を外部サーバ無しで固定します。`_inner` を切る
パターンは `commands::query::run_query_inner` と同じで、`#[tauri::command]` 側は
一行のラッパーに徹します。

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
  (CodeMirror 6 + スキーマ補完 + リアルタイム構文チェック。後述の #704 lint 統合。
  ツールバーは**主要アクションのみ常時表示**で、副次アクション (Explain・スニペット
  保存・`.sql` の開く/保存・一括実行・Query Builder) は「…」オーバーフローメニュー
  (共有 `ContextMenu`) へ畳む #915 — 以前は狭幅で `flexWrap` により 2〜3 段へ折り返し、
  多機能タブほどエディタの縦領域が削られていた。畳まないのは Run / Preview /
  Format と**緊急クエリ実行モードのトグル**で、後者は「状態が常に見えていること
  自体が安全網」だから。無効時の理由 (`disabledReason` 等) はメニュー項目の
  `title` に持ち込むので、ボタンだったときと同じ説明がそのまま読める)、
  `QueryBuilder`、`ResultGrid`/`PreviewGrid`
  (TanStack Table)、`ResultViewSwitch` (結果パネルの表示切替セグメント。グリッド /
  ピボット / チャートの 3 択排他で、`ResultGrid`・`PivotView`・`ChartView` の各
  ツールバー先頭に同じものを置き「今どれを見ているか」と往復導線を 1 か所に集約
  する。App 側の受け口は `setResultView` で、`showPivot`/`showChart` の 2 フラグを
  常に同時に確定させる)、`TabBar`、`HistoryList`、`SnippetList`/`SnippetForm`、
  `ExportModal`/`DumpModal`/`ImportModal`、`ExplainViewer`、`SettingsView`、
  `HelpView`、`DangerousQueryDialog`、`CellValueViewer`、`ERDiagramView`
  (`@xyflow/react` + `@dagrejs/dagre` による ER 図。レイアウト/グラフ構築の純ロジックは
  `erDiagram.ts` に分離してテスト)、`SchemaExportModal` (DB スキーマを AI に貼れる
  Markdown としてコピー/保存。既定は DB 全体で、テーブル選択時は FK で紐付く関連
  テーブルを推移的に自動追加できる。Markdown 生成と FK 閉包の純ロジックは
  `schemaExport.ts` に分離してテスト。出力はロケール非依存の英語固定で、既存 IPC
  のみで完結しバックエンド変更なし)。
- `components/` (発展機能) — `ChartView` (結果のグラフ化。チャートライブラリ非依存で
  SVG 描画、純ロジックは `chartData.ts`。**配色はユーザが選べる** #916 — 既定の
  カテゴリスケールに加えて `colorScale.ts` の連続 (blue/teal) / 発散 (coolWarm/
  blueOrange) ランプを選べ、グリッドの条件付き書式 (`HEAT_PALETTES`) と「値 → 色」の
  体系が揃う。選択肢とサンプリング位置の決め方だけを `chartData.ts` の
  `CHART_PALETTES` / `chartSeriesColors` / `chartValueColors` / `chartRampGradient` が
  持ち、色そのものは `colorScale.ts` を単一の情報源にする。ランプ選択時は単一系列の
  棒グラフと円グラフを**値の大小で着色**し (折れ線/面は形状を追いやすいよう系列色
  1 色のまま)、そのとき凡例の見本は単色ではなくランプの勾配にする。設定は既存の
  チャート設定と同じ localStorage 永続化に相乗りし、このフィールドを持たない
  保存済み設定は縮退させず既定へ埋める)、`CommandPalette` (Cmd/Ctrl+K の横断検索。
  `commandPaletteSearch.ts`)、`ObjectSearchModal` (スキーマ全体のオブジェクト検索。
  `objectSearch.ts`)、`ParameterInputModal` (`{{name}}` プレースホルダのパラメータ化
  クエリ。`queryParams.ts` が型別に安全なリテラル/識別子へ展開)、`BatchResultsView`
  (複数文スクリプトのバッチ実行結果。文分割は `sqlScript.ts`)、`CreateTableModal`
  (CREATE TABLE ウィザード。`createTable.ts`)、`RowInsertModal` / `RowInspector` /
  `RenameTableDialog` (行追加・行インスペクタ・テーブル名変更)、`SchemaCompareView`
  (スキーマ/データ比較 → 同期 SQL 生成 UI。バックの Diff/Sync コマンドを駆動)、
  `SandboxCreateModal` / `SandboxSection` / `SandboxReviewModal` (壊せる砂場・ブランチ
  #747。作成・サイドバー専用セクション・変更確認 → 書き戻し。純ロジックは
  `sandbox.ts`、詳細はアーキテクチャの「サンドボックス」節を参照)、
  `ProcessListPanel` (プロセス監視・KILL。`processList.ts`)、`UsersPanel` (ユーザ /
  権限管理 #732。MySQL ユーザ・PostgreSQL ロールの一覧とテーブル単位権限マトリクスの
  閲覧・GRANT/REVOKE 編集。SQL 生成 → プレビュー → 確認 → 適用のフロー)、`ProfileImportDialog`
  (プロファイルインポートの ID 衝突解決)、`ShortcutCheatSheet` (`?` キーのチートシート。
  `shortcuts.ts` が単一ソース)、`TitleBar` (Tauri `decorations: false` のカスタム
  ウィンドウクローム。色決定は `titleBarContext.ts`)、`PlanWatchPanel` (実行計画
  ウォッチ #743。スニペット単位で EXPLAIN 計画をローカルに世代管理し、任意の 2 世代を
  `ExplainViewer` の並置 + 変化点リストで比較する。計画の正規化・フィンガープリント・
  構造比較の純ロジックは `components/planDiff.ts`、世代ストア (localStorage・同一
  フィンガープリントは世代を増やさない・`MAX_GENERATIONS` ローテーション・
  プロファイル単位) は `planWatch.ts`。取得は `run_query` (非ストリーミング) 経由なので
  クエリ履歴を汚さず、EXPLAIN は読み取り専用セッションでも動作する。接続時の自動
  チェックは設定 `planWatchOnConnect` (既定オン) で切替でき、アクセス方式・使用
  インデックス・結合方式・推定行数の桁違いの変化をトーストで通知する)。
- セル整形ユーティリティ — `cellTypeMeta.ts` (カラム型を 9 種の `CellKind` へ分類)、
  `cellFormat.ts` (JSON コンパクト表記・日時のロケール整形。**表示専用**で実値は不変)、
  `cellConditionalFormat.ts` (データバー/ヒートマップ。表示専用。色は下記
  `colorScale.ts` を参照)。
- セル値のクイックフィルタ (#914) — `quickFilter.ts`。結果グリッドのセル右クリックに
  出る「この値で絞り込む (= value)」「この値を除外する (≠ value)」の**純ロジック**。
  **新しいフィルタモデルは増やさず**、クリックしたセルの値を既存の 2 経路 — table
  タブのサーバ側 WHERE (`onSetServerFilter` → `serverBrowse.ts` の `ServerFilter`) と、
  クエリ結果タブのクライアント側 `ColumnFilter` (TanStack の `ColumnFiltersState`) —
  のどちらかへ変換するだけで、絞り込みの実行・表示 (フィルタチップ / ヘッダーの
  アクティブ表示 / 解除ボタン) は既存の仕組みがそのまま担う。実装として `≠` の
  演算子を両モデルへ追加した (`ServerFilterOp` の `ne` = `<>`、`ColumnFilter` の
  `notEquals` / `ne`)。これらは列ヘッダのフィルタポップアップからも選べる。
  **NULL セルは値比較ではなく NULL 判定に倒す** (`IS NULL` / `IS NOT NULL`、
  クライアントは `nullMode: only / exclude`)。非 NULL 値の「除外」は両経路とも
  NULL 行にマッチしない — SQL の `col <> 'x'` が三値論理で NULL を落とすのと、
  クライアント側 `columnFilter` が値条件のある行で NULL を弾くのが一致するため、
  テーブルブラウズとクエリ結果で見え方が変わらない (意図的に揃えてある)。BLOB 列は
  手元に 16 進表現しか無く一致比較が意味を成さないので項目自体を出さない。
- セル値のクイックセット — `quickSetValues.ts`。結果グリッドのセル右クリックに出る
  「NULL をセット」「空文字をセット」「0 をセット」「true/false をセット」「現在日時を
  セット」の**純ロジック** (どの列にどの候補を出すか + 生成する生文字列)。生成値は
  「ユーザが編集ボックスに手で打てたはずの文字列」に限定してあるため、下流の
  `validateCellInput` / `literalFromInput` / `cellValueFromInput` がそのまま効き、
  **DB への新しい経路を一切増やさない** (既存のインラインセル編集バッファに載るだけで、
  確定は従来どおり Apply)。適用範囲は一括編集ダイアログ (#596) と同じ判定で、クリック
  したセルが矩形選択の内側なら選択範囲全体 (`planBulkCellEdit` 経由)、そうでなければ
  そのセル 1 つ。時刻系の候補は**クリック時点**の時計で組み直す (メニューを開いたまま
  時間が経っても古い値を書かない)。NOT NULL 列では NULL の項目を「消す」のではなく
  **理由付きで無効化**して制約を可視化する。`BIT` はドライバで意味が変わる唯一の型で、
  MSSQL では真偽型そのもの (MySQL/SQLite も 1/0 が有効) だが PostgreSQL / DuckDB では
  ビット列 (`'10110000'`) なので `true`/`false` も空文字も不正なリテラルになる。
  `classifyEditType` は型名しか見られないためこの分岐は `quickSetOptions` 側に置き、
  ビット列ドライバでは NULL 以外を出さない (必ず Apply で失敗する候補を出すくらいなら
  出さない)。
  「すでにその値」のセットは `cellEdit.ts` の **`editIsNoop`** が検出し、保留編集を積む
  代わりに解除する。この判定は単一セル経路と `planBulkCellEdit` (矩形選択・一括編集
  ダイアログ #596) の**両方**が共有し、後者は該当セルを `applied` ではなく
  `unchanged` (`value: null` = 解除) へ回す。`BulkEditTarget.value` の `null` は
  「値ではなく解除」を意味し、App の `setBulkCellEditsForTab` が単一セルの
  `setCellEditForTab` と同じ削除処理を行う — 無変更の `SET col = <同じ値>` を Apply で
  発行せず、保留編集の件数表示も実際に変わるセルだけを数えるため。
- クリップボード貼り付けによる一括編集 (#793) — `pasteEdit.ts`。結果グリッドの
  矩形選択 TSV コピー (`copySelection`) と対称の取り込み経路で、`DataGrid` の
  `<table>` に付けた `onPaste` が Excel/スプレッドシート由来の TSV (タブ区切り・
  改行区切り、`"` で囲んだフィールドのタブ/改行/二重引用符も復元) を
  `parseClipboardGrid` で解析し、選択の左上 (矩形選択が無ければアクティブセル) を
  アンカーに貼り付け範囲を展開する。1×1 の単一値貼り付けは既存の矩形選択があれば
  `planBulkCellEdit` (#596) にそのまま委譲し (二重実装しない)、2 セル以上の矩形
  貼り付けだけが新設の `planPasteEdit` を通る — 編集不可列・型不正値のスキップは
  `planBulkCellEdit` と同じ `isColEditable`/`validate` を共有し、加えて貼り付け
  範囲が現在表示中の行/列数を超えた分は `skippedOutOfBounds` としてスキップ計上
  する (行の自動 INSERT 化はこの Issue のスコープ外)。生成される変更は既存の
  `PendingEdits`/`BulkEditTarget` バッファに積まれるだけで、確定は従来どおり
  Apply — **DB への新しい書き込み経路を増やさない**点は `quickSetValues.ts` と
  同じ方針。副次的に、グリッドセルにフォーカスがある状態 (インライン編集中は
  対象外) での Delete/Backspace は選択範囲 (または アクティブセル) を NULL へ
  一括セットする `clearSelectedCells` を追加し、既存の「値をセット」経路
  (`applyValueToCells`) をそのまま再利用するため NOT NULL 制約のスキップ挙動も
  一括編集ダイアログと揃う。
- データ可視化カラースケール (#525) — `colorScale.ts` が、データを色で符号化する表面
  (チャート系列・ヒートマップ・データバー・将来のコスト/NULL 率ミニバー) が共有する
  **単一のスケール体系**を純ロジックとして定義する。**sequential** (単一色相の連続、CB
  セーフ) / **categorical** (CB 配慮の順序付き離散色、チャート系列用) / **diverging**
  (中央が淡い発散) の 3 系統と、値 → 色の純関数 (`sampleRamp` / `categoricalColor`) ・
  塗り面上の可読インク (`readableInk`) を公開する。`ChartView` (系列/値の配色は
  `chartData.ts` の `CHART_PALETTES` 経由。#916) と `cellConditionalFormat.ts` は
  ここを参照し色を二重定義しない (`colorScale.test.ts` が
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
- 結果グリッドの集計フッター行 — `gridFooter.ts` (#645)。表計算ソフトのフッターに相当し、
  各列の要約を「選択や操作なしに常に一覧で把握する」。`ResultGrid` (内側 `DataGrid`) の
  `<tfoot>` に、縦スクロールで最下部スティッキー・横スクロール追従・ピン留め列整合で
  列ごとの集計値を 1 つ表示する。集計値算出は `gridStats.columnStats` を**再利用**し
  (二重定義しない)、`gridFooter.ts` は列種別ごとの選択可能な関数 (`availableFooterFns`:
  数値列 SUM/AVG/MIN/MAX + COUNT/DISTINCT/NULL率、非数値列 COUNT/DISTINCT/NULL率)・
  既定 (`defaultFooterFn`: 数値=SUM / 他=COUNT)・`ColumnStats` からの表示値取り出し
  (`computeFooterCell`)・破損耐性つきのテーブル単位永続化 (`footerStateKeyFrom` は
  `colStateKeyFrom` と同型で `noobdb.gridfooter.v1` 名前空間、`read/writeStoredFooterState`)
  を担う純ロジック。表示 ON/OFF は列ヘッダーメニュー、列ごとの関数切替は「列の統計」
  ポップオーバー (`ColumnStatsMenu`) のセレクタから。値更新は `motion.ts` の crossfade で
  控えめにアニメーションし reduced-motion で抑制。`gridFooter.test.ts` (純ロジック) と
  `ResultGrid.test.tsx` (描画/切替/永続化) がテスト。全件集計が要る場合は #524 の
  `buildColumnStatsSql` / 全件集計ボタンに乗る (フッター自体は在メモリ対象)。
- 結果グリッド列ヘッダの NULL 率ミニバー — `gridStats.ts` の `columnNullRates` /
  `nullRatePercentOf` (#911)。列統計ポップオーバー (`ColumnStatsMenu`) を開かなくても
  各列の欠損の偏りを一望できるよう、ヘッダ下端に細いバーを**常時表示**する。率の式は
  `nullRatePercentOf` に一本化し、ポップオーバーの NULL 率バー・集計フッターの
  `nullRate` (#645)・このミニバーが同じ値になることを保証する。全列ぶん再計算される
  経路なので、DISTINCT/代表値の頻度マップまで作る `columnStats` ではなく、NULL の
  数え上げだけを行う軽量な `columnNullRates` を使う (「fetch all」後の数万行 × 列数で
  効く)。塗りは `colorScale.ts` の `accentFill(ACCENT_FILL_STOPS.nullRate)` を
  `.cell-databar` / ポップオーバーと共有し色を新規定義せず、幅は width ではなく
  `scaleX` で表現する (データバーと同じくレイアウトを誘発しない)。バーはヘッダの
  **高さを変えない絶対配置**で下端に重ねるため、密度設定 (Compact/Normal/Spacious) や
  フォント拡大でも列間の整列が崩れない。0% の列にも薄い「地」を敷いて計測済みで
  あることを示す。表示専用で実値・ソート・編集・エクスポートには影響しない
  (`cellConditionalFormat` と同方針)。設定 `columnNullBars` (既定オン) でオフにできる。
  装飾要素にタブストップを増やさないよう、ホバー時の説明はセルと同じ委譲ツールチップ
  (hover 専用) に載せ、読み上げ向けには `role="img"` + `aria-label` を持たせる。
- アプリ内アクティビティ / 通知センター — `activityLog.ts` + `components/ActivityCenter.tsx`
  (#912)。トーストは自動で消える一過性の通知なので、インポート結果・同期の成否・実行
  計画ウォッチ (#743) のアラートを見逃すと二度と確認できなかった。`ToastProvider` の
  `notify` が発火時に `pushActivity` へ流し込み、タイトルバーのベルアイコン →
  ポップオーバーで時系列に再閲覧できるようにする (**記録の入口は 1 か所**なので、
  通知を出す側は従来どおり `toast.*` を呼ぶだけでよい)。ストアは在メモリで**セッション
  内のみ揮発**し (通知は「今このアプリで何が起きたか」の記録で、再起動をまたぐと文脈が
  失われるため)、`ACTIVITY_LIMIT` (200) を超えたら古いものから捨てる。未読はエントリ
  ごとのフラグではなく「最後に読んだ id」の水位で表し、`countUnread` で数える。重大度
  (`ActivitySeverity`) は `semanticColors.ts` の `SemanticRole` と 1 対 1 で対応させて
  状態色を二重管理しない (`danger` に相当する語だけトーストの tone に合わせて `error`)。
  トーストの tone は 3 種しか無いため、見た目は変えずセンター側でだけ「警告」として
  分類したい通知 (スキーマドリフト検知・実行計画の変化) は `ToastOptions.severity` で
  明示する。a11y: パネルは `role="dialog"` + フォーカストラップ (開くとパネル自身へ
  フォーカス、閉じるとベルへ復帰) で、**`aria-live` は付けない** — 通知そのものは
  トースト側 (`aria-live="polite"`) が既に読み上げており、二重読み上げを避けるための
  意図的な設計。追加/ローテーション・絞り込み・未読数・相対時刻はすべて純関数として
  公開し `activityLog.test.ts` が、UI 結線は `ActivityCenter.test.tsx` が固定する。
- 基盤モジュール — `shortcuts.ts` (全ショートカット定義の単一ソース)、`keyboardNav.ts`
  (`useFocusTrap` / `useRovingFocus` / `useReturnFocus` の a11y フック)、
  `tableQuickAccess.ts` (お気に入り + 最近使ったテーブルを localStorage 永続化)、
  `queryHistoryNav.ts` (エディタの ↑/↓ 履歴ナビ)、`clipboard.ts`、
  `tableMaintenance.ts` (TRUNCATE/DROP/RENAME の方言別 SQL 生成)、`rowEstimate.ts`
  (`~1.2K` 形式の概算行数表示)、`components/paneLayout.ts` (エディタ⇔結果スプリット
  ペインの配分クランプ/正規化と、レイアウトモード `normal`/`result`/`editor` の
  正規化・トグルの純ロジック。#618。`Splitter` と `App` が共有し `paneLayout.test.ts`
  が境界を固定)。エディタ集中/結果最大化はワークスペース単位 (`noobdb.layout.mode`) で
  永続化し、全画面オーバーレイは `App.css` の `pane-overlay-in` で出現させ
  reduced-motion で静止化する。
- ツールチップ (#814/#884) — `components/Tooltip.tsx` が唯一の実装で、位置決めの
  純ロジックは `components/tooltipPosition.ts` (`computeTooltipPosition`。測定 →
  クランプ → フリップ) に分離してテストする。**新しい UI で native `title=` を
  書かないこと** — native title は表示まで約 1 秒・**キーボードフォーカスでは
  一切表示されない (a11y 欠陥)**・テーマ非追従・すぐ消える、という弱点がある。
  使い分けは 2 つ:
  - `<Tooltip label={...}>` — 通常のボタン/アイコン/ラベル。`cloneElement` で
    hover/focus ハンドラ・ref・`aria-describedby` を注入するので DOM 構造は
    変わらない。`label` が falsy なら何もせず `children` をそのまま返すため、
    条件付きラベルを分岐なしで渡せる。**無効 (`disabled`) なトリガーにだけ**
    `focusableWrapper` を付ける (ブラウザが無効要素をタブ順序から外すため)。
    通常のフォーカス可能要素に付けると余計なタブストップが増える。
  - `useDelegatedTooltip()` + `<TooltipBubble>` — 行/列/セル数に比例して大量に
    描画される一覧 (`ResultGrid` のセル、`ConnectionList` のスキーマツリー行、
    `ERDiagramView` の PK/FK アイコン)。共有状態 1 つ + `bind(label)` が返す
    軽量なハンドラだけを各要素に付け、`Tooltip` インスタンスを増やさない。
    hover 専用 (focus 非対応) なので、**キーボードで到達できる要素には使わない**。
    単純テキストではない hover カード (`ConnectionList` のカラム詳細
    `ColumnTooltip` など) は、任意の値を運べる一般形 `useDelegatedHover<T>()` に
    載せる — `bind(value)` の戻り値を行に展開するだけで、遅延・単一表示の登録簿・
    スクロール連動非表示が揃う。**hover 状態を自前の `useState` +
    `onMouseEnter`/`onMouseLeave` で持たないこと** (遅延と登録簿から外れる)。
  **hover での出現には遅延を入れる (`TOOLTIP_OPEN_DELAY_MS` = 400ms)。** 即時
  表示だとポインタが目的地へ向かう途中で通過しただけの要素が次々に吹き出しを
  開き、画面がちらつく。この定数は `Tooltip` と `useDelegatedHover` /
  `useDelegatedTooltip` の**共通の既定値**で、表面ごとに速さが変わらないように
  する (呼び出し側が `openDelay` で上書きするのは、遅延が邪魔になる特殊な場合
  だけに留める)。**フォーカス起因の表示は遅延なし** — キーボードユーザには
  「まず hover して気付く」段階が無く、遅延はただの待ち時間になるため。
  同時に見える吹き出しは常に高々 1 つで、新しく開いたものが直前のものを閉じる
  (`claimTooltip`/`releaseTooltip`)。行のツールチップの中にボタンのツールチップを
  入れ子にしても native title と同じ「最も内側だけ」の見え方になる。複数行ラベル
  (`ヒント\n\nSQL` など) は `white-space: pre-wrap` で改行を保つ。**唯一の例外は
  `TabBar` のタブ本体**で、`AnimatePresence` の直接の子である必要があり `Tooltip`
  の Fragment を挟むと退出アニメーションが壊れるため、意図的に native title の
  ままにしている (理由はコード内コメントに明記)。挙動は `tooltip.test.tsx`
  (開閉・hover 遅延・a11y 結線・入れ子) が固定する。
- コンテキストメニュー (#213/#815/#1018) — 全画面の右クリックメニューは
  `components/ContextMenu.tsx` の 1 実装で、項目は `ContextMenuEntry`
  (項目 / セパレータ / **サブメニュー**) の配列として呼び出し側が組み立てる。
  位置決めの純ロジックは `components/menuPosition.ts` (`computeMenuPosition`。
  クリック点起点と親項目起点の 2 通りで測定 → フリップ → クランプ) に分離して
  テストする (`tooltipPosition.ts` と同じ形)。
  **サブメニュー (#1018)**: 項目数が状況によって膨らむグループは
  `submenuOrFlat(label, items, opts)` を通してから差し込む — 0 件なら何も出さず、
  `SUBMENU_THRESHOLD` (既定 2) 未満ならフラットのまま、それ以上なら 1 項目へ
  畳む。1 件のためにホバー 1 手を増やさないための共通基準で、**畳む/畳まないの
  判定を各メニューで独自に書かないこと**。現在の適用先は結果グリッドのセル
  メニュー (コピーの派生・値のクイックセット・「参照元を表示」— 参照元は子
  テーブルの数だけ増え、実際に画面高を縦断していた) と、接続ツリーのテーブル /
  DB 保守コマンド。子パネルは**ポータルで body へ出す** — 親パネルの DOM に
  入れると親の roving focus のクエリ (`[role=menuitem]`) に子項目まで混ざって
  矢印移動が壊れるため。ポータルでも React ツリー上は親の子なのでキーイベントは
  親へ伝播する点に注意 (パネル内で処理したキーは `stopPropagation` する。
  サブメニュー内の Escape が**メニュー全体ではなくサブメニューだけ**を閉じるのも
  これによる)。ホバーで開いた子は通常項目を通過しても閉じず、別のサブメニュー
  項目へホバーしたときだけ開き先が入れ替わる (親項目から斜めに子パネルへ
  移動しても取りこぼさないため)。キーボードは ArrowRight / Enter で開いて先頭の
  子項目へフォーカス、ArrowLeft / Escape で親へ戻る。挙動は
  `contextMenu.test.tsx`、算術は `menuPosition.test.ts`、実 CSS 上の配置は
  `browser/screens.browser.test.tsx` が固定する。
- `settings.ts` — `useSyncExternalStore` ベースの設定ストア。シンタックスカラー
  (`syntaxColors` light/dark)・プレビューハイライト色・表示行数 (`defaultDisplayCount` /
  `streamPrefetchSize`)・自動 LIMIT (`autoLimitEnabled` / `autoLimitCount`)・SQL 構文
  チェック (`sqlLintEnabled`。#704)・本番接続確認
  (`confirmProductionConnect`)・危険クエリ確認 (`confirmDangerousQueries`)・新規タブ実行
  (`resultsInNewTab`)・タブ復元 (`tabRestoreMode`)・クエリタイムアウト
  (`queryTimeoutSecs`)・フォントサイズ (`fontSizePx`) / フォントファミリ
  (`monoFontFamily` / `uiFontFamily`)・アクセント色 (`accentColor`)・UI 密度
  (`density`)・自動リフレッシュ間隔 (`autoRefreshDefaultSecs`)・グリッド表示モード
  (`resultGridMode` scroll/paginate, `resultGridPageSize`)・セル編集の blur 挙動
  (`cellEditOnBlur`)・リッチセル描画 (`richCellRendering`)・列ヘッダの NULL 率
  ミニバー (`columnNullBars`。#911)・テーマプリセット
  (`themePreset` default/dracula/high-contrast/colorblind。後者 2 つは light/dark
  追従でアクセシビリティ向け。#558) などを保持します。
- `dangerousSql.ts` — WHERE なし UPDATE/DELETE・DROP・TRUNCATE を検出する
  フロント側の安全網 (バックエンド `is_read_only_sql` と同じくリテラル/コメントを
  マスクするベストエフォート判定)。`DangerousQueryDialog` の確認に使われます。
- `components/sqlLint.ts` — クエリエディタのリアルタイム SQL 構文チェック (#704) の
  純ロジック。`@codemirror/lang-sql` が既に構築した **Lezer パースツリーを再利用**し
  (`syntaxTree(state)`)、エラーノード (`node.type.isError` = 括弧不整合など) と、
  クオートで始まり閉じられていないトークン (未終端の文字列/引用符付き識別子。Lezer は
  未終端文字列をエラーにせず EOF まで伸びる 1 トークンにするためツリーから別途拾う) を
  `@codemirror/lint` の `Diagnostic[]` へ変換する。加えて、未終端のブロックコメント
  (`/*` 未クローズ) と、**文の先頭キーワードのタイポ** (`SELEC` など。各 `Statement`
  の先頭トークンが `Keyword` 系でなく素の `Identifier` の文を warning で報告。
  `STATEMENT_START_EXTRA` の許可リストが方言キーワード表の載り漏れに対する安全弁)、
  **句の順序ミス** (`ORDER BY` の後の `WHERE` など。文直下の `Keyword` 列を
  `WHERE → GROUP BY → HAVING → ORDER BY → LIMIT` のランクで走査し、違反句を warning
  で報告。サブクエリ / `OVER (...)` 内は `Parens` に包まれるため対象外。報告対象は
  3 方言で完全予約語の句のみで、非予約語 `OFFSET` は列名と区別できないため判定に
  使わない。SELECT / 集合演算でランクをリセットし `INSERT ... SELECT` も誤検出
  しない) も検出する。エディタの `closeBrackets()` が括弧/クオートをタイプ中に自動で閉じるため
  括弧系の検出は主に貼り付け・削除後に効き、タイプ中の主戦力は文頭キーワード判定。
  見た目判定はリーフトークン限定 (コンテナノードに適用するとクオートで始まる文全体を
  未終端と誤検出する)。`QueryEditor` が `lintGutter()` +
  `linter()` (デバウンス 500ms) を Compartment 越しに追加し、設定 `sqlLintEnabled`
  (既定オン) のオン/オフと言語切替で再構成する。方言追従は共有ツリー経由で自動 (別途
  dialect を渡さない)。診断メッセージは `i18n` (`editorLint*`) で日英対応。**編集支援
  (ベストエフォート) であって安全判定ではない**: 文法が寛容なため文中のタイポ
  (`FORM` 等) やカンマ抜けは検出できず、`apply_auto_limit` と同じく誤検出より見逃しを
  優先する保守的方針 (打ちかけの先頭単語 = 後続トークンなしも flag しない)。安全網
  (`dangerousSql.ts` / `is_read_only_sql`) とは目的も経路も別物で判定
  ロジックを共有しない。`sqlLint.test.ts` が正常 SQL の非検出・未終端/括弧/文頭
  タイポの検出・方言差を固定する。
- `i18n.ts` — 日本語/英語の文字列テーブルと `useT` フック。
- `tabPersistence.ts` — プロファイルごとの開きタブを localStorage に保存/復元。
- `errorHints.ts` — DB エラー文字列を人間向けのヒントに対応付け。
