/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Vitest 設定。コンポーネントテスト (React Testing Library) のために jsdom
  // 環境を使う。純粋ロジックのテストも jsdom 上で問題なく走る。setup.ts で
  // jest-dom のマッチャ拡張と各テスト後の DOM クリーンアップを行う。
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    css: true,
    // 実ブラウザ用テストは jsdom では動かない (vitest/browser を import)。
    // 実行環境が異なるため別 glob (`*.browser.test.tsx`) に分け、専用設定
    // (vitest.browser.config.ts) でのみ実行する。ここでは jsdom スイートから除外する。
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/src/__tests__/browser/**",
      "**/*.browser.test.tsx",
    ],
    // カバレッジ計測。
    //
    // `all: true` と `include: src/**` により、テストから一度も実行されない
    // ファイルも 0% として表に現れるようにし、テストの空白地帯を可視化する。
    // 除外するのはテスト自身・型宣言・エントリポイント (main.tsx) など、
    // ユニットテストで意味のある計測ができないものに限る。
    //
    // 閾値はラチェット式 (下げない) で運用する。テスト整備の進捗に応じて
    // 実測カバレッジを**わずかに下回る**値へ段階的に引き上げ、品質の後退を防ぐ
    // (lines: 26 は実測−約 3pt のベースライン)。引き上げは行うが
    // 下げないのが原則 (新規コードが無テストでも通る余地を狭め、退行を検出する)。
    // 当面は branch/function/per-file ではなく lines 全体のみで運用する (誤検出回避)。
    // 閾値は `--coverage` 有効時のみ評価され、素の `pnpm test` は従来どおり高速に
    // 動く (CI は `--coverage` 付きで実行)。
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/__tests__/**",
      ],
      thresholds: { lines: 26 },
    },
  },
}));
