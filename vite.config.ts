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
    // カバレッジ品質ゲート (#290)。フロントエンド全体はまだコンポーネント
    // テストが揃っておらず (全体では数 % 台)、全ファイルに高い閾値を課すのは
    // 非現実的。そこで「安全性・正確性に直結し、実際にテストで守りたい純粋
    // ロジック + 危険操作の確認ダイアログ」に対象を絞り、その実測値 (lines
    // 約 80%) を下回ったら CI を fail させる。対象とテストが増えたら閾値を
    // 段階的に引き上げる。閾値は `--coverage` 有効時のみ評価されるため、素の
    // `pnpm test` は従来どおり高速に動く (CI は `--coverage` 付きで実行)。
    coverage: {
      provider: "v8",
      all: true,
      include: [
        "src/dangerousSql.ts",
        "src/components/cellEdit.ts",
        "src/components/sqlDialect.ts",
        "src/tabPersistence.ts",
        "src/components/DangerousQueryDialog.tsx",
      ],
      thresholds: { lines: 75 },
    },
  },
}));
