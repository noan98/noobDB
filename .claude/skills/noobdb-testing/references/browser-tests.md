# 実ブラウザでの画面テスト (Vitest ブラウザモード / #306)

## 実ブラウザでの画面テスト (Vitest ブラウザモード / #306)

`pnpm test` (jsdom。`references/commands.md` 参照) は純ロジックとコンポーネント挙動を見るもので、**実際に
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
- **このワークフローの push には Secrets `VISUAL_BASELINE_PAT` を使います (任意だが
  強く推奨)。** GitHub は再帰防止のため **`GITHUB_TOKEN` で push したコミットからは
  新しいワークフロー実行を起動しません**。PR ブランチへベースライン更新を push すると、
  新しい head に対して作られる `ci` / `pr-conflict` / `codeql` の実行はいずれも
  **`action_required` (承認待ち) のまま 1 ジョブも走らずに完了扱い**になり、PR の
  必須チェックが永久に「待機中」で止まります (実例: PR #1083。人が Actions タブから
  各実行を手動で再実行すれば解消しますが、気付きにくく毎回手作業が要ります)。
  そのため checkout の `token` を
  `${{ secrets.VISUAL_BASELINE_PAT || github.token }}` とし、PAT があればそちらで
  push します (PAT の push は通常どおり下流のワークフローを起動します)。
  **セットアップ (メンテナ作業)**: 本リポジトリへの **Contents: Read and write**
  権限を持つ fine-grained PAT (classic なら `repo` スコープ) を発行し、Secrets に
  `VISUAL_BASELINE_PAT` として登録してください。ワークフローファイル自体は push
  しないので `workflow` スコープは不要です。**未登録でもワークフローは従来どおり
  動きます**が、その場合は上記の承認待ちが起きることを `::warning::` と Job Summary
  に出して黙って詰まらせないようにしています (バンドルサイズ #443 ・カバレッジ #482
  と同じ「まず可視化」の漸進方針)。
- CI では `ci.yml` の **`frontend` ジョブ (チェック名 `frontend (build + browser
  tests)`)** が、jsdom 単体テスト等の後続ステップとして Playwright の Chromium を
  導入して `pnpm test:browser` を実行します。旧来は jsdom 側と別ジョブ
  (`frontend-visual`) でしたが、pnpm install・Vite トランスパイルの重複を解消する
  ため 1 ジョブに統合しています (#908。詳細は `noobdb-ci` スキルと `ci.yml` の
  コメントを参照)。現状はスモークのみが走り、ビジュアル回帰はベースライン整備後に
  `VITE_RUN_VISUAL=1` で有効化する想定です。**必須チェックを設定する場合はこの
  ジョブ名 (`frontend (build + browser tests)`) を指定してください** (旧
  `frontend (typecheck + build)` / `frontend (browser render + visual)` は
  #908 で消えています)。
- 既知の限界: Chromium 上の検証であり、Tauri が実際に使う webview (Linux: WebKitGTK
  / Windows: WebView2) とは描画エンジンが異なります。移行に伴う Web 層のレイアウト/
  見た目退行は十分捕捉できますが、実 webview 固有の描画差はカバー範囲外です
  (将来のフル Tauri E2E = Phase 3 の領域)。
