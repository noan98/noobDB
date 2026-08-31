# ci.yml (PR / main push のチェック)

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
