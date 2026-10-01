/// <reference types="vitest/config" />
import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// 描画性能ベンチマーク (#1307) 専用の設定。`pnpm bench:ui` で実行する。
//
// App 全体を実 Chromium にモック接続で描画し、タブ切替・スキーマツリーのスクロール・
// エディタ入力・サイドバー幅のドラッグの処理時間を測る。数値は CI の合否に使わない
// (マシン負荷で揺れるため) ので、`pnpm test:browser` とは include を分けて CI から外す。
//
// 計測の考え方と結果の読み方は `.claude/skills/noobdb-testing/references/perf-bench.md`。
//
// クラウド実行環境では Playwright が期待する Chromium のビルド番号と同梱の Chromium が
// 一致しないため、同梱の実体を直接指す。ローカルで `pnpm exec playwright install` 済みなら
// 指定は不要 (`PLAYWRIGHT_CHROMIUM_PATH` で明示的に上書きもできる)。
const BUNDLED_CHROMIUM = "/opt/pw-browsers/chromium";
const chromiumPath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (existsSync(BUNDLED_CHROMIUM) ? BUNDLED_CHROMIUM : undefined);

export default defineConfig({
  plugins: [react()],
  // vitest.browser.config.ts と同じ理由 (#1270): 遅延ロードされる画面の依存を起動時に
  // まとめて最適化させ、計測中に Vite の再最適化 → リロードが割り込まないようにする。
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
    ],
  },
  test: {
    include: ["src/__tests__/perf/**/*.perf.tsx"],
    setupFiles: ["./src/__tests__/browser/setup.browser.ts"],
    css: true,
    // シナリオを順に 1 本ずつ流す (並列にすると互いの計測を乱す)。
    fileParallelism: false,
    testTimeout: 900_000,
    expect: { poll: { timeout: 15_000 } },
    browser: {
      provider: playwright(
        chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {},
      ),
      enabled: true,
      headless: true,
      viewport: { width: 1280, height: 800 },
      instances: [{ browser: "chromium" }],
    },
  },
});
