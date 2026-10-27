# ci.yml (PR / main push のチェック)

- **concurrency**: `cancel-in-progress` は `github.event_name == 'pull_request'` のときだけ
  true (#1632)。PR の古い run は取り消すが、**main への push の run は取り消さない**
  (連続 push で途中のコミットの検証が抜け、main の健全性確認とキャッシュ温めが欠けるため)。
  `cancel-in-progress: false` でも同一グループの「待機中」run は新しい run に置き換えられる
  (グループには実行中 1 + 待機 1 のみ) ため、push のグループは `github.sha` 単位にして
  全件を完走させる。PR のグループは従来どおり `github.ref` で、PR と push は互いに取り消し合わない。

- `.github/workflows/ci.yml` — `main` への PR と `main` への push で起動。
  push トリガは**キャッシュを main スコープへ保存するため**にあります:
  pull_request 実行で保存される rust-cache / sccache / pnpm のキャッシュは PR の
  マージ ref スコープにしか残らず他の PR から参照できないため、main push 時に同じ
  ジョブを走らせて全 PR ブランチがフォールバック復元できる main スコープを温めます
  (これが無いと新規 PR ブランチの初回 Rust ビルドは毎回コールド)。マージ後の main
  の健全性確認も兼ねます。`dorny/paths-filter` で
  変更領域 (frontend / rust / workflow / crosslang / ci-scripts) を判定し、ジョブ単位の `if:` で
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
  `pnpm run build` に続けて `pnpm run lint` (Biome の lint + 整形チェック =
  `biome check`。#1176 / #1636。新しい必須チェックは増やさずこのジョブ内のステップ)、
  `pnpm run bundle-size` (バンドルサイズ計測 → Job Summary。#443)、`pnpm run knip`
  (未使用エクスポート/到達不能コード検出。#470)、さらに `pnpm exec playwright install` +
  `pnpm test:browser` (Vitest ブラウザモード。#306) を順に実行します。
  バンドルサイズはカバレッジと同じく当面は閾値による fail を設けず可視化のみで、
  `dist/` の JS/CSS の gzip 後サイズを Node 標準の zlib だけで集計します
  (`scripts/bundle-size.mjs`、size-limit 等の追加ツールは増やしません)。pnpm は
  各ジョブで `corepack enable` により用意し、`pnpm`
  ストアを `actions/cache` でキャッシュします (`actions/setup-node` の `cache: npm`
  は使いません)。`frontend` ジョブは加えて Vite の依存プリバンドルキャッシュ
  (`node_modules/.vite`) と Playwright の Chromium バイナリ (`~/.cache/ms-playwright`)
  も `actions/cache` でブランチ跨ぎに温めます (#908。加えて `tsc` の `.tsbuildinfo`
  (`tsconfig.json` の `incremental` + `tsBuildInfoFile` = `node_modules/.cache/tsc/app.tsbuildinfo`)
  も同様にキャッシュし、`pnpm run build` 先頭の型検査を差分のみにします (#1589。キーは `github.sha`
  付きで毎回保存、`restore-keys` で直近を復元。ローカルの `pnpm run build` も 2 回目以降は速くなるだけで
  結果は不変、release.yml / e2e.yml / tauri の `beforeBuildCommand` は初回フル型検査のまま)。ブラウザテスト側の
  「install/トランスパイル部」の壁時計短縮が目的で、pnpm store キャッシュと同じ
  パターンでキー付けします)。
  Playwright の OS 依存 (apt: 共有ライブラリ・フォント・xvfb) は `playwright
  install-deps --dry-run chromium` の出力からパッケージ一覧を動的に取り、rust ジョブと
  同じ `cache-apt-pkgs-action` でキャッシュします (`--with-deps` は付けない, #1244)。
  この dry-run による一覧の算出も `actions/cache` に保存し (キーは `pnpm-lock.yaml`
  ハッシュ + OS + ISO 週。週を入れるのはランナーイメージの事前導入パッケージが変わりうる
  ため)、ヒット時は dry-run だけを省きます (#1634)。`apt-get update` は常に実行します
  (`cache-apt-pkgs-action` のキー算出が apt インデックスに依存するため)。
  `cache-apt-pkgs-action` が失敗、または空キャッシュを静かに復元したとき
  (`all-package-version-list` が空) だけ、警告を出して直接 install するフォールバックが走ります。
  rust (clippy) / (test) の `apt-get update` (各約 6 秒) は**省けません**: action は
  キャッシュキーの算出にもランナーの apt インデックスを使い、インデックスが古いと
  キーがずれてクリーンインストールに回り 404 になる (2026-07-23 の事例) ため、ヒット
  有無が action の内部でしか分からない現状では事前の update を外せません。`paths-filter` は `package-lock.json` ではなく
  `pnpm-lock.yaml` を監視します。**旧チェック名 `frontend (typecheck + build)` /
  `frontend (browser render + visual)` を必須チェックに指定していた場合は、新しい
  `frontend (build + browser tests)` へ設定し直してください** (#908 のジョブ統合で
  チェック名が変わったため)。

  **Vitest 単体テストは別ジョブに分割** (実測 約 4 分 15 秒がフロントの大半を占めていた
  ため)。`frontend (unit shard 1/4)`〜`(4/4)` (`frontend-unit`、`--shard` で 4 並列。分割数の正は ci.yml の `matrix.shard`。
  各 shard は `--reporter=blob` で blob を artifact へ保存し、**main への push のときだけ**
  `--coverage --coverage.thresholds.lines=0` を付ける) と、
  それを `gh run download` で集めて `vitest run --merge-reports` で統合し
  (push のときだけ `--coverage` を付けて)
  カバレッジ閾値 (`vite.config.ts` の `thresholds.lines`) を強制する
  `frontend (unit tests)` (`frontend-unit-merge`) の 2 段です。**単体テストの合否と
  カバレッジ閾値のゲートは `frontend (unit tests)` が担う**ので、必須チェックには
  `frontend (build + browser tests)` に加えてこれも指定してください (shard 側の各ジョブは集約ジョブが `needs.frontend-unit.result` を見て fail
  させるので必須に含めなくてよい)。

  **PR では単体テストのカバレッジを計装しない (#1634)**: v8 計装は 1 shard あたり約
  27 秒 (約 22%) の上乗せになるため、#1420 の `rust (coverage)` と同じく main push 限定に
  しました。集約ジョブ `frontend (unit tests)` は PR でも必ず走って合否を返します
  (blob の統合のみ)。**トレードオフ: PR 上ではフロントのカバレッジ閾値の割れが見えず、
  マージ後の main の実行で初めて検出されます。** 閾値割れを PR で見たいときは、手元で
  `pnpm test --coverage` を実行してください。
  なお shard の割当は Vitest の `BaseSequencer.shard` が**ファイルパスの sha1 順**で
  決めるため、Vitest のキャッシュ (実行時間) では割当は変わらず、実行時間ベースの分割には
  カスタム sequencer + 実行時間データの保守が要ります。フロント単体の連鎖 (約 200 秒) は
  `rust (windows)` (統合前の `rust (windows test)` 実測で約 260〜360 秒) より短くクリティカルパスではないため見送っています (#1872 の統合で `rust (windows)` はさらに伸び、クリティカルパスになりうる)。
  ブラウザテスト (約 120 秒) の shard 分割も同じ理由で見送りです。いずれも Windows 側が
  縮んでフロントがクリティカルパスになったら再検討してください (必須チェック名
  `frontend (build + browser tests)` は変えないこと)。

  **crosslang の実走対象の固定 (#1760)**: 命名規約外の `awsIam.test.ts` /
  `apiModuleLayout.test.ts` は ci.yml のステップに個別指定している。`src-tauri` を
  `from` / `import.meta.glob` で読むテストがすべてステップのフィルタに一致することを
  `crosslangGatingParity.test.ts` (メタテスト) が検査するので、規約外の名前で Rust を
  読むテストを足したらフィルタを足す (または `*Parity.test.ts` にする)。

  **`crosslang parity` ジョブ (#853)**: `ipcCommandParity.test.ts` (`?raw`
  インポートで `src-tauri/src/lib.rs` を読む) / `ipcArgParity.test.ts` /
  `streamEventParity.test.ts` (いずれも `import.meta.glob` で `src-tauri/src/`
  配下の `.rs` を網羅的に読む。前者は `commands/*.rs` 限定、後者は
  `src-tauri/src/**/*.rs` 再帰。#970) と
  `readOnlyGolden.test.ts` / `errorKindGolden.test.ts` / `errorHintGolden.test.ts` /
  `schemaParity.test.ts` / `serdeCoverageParity.test.ts` (#1243。
  `commands/**/*.rs` の `#[tauri::command]` 戻り値型を抽出し、すべてが serde ゴールデンの
  フィクスチャ (`COVERED`) か理由つき除外 (`EXCLUDED`) に分類されていることを強制する。
  新コマンドの戻り値型を足したら `serde_schema_parity.rs` に代表インスタンスを足し
  `NOOBDB_WRITE_SERDE_FIXTURES=1 cargo test --test serde_schema_parity` で再生成する) /
  `readOnlyGuardParity.test.ts` (#1778。同じく `#[tauri::command]` を抽出し、すべてが
  `WRITE_CAPABLE` (本体にガード参照を要求) か `READ_ONLY_SAFE` (理由つき) に分類
  されていることを強制する。新コマンドを足したら必ずどちらかへ追記する) /
  `channelMessageParity.test.ts` (#1772。`src-tauri/src/**/*.rs` を読み、`Channel<T>` の
  内部タグ enum の kind ⇔ `tauri.ts` の `switch` ⇔ Zod スキーマを両方向で照合する) /
  `sqlQuotingGolden.test.ts` (#880) /
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
  フィクスチャだけを変更する PR で `rust (test)` / `rust (coverage)` がスキップされる問題) は
  `changes` ジョブに追加した `crosslang` フィルタ (`src/__tests__/fixtures/**`
  限定) を `rust (test)` / `rust (coverage)` の `if:` へ OR で足すことで塞いでいます (#1029 でも
  変更していません)。**必須チェックを設定する場合はこの `crosslang parity`
  ジョブも対象に含めてください。**

  Rust 系は 7 つのジョブに分かれます: `rust (clippy)` が
  `cargo clippy --all-targets --locked -- -D warnings` (clippy が rustc ドライバ
  として型チェックを内包するので別途 `cargo check` は走らせません)、`rust (test)`
  が MySQL / PostgreSQL に対し
  **計装なしの** nextest (`--lib --test '*'`。テストの無い bin ターゲットはビルドしない) を実行します
  (PR ブロッキング)。nextest は `src-tauri/.config/nextest.toml` の
  `slow-timeout = { period = "20s", terminate-after = 15 }` で、20 秒超のテストに `SLOW` を出し、
  300 秒で強制終了して失敗扱いにします (#1635。SSH / TLS 待ちのハングがジョブの
  `timeout-minutes: 45` まで居座るのを防ぐ。観測した最長テストは約 40 秒)。正当に長いテストが
  増えたら `[[profile.default.overrides]]` で個別に延長します。CI 用の別プロファイルは無く、
  `rust (test)` / `rust (coverage)` / `rust (windows)` はすべて default を使います。
  カバレッジ計装は別ジョブ `rust (coverage)` に分離しています
  (#1153。下記)。起動条件は通常の
  `rust==true` に加え、上述の `crosslang` フィルタ (`src/__tests__/fixtures/**`)
  も OR で見ています (#853。フィクスチャのみの変更でも言語横断ゴールデンテストを
  確実に実走させるため)。同様に `ci-scripts` フィルタ (`scripts/ci-setup-*.sh`)
  もORで見ています (#1359。セットアップスクリプトだけの変更がPR上で無検証に
  ならないため)。`scripts/bundle-size.mjs` は `frontend` フィルタに含めています。
  `rust (test)` は加えて
  `scripts/ci-setup-sshd.sh` で apt の `openssh-server` を 127.0.0.1:2222 に立て、
  `NOOBDB_TEST_SSH_URL` / `NOOBDB_TEST_SSH_KEY` を `$GITHUB_ENV` に渡すことで SSH
  トンネル統合テスト (#331) も実走します (サービスコンテナはイメージ pull が要るため
  使わず、apt 構成で再現性を確保)。平文の MySQL (3306) / PostgreSQL (5432) も同じ理由で
  サービスコンテナをやめ、ランナー同梱のサーバを `scripts/ci-setup-plain-db.sh` で
  background 起動します (起動時の約 30 秒の待ちが消え、他のセットアップと重なる)。`rust (fmt)` が
  `cargo fmt --all -- --check` を、`rust (deny)` が
  `cargo deny --manifest-path src-tauri/Cargo.toml check` (依存ライセンスの許可
  リスト検査と RustSec Advisory DB による脆弱性チェック。設定は
  `src-tauri/deny.toml`) を実行します。`rust (deny)` は cargo metadata を読むだけで
  コンパイル不要なため、Tauri のシステム依存やフロントエンドビルドは要らず軽量に
  走ります (cargo-deny は他ツールと同じく `taiki-e/install-action` でプリビルド
  バイナリを導入)。`rust (test)` には MySQL 用の
  `NOOBDB_TEST_MYSQL_URL` と PostgreSQL 用の `NOOBDB_TEST_POSTGRES_URL` を両方
  渡しており、両ドライバの統合テストが CI で実走します (SQLite は環境変数不要で
  常に走る)。`rust (coverage)` ジョブは `rust (test)` と同じ準備 (平文 DB・sshd・
  TLS DB・dist スタブ。複製しており composite action 化はしていない) の上で
  計装 archive を `cargo llvm-cov nextest --archive-file ... --no-report` で実行し、`cargo llvm-cov report` で lcov を生成しつつ、サマリ表を
  Job Summary に出力して PR ごとに可視化し、加えて `--fail-under-lines` で行
  カバレッジの**下限を強制**します。閾値は**ラチェット式 (下げない)** で運用し
  (#482)、テスト整備で実測が上がったら実測をわずかに下回る値へ段階的に引き上げます
  (現在 Rust 60 / フロント `vite.config.ts` の `lines: 26`)。当面は branch/function/
  per-file ではなく lines 全体のみで運用します (誤検出回避)。閾値割れで落ちても
  Job Summary には実測が残るよう、強制ステップはサマリ出力の後に置いています。
  llvm-cov の計装には `llvm-tools-preview` コンポーネントと `cargo-llvm-cov` が
  必要で、いずれも `rust (coverage)` ジョブだけで導入しています。計装ビルド
  (`-C instrument-coverage`) は sccache がキャッシュしない遅いビルドで、以前は
  `rust (test)` に同居して全 PR のクリティカルパスになっていたため (#1153)、
  `rust (test)` と**並列**の別ジョブへ切り出しました。`if:` 条件 (rust /
  workflow / crosslang / ci-scripts の OR) と sccache / rust-cache の設定は `rust (test)` と同等
  ですが、キャッシュキーは `coverage` / `sccache-<os>-coverage-…` で分離しています。
  **`rust (coverage)` は必須チェックに含めません** (`--fail-under-lines` 割れは
  赤く出ますがマージはブロックしない運用)。
  さらに #1420 で **`rust (coverage)` は main への push でのみ走らせ、PR では
  スキップ**しています (`if:` の先頭に `github.event_name == 'push' &&`)。`rust (test)`
  と同一の最重量の統合環境 (sshd + TLS DB + 平文 DB) を PR ごとに二重に構築していた
  ため、rust に触れる PR の計算量をおよそ半減するのが目的です。60% の閾値ゲートと
  Job Summary の可視化は main で維持し、閾値割れはマージ直後の main の赤で検出します。
  PR でカバレッジを見たい場合は、マージ後の main の実行結果を参照してください。
  #1884: main push では統合環境と全件実行を `rust (coverage)` に一本化しました。
  `rust (test)` は push では `nextest archive` によるビルドだけを行い (main スコープの
  rust-cache / sccache (キー `test`) を保存して PR のフォールバック復元元になるため)、
  sshd / TLS DB / 平文 DB のセットアップと `cargo nextest` は `github.event_name != 'push'`
  でスキップします (PR は従来どおり)。push の統合テスト失敗は `llvm-cov nextest` が赤く
  します。また coverage の計装ビルドは `cargo llvm-cov nextest-archive`
  で DB セットアップの `wait` 前に済ませて重ね、`wait` 後は archive から
  `cargo llvm-cov nextest --archive-file ... --no-report` するだけにしています (cargo を再度呼ぶと NOOBDB_TEST_* の違いで
  再コンパイルされ、重ねた分が相殺されるため。`rust (test)` と同じ理由)。
  clippy (cargo check 相当) と nextest (実バイナリ生成) は cargo が成果物を共有
  しないため、同一ジョブで直列にすると依存ツリーが二重コンパイルされて積み上がり
  ます。これを別ジョブで**並列**に走らせて壁時計時間を縮めています (rust-cache の
  `key` を `clippy` / `test` に分けてキャッシュを分離)。両 Rust ジョブとも CI では
  無益な incremental コンパイルを `CARGO_INCREMENTAL=0` で無効化しています。
  残る `rust (windows)` は `windows-latest` 上で `cargo clippy` →
  `cargo nextest run` を 1 ジョブで直列実行し、Windows 固有
  (keyring・ファイルパス・改行コード・MSVC リンカ `lld-link`) のリグレッションを
  PR 段階で検出します (#392)。以前は clippy と nextest を別ジョブに分割していたが、
  課金が 2 倍で最遅の windows-latest で rust-cache / sccache の鍵が別 (成果物を共有しない)
  まま依存ツリーを 2 ランナーで二重にビルドしていたため、#1872 で単一ジョブに統合した
  (セットアップとキャッシュ保存・復元が 1 回分になり計算量が減る代わりに、壁時計時間は
  clippy + test の合計に伸び、`rust (windows)` がクリティカルパスになりうる。依存ライブラリの
  check (rmeta) と codegen は共有されないので 2 本目のコマンドで再コンパイルが無くなるわけでは
  ないが、build script の実行結果と proc-macro は同じプロファイル (`CARGO_PROFILE_DEV_DEBUG=0`)
  なので共有される。nextest は clippy が落ちても実行する)。チェック名は `rust (windows)` に変わった。MySQL/
  PostgreSQL の URL 環境変数を渡さないため統合テストはスキップされ、外部サービス
  不要の SQLite 統合テストのみ実走します。Tauri の全スタックビルド (WebView2 等) は
  不要で MSVC toolchain だけで足り、rust-cache の `key` は `windows` で Linux と分離しています。
  `rust (test)` は sshd / TLS DB のセットアップ (約 1 分) を待たずに
  `cargo nextest archive` でテストバイナリのビルドを先に始め、wait の後にアーカイブから実行します
  (NOOBDB_TEST_* は実行時にしか読まないためコンパイルと重ねられる。アーカイブ経由なので
  環境変数の違いによる再コンパイルも起きない)。
  Rust の統合テストは `src-tauri/Cargo.toml` の `[[test]]` で 4 本の実行ファイルに束ねてあり
  (golden / integration / external と単独の serde_schema_parity。`autotests = false`。詳細は
  `noobdb-testing` の commands.md)、リンク回数を減らしています。`rust (windows)` は
  env ゲートで 0 件実行になる external を対象から外し、`--test golden --test integration
  --test serde_schema_parity` を明示しています (#1511。`[[test]]` を足したらここにも追加)。Windows ジョブは
  `CARGO_PROFILE_DEV_DEBUG=0` (PDB を出さない) と Defender のリアルタイム保護 OFF を使います。
  フロントの単体テストは `--shard` の 4 分割 (上記) です (`--project` で dom / node に分ける案は、blob を統合したカバレッジが大きく低く出るため不可)。
  `rust (windows)` は `cargo nextest run` の前に、registry の index だけを自前の
  `actions/cache` (`cargo-index-…`、保存は main の push のみ) で復元する (rust-cache は sparse index を
  復元しないため。PR #1721 で `cargo fetch --offline` が `no matching package` で失敗して判明)。そのうえで
  `cargo fetch --locked --offline --target x86_64-pc-windows-msvc` で全部そろっているか確かめ、成功なら
  `CARGO_NET_OFFLINE=true` にして `Updating crates.io index` (実測 約 26 秒) を省く (#1680。
  失敗時はオンラインのまま)。同ジョブの実測内訳 (2026-10-18 JST の main push, 計 約 255 秒):
  セットアップ 約 75 秒 (Setup Rust 23 / rust-cache 24 / sccache 復元 9)、index 更新 26、
  `noobdb` 本体コンパイル 97、テスト実行 46 (1864 件)。(統合前の内訳。#1872 で clippy と同一ジョブに統合した。)
  Windows ジョブは rust-cache (`save-if`) と sccache (`actions/cache/restore` +
  `actions/cache/save`) の**保存を main の push だけ**にしています (保存が約 1 分かかり、
  PR のキャッシュは他 PR から参照できないため。PR は main スコープを復元するだけ)。
  さらに `rust (clippy)` / `rust (test)` / `rust (coverage)` /
  `rust (windows)` の各コンパイルジョブは
  **sccache** を `RUSTC_WRAPPER` として有効化し (`taiki-e/install-action` で導入)、
  `SCCACHE_DIR` を `actions/cache` で永続化してブランチ跨ぎでコンパイル単位を再利用
  します (#417)。rust-cache が `target` ディレクトリをキャッシュするのに対し sccache
  は rustc 呼び出し単位をキャッシュする役割分担で、キャッシュキーは
  `sccache-<os>-<job>-<Cargo.lock ハッシュ>` で分離します。`config.toml` の sccache
  設定はコメントアウトのままで、CI 限定で環境変数により有効化しています。なお
  `rust (coverage)` のカバレッジ計装ビルド (`-C instrument-coverage`) は sccache が
  キャッシュ対象外として素通しするため、sccache の効果は主に clippy / test / windows
  ジョブと依存クレートのコンパイルに現れます。
  **必須チェックを設定する場合は `rust (check + clippy + test)` や旧
  `rust (windows)` ではなく `rust (clippy)` と `rust (test)` (必要なら
  `rust (deny)` / `rust (windows)`) を
  指定してください** (ジョブ分割でチェック名が変わったため)。`rust (test)` の名前は
  #1153 の分割後も不変なので、既存の必須設定の変更は不要です。`rust (coverage)` は
  必須に**含めないでください**。

## `automerge gate (script tests)` ジョブ (#1108)

`scripts/*.test.mjs` (`automerge.yml` の変更依頼ゲート (Step 4b) の判定ロジック
`scripts/automerge-hold.mjs` のテストと、定期ジョブの通知スクリプト
`scripts/upsert-tracking-issue.sh` のテスト (#1633) など) を `node --test` で
実行する軽量ジョブです (ローカルでは `pnpm run test:scripts`)。
Node 標準の `node:test` だけを使い依存ゼロなので `pnpm install` はしません。
`changes` ジョブの `automerge` フィルタ (上記のスクリプトとテスト + `automerge.yml`) か
`workflow` が true のときだけ走ります。**必須チェックではありません**。
Vitest (`src/__tests__/`) ではなく `node:test` にしているのは、ワークフローが
実行時に `node scripts/automerge-hold.mjs` を素の Node で直接呼ぶため
(TypeScript / Vite を介さない同じ形でテストする) です。

## `e2e.yml` (tauri-driver 実 webview E2E, nightly / #1245)

`ci.yml` とは別の独立ワークフローで、`schedule: cron` (毎晩 UTC 18:00) と
`workflow_dispatch` で走る。**必須チェックに含めない** (PR ゲートにもしない)。
Linux (ubuntu-22.04) の WebKitGTK のみが対象で、SQLite の一時ファイルだけで完結する。
tauri-driver は `taiki-e/install-action` の対応ツールではないため、
`~/.cargo/bin/tauri-driver` を `actions/cache` で保持し、miss のときだけ
`cargo install --locked` する (更新時はキーの `v1` を上げる)。失敗時は
`e2e/screenshots/` と `e2e/logs/` をアーティファクト保存する。
「3 回連続グリーン」と「15 分以内」は確認済み (2026-10-03 JST、run 18〜20、約 11〜12 分)。
詳細・testid 一覧は `noobdb-testing` スキルの `references/e2e.md`。

## `mutants-diff.yml` (PR 差分の `cargo mutants --in-diff` / #1841)

`ci.yml` とは別の独立ワークフロー。手動 (`workflow_dispatch`) の `mutants.yml` (全件 4 シャード、
定期実行ではない。変更しない) の補完として、安全網ファイル (`src-tauri/.cargo/mutants.toml` の
`examine_globs` と同じ `db/mod.rs` / `mysql.rs` / `postgres.rs` / `sqlite.rs` / `sync.rs` /
`data_diff.rs` / `lib.rs`、加えて `script_analysis.rs` と `masking.rs`、`mutants.toml` 自体と本
ワークフロー) を変更した PR だけで起動し、新しく入った未カバー分岐 (生存変異) を PR 時点で報告する。
**必須チェックにしない** (可視化専用で fail させない)。

- 起動条件はワークフロー単位の `on.pull_request.paths`。必須チェックではないので、`ci.yml` の
  ような paths-filter + ジョブ単位 `if:` にしなくてよい (スキップで「待機中」固まりが起きない)。
  `examine_globs` や `EXTRA_FILES` を足す・外すときは `paths:` も揃える。
- 対象関数・タイムアウト倍率は `mutants.toml` が単一ソース (`mutants.yml` と共有)。そのうえで
  `mutants.yml` のスコープは変えず、本ジョブだけ CLI で `script_analysis.rs` (危険文の検出) と
  `masking.rs` (マスク処理) を足す。ワークフローの `EXTRA_FILES` を `-f`、`EXTRA_RE` を `-F` で
  渡す (実際のコマンドは `cargo mutants --in-diff diff -f src/db/script_analysis.rs
  -f src/db/masking.rs -F "$EXTRA_RE" ...`。`-f` は配列で組み立てる)。cargo-mutants 27.1 では CLI の
  `--file` / `--re` は config の `examine_globs` / `examine_re` と**併用 (和集合)** で、置き換えでは
  ない (`options.rs`。NEWS の「置き換え」は旧仕様)。ファイルだけ足しても config の `examine_re` が
  関数名で全件落として 0 件になるため、足したファイルの関数名は `EXTRA_RE` にも要る。名前マッチは
  ファイルを問わないので、同名関数に効く (`is_word_byte` は `db/mod.rs` にもあるため入れない。
  型 / モジュールで修飾できるものは修飾する)。関数を足す・外すときは `EXTRA_RE` を直し、
  `cargo mutants --in-diff diff -f <file> -F <re> --list` で確認する。
- 差分は `git diff --relative=src-tauri origin/<base>...HEAD -- src-tauri > src-tauri/diff`。
  cargo-mutants は `src-tauri` を木のルートとするため `src-tauri/` 接頭辞を落とす
  (cargo-mutants 27.1 で `db/mod.rs` / `masking.rs` / `script_analysis.rs` の一時的な差分を使い、
  変異候補が出ることをローカルで確認済み)。
- まず `cargo mutants --in-diff diff ... --list --json` で差分内の変異候補を数え (ビルド不要で軽い)、
  0 件なら apt / ビルド系のステップを丸ごと飛ばす (`lib.rs` だけ触る PR など)。構造体フィールド
  削除 (`genre == StructField`) は CLI で除外できないので数えるときに除き、除いた件数は Summary に
  別掲する (本体の実行では走るので実行時間には含まれる。集計からは除外する)。`--list` 自体の失敗 (設定 / 正規表現エラー) は 0 件と区別して Summary と
  `::warning` に出す。差分が `src-tauri` に及ばず空のときは終了コード 0 / 出力が空になり 0 件扱い。
- 本体は `--in-place --no-shuffle --in-diff diff` (`--in-place` の理由は `mutants.yml` 参照)。
  Run ステップは `timeout-minutes: 32` + `continue-on-error: true` で、打ち切られても後段へ進む。
  生存変異は `outcomes.json` から `$GITHUB_STEP_SUMMARY` に列挙し (`StructField` は除外)、`::warning`
  も出す。終了コードが 0 / 2 / 3 以外 (baseline 失敗など)、打ち切り、検査件数 0 は「生存 0 件」では
  なく実行失敗 / 部分結果として表示する。Report は `list` が成功したときだけ走り、Run が
  `skipped` (前段のセットアップ失敗) なら「実行されていません」、exit_code が空で
  `failure` / `cancelled` なら「打ち切り」と出し分ける。`mutants.out/` ・diff・list 結果は artifact
  `mutants-diff-out` (14 日) に保存。ジョブは 40 分で打ち切り、同一 PR の古い run は取り消す。
- ジョブ ID と `rust-cache` の `key` は `mutants.yml` と同じ `mutants`。main で `mutants.yml` を手動
  実行したキャッシュは PR の初回 run でも復元されるが、定期実行がないので通常は初回が cold で、
  同じ PR の 2 回目以降の push から効く。actions は同じ SHA ピン。
