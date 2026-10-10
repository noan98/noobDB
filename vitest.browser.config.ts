/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Vitest ブラウザモード設定。jsdom の純ロジック/挙動テスト (vite.config.ts)
// とは実行環境が異なるため、設定ファイルを分離している。こちらは実ブラウザ
// (Playwright provider + headless Chromium) に主要画面をマウントし、(1) 描画の
// スモーク (screens.browser.test.tsx)、(2) ライト/ダークのビジュアル回帰
// (visual.browser.test.tsx) を実行する。
//
// テストファイルは `*.browser.test.tsx` という専用 glob に限定し、jsdom スイート
// (`*.test.tsx`) とは include/exclude で互いに衝突しないようにしている (vite.config.ts
// 側でも `**/*.browser.test.tsx` を除外)。
//
// 実行: `pnpm test:browser` (比較) / `pnpm test:browser:update` (ベースライン更新)。
// CI では Playwright の Chromium を `npx playwright install --with-deps chromium` で
// 導入してから実行する (.github/workflows/ci.yml の frontend-visual ジョブ)。
export default defineConfig({
  plugins: [react()],
  // 遅延ロードされる画面 (エディタ・アクセシビリティ検査・Tauri プラグイン) の依存は、
  // App を描画しないテストファイルが先に走ると実行途中で初めて発見される。そのとき Vite が
  // 依存を再最適化してページをリロードし、並行中のテストが React の二重読み込み
  // (`useRef` of null) で落ちる (#1270)。起動時にまとめて最適化させて実行順に依存させない。
  optimizeDeps: {
    include: [
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/highlight",
      "sql-formatter",
      "@tauri-apps/api/app",
      "@tauri-apps/api/webview",
      "@tauri-apps/api/window",
      "@tauri-apps/plugin-notification",
      "@tauri-apps/plugin-process",
      "@tauri-apps/plugin-updater",
      "axe-core",
      // SQL 補完の種別アイコンを静的 SVG に描くため、遅延ロードされるエディタが
      // `react-dom/client` を読む (#1413)。同じ理由で起動時に最適化しておく。
      "react-dom/client",
    ],
  },
  test: {
    include: ["src/__tests__/browser/**/*.browser.test.tsx"],
    setupFiles: ["./src/__tests__/browser/setup.browser.ts"],
    css: true,
    // シナリオテスト (#564) は App 全体をマウントし、接続 → ツリー → タブ →
    // ストリーミングと多段の操作を行う。lazy チャンクの初回ロードが乗る CI の
    // コールドスタートでも完走できるよう、テスト全体と locator 自動リトライ
    // (expect.element / expect.poll) の上限を広めに取る。
    testTimeout: 30_000,
    expect: { poll: { timeout: 5_000 } },
    browser: {
      provider: playwright(),
      enabled: true,
      headless: true,
      // ビューポートを固定して描画寸法を決定的にする (ビジュアル回帰の安定化)。
      viewport: { width: 1280, height: 800 },
      instances: [{ browser: "chromium" }],
    },
  },
});
