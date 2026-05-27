import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

/**
 * Chakra UI システムの基盤定義。
 *
 * noobDB の見た目は `App.css` の CSS 変数 (`--bg` / `--accent` / `--text` など)
 * を正としており、ダークモードとワークスペースアクセント色はそれらの変数を
 * 差し替えることで実現している。ここでは Chakra のトークンを **その CSS 変数を
 * 指す** だけにすることで、Chakra 製コンポーネントを既存テーマ・ダークモードへ
 * 重複なく自動追従させる (値を二重管理しない)。
 *
 * `preflight: false` で Chakra のグローバル CSS リセットを無効化している。
 * 既存の 4,000 行超の `App.css` と共存させるための必須設定で、これを外すと
 * 全画面のマージン/ボックスモデルがリセットされて表示が崩れる。
 */
const config = defineConfig({
  preflight: false,
  theme: {
    tokens: {
      fonts: {
        body: { value: "var(--font-sans)" },
        heading: { value: "var(--font-sans)" },
        mono: { value: "var(--font-mono)" },
      },
      radii: {
        sm: { value: "var(--radius-sm)" },
        md: { value: "var(--radius-md)" },
        lg: { value: "var(--radius-lg)" },
        pill: { value: "var(--radius-pill)" },
      },
      // 既存デザイントークンへの色ブリッジ。`app.*` 名前空間に隔離して
      // Chakra 既定のセマンティックカラーを壊さないようにしている。
      colors: {
        app: {
          bg: { value: "var(--bg)" },
          surface: { value: "var(--bg-elevated)" },
          surfaceMuted: { value: "var(--bg-muted)" },
          hover: { value: "var(--bg-hover)" },
          text: { value: "var(--text)" },
          textSecondary: { value: "var(--text-secondary)" },
          textMuted: { value: "var(--text-muted)" },
          border: { value: "var(--border)" },
          borderStrong: { value: "var(--border-strong)" },
          accent: { value: "var(--accent)" },
          accentHover: { value: "var(--accent-hover)" },
          accentText: { value: "var(--accent-text)" },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
