import { chakra } from "@chakra-ui/react";

/**
 * 設定画面 / ヘルプ画面で共有する Chakra レイアウトプリミティブ群。
 *
 * `SettingsView` と `HelpView` が同じセクション
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
  base: { display: "flex", flexDirection: "column", gap: "2" },
});

export const SettingsSectionHeader = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "3",
    "& h3": { margin: 0, fontSize: "md", fontWeight: 600, color: "app.text" },
  },
});

// セクションナビ (左ペイン) のレイアウト要素。
export const SettingsNavAside = chakra("aside", {
  base: {
    position: "sticky",
    top: "0",
    alignSelf: "flex-start",
    display: "flex",
    flexDirection: "column",
    gap: "2",
    minW: "180px",
    maxW: "220px",
    maxH: "calc(90vh - 120px)",
    overflowY: "auto",
    flexShrink: 0,
    "& input": { fontSize: "sm" },
  },
});

export const SettingsNavList = chakra("div", {
  base: { display: "flex", flexDirection: "column", gap: "0.5" },
});

export const SettingsNavButton = chakra("button", {
  base: {
    textAlign: "left",
    px: "2.5",
    py: "1.5",
    fontSize: "sm",
    fontWeight: 500,
    color: "app.textSecondary",
    background: "transparent",
    border: "none",
    borderRadius: "sm",
    cursor: "pointer",
    transitionProperty: "background, color",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { background: "app.hover", color: "app.text" },
    "&[aria-current=true]": {
      background: "app.hover",
      color: "app.text",
      fontWeight: 600,
    },
  },
});

export const SettingsNavEmpty = chakra("p", {
  base: { margin: 0, px: "2.5", py: "1", fontSize: "sm", color: "app.textMuted" },
});
