import { chakra } from "@chakra-ui/react";

/**
 * 設定画面 / ヘルプ画面で共有する Chakra レイアウトプリミティブ群。
 *
 * 元々は `App.css` の `.settings*` クラスで描画していたものを style props を持つ
 * Chakra コンポーネントへ移植したもの。`SettingsView` と `HelpView` が同じ画面
 * 構造 (スクロールするペイン + ヘッダ + セクション) を共有するため共通化している。
 *
 * スキーマ比較ビュー (`SchemaCompareView`) はまだ `.settings` / `.settings-header`
 * / `.settings-help` クラスを使っているため、対応する CSS ルールは当面残している。
 */

export const SettingsPane = chakra("div", {
  base: {
    flex: 1,
    overflowY: "auto",
    px: "24px",
    py: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
  },
});

export const SettingsHeader = chakra("header", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    borderBottom: "1px solid",
    borderColor: "app.border",
    pb: "10px",
    "& h2": { margin: 0, fontSize: "lg", fontWeight: 600, color: "app.text" },
  },
});

export const SettingsHelp = chakra("p", {
  base: { margin: 0, fontSize: "sm", color: "app.textMuted" },
});

export const SettingsSection = chakra("section", {
  base: { display: "flex", flexDirection: "column", gap: "var(--space-2)" },
});

export const SettingsSectionHeader = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    "& h3": { margin: 0, fontSize: "md", fontWeight: 600, color: "app.text" },
  },
});
