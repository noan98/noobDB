import { chakra } from "@chakra-ui/react";

/**
 * 設定画面 / ヘルプ画面で共有する Chakra レイアウトプリミティブ群。
 *
 * 元々は `App.css` の `.settings*` クラスで描画していたものを style props を持つ
 * Chakra コンポーネントへ移植したもの。`SettingsView` と `HelpView` が同じセクション
 * 構造を共有するため共通化している。両画面はモーダル (`Modal`) 内に描画されるため、
 * 外枠 (スクロールペイン + ヘッダ) は `Modal` / `ModalHeader` / `ModalBody` が担い、
 * ここではセクション内のプリミティブだけを提供する。
 *
 * スキーマ比較ビュー (`SchemaCompareView`) はまだ `.settings` / `.settings-header`
 * / `.settings-help` クラスを使っているため、対応する CSS ルールは当面残している。
 */

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
