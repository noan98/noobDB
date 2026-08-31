# CI / リリースワークフロー

`.github/workflows/` の構成、依存関係の自動更新、CodeRabbit レビューゲート、ビルド高速化設定。

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

## 依存関係の自動更新と脆弱性監査 (#605)

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

## CodeRabbit レビューゲート (#1055)

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
  進めば新しい SHA として再度 1 回だけ起動します。

  **ただし現状この投稿は効きません (要 PAT)。** 実地検証の結果、CodeRabbit は
  **GITHUB_TOKEN 由来 (= github-actions[bot] が author の) コマンドコメントに一切
  反応しません** (PR #1059 で投稿後 40 分以上待ってもレビュー提出・返信ともに無し。
  多くのレビュー bot が無限ループ防止のため bot 由来コマンドを無視するのと同じ)。
  レビューを実際に走らせたい場合は `repo` スコープの**人間ユーザの PAT** を Secrets
  (例 `CODERABBIT_PAT`) に登録し、同ワークフローの `GH_TOKEN` を差し替えてください。
  PAT を用意しない間、このワークフローは PR ごとに 1 コメントを残すだけの no-op です
  (レビュー不在自体は下の Step 5a が警告として可視化するので見逃しにはなりません)。
- **`automerge.yml` の Step 5a — 可視化 (待たない)**。skip 宣言を検出したら、まず現在の
  head に対する CodeRabbit のレビュー提出を確認し、あれば skip フラグを下ろして
  通常経路 (Step 5b/6) へ委ねます (PAT 構成にした場合はここに倒れます)。無ければ
  **マージは継続しつつ** `::warning::` アノテーションと Job Summary に「レビューゲートが
  素通りしています」を出力します (黙って通さない)。
  当初は明示起動した `@coderabbitai review` の結果を猶予時間 (20 分) だけ待つ設計に
  しましたが、上記のとおり待ってもレビューは来ず、かつ**猶予切れ後に automerge を
  再評価するイベントが来ないため PR が無期限に停止する**副作用だけが残ったので撤廃
  しました。マージを止めない方針自体は、バンドルサイズ (#443) ・カバレッジ (#482) と
  同じ「まず可視化」の漸進方針に沿ったものです。
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

## ビルド高速化

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
