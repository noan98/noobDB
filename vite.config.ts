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
    exclude: ["node_modules/**", ".claude/**"],
    css: true,
    // カバレッジ計測 (#290 で導入 → #356 で対象を src/ 全体へ拡大)。
    //
    // 当初は「安全性に直結する純粋ロジック + 確認ダイアログ」の 6 ファイルだけを
    // 対象にしており、サマリーが実態 (大半の UI コンポーネントが無テスト) を
    // 反映していなかった。`all: true` と `include: src/**` により、テストから
    // 一度も実行されないファイルも 0% として表に現れるようにし、テストの空白
    // 地帯を可視化する (#356)。これにより RTL テスト追加 (#354) の優先付けが
    // 行える。除外するのはテスト自身・型宣言・エントリポイント (main.tsx) など、
    // ユニットテストで意味のある計測ができないものに限る。
    //
    // 閾値は src/ 全体への拡大に合わせて低く再設定する。全体ではまだ数 % 台で、
    // 高い閾値は非現実的なため、ビルドを壊さない下限 (lines: 5) を置き、退行
    // (テスト削除によるカバレッジ消失) のみを検出する。コンポーネントテストの
    // 追加に合わせて段階的に引き上げる。閾値は `--coverage` 有効時のみ評価され、
    // 素の `pnpm test` は従来どおり高速に動く (CI は `--coverage` 付きで実行)。
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/__tests__/**",
      ],
      thresholds: { lines: 5 },
    },
  },
}));
