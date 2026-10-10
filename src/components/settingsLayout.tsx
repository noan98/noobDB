import type { ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";

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

const SettingsInfoButton = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    p: "0.5",
    color: "app.textMuted",
    background: "transparent",
    border: "none",
    borderRadius: "pill",
    cursor: "help",
    transitionProperty: "color",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { color: "app.text" },
    _focusVisible: { outline: "none", boxShadow: "var(--focus-ring)" },
  },
});

/**
 * 設定項目の詳しい説明を出すインフォメーションアイコン。説明文を常時表示すると
 * 設定画面が文章で埋まるため、ラベルの横にアイコンだけを置き、hover / フォーカス /
 * クリックで吹き出しに本文を出す。吹き出しは `Tooltip` が `aria-describedby` で
 * ボタンに結び付けるので、キーボードでフォーカスすると読み上げにも本文が載る。
 * クリックでは `openOnClick` で即時に開く (クリック由来のフォーカスでは
 * ツールチップを開かない規約のため、フォーカス経路には頼らない)。
 */
export function SettingsInfo({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <Tooltip label={children} maxWidth="360px" openOnClick>
      <SettingsInfoButton type="button" aria-label={t("settingsInfoAria")}>
        <Icon name="info" size={ICON_SIZES.sm} />
      </SettingsInfoButton>
    </Tooltip>
  );
}

/** ラベルとインフォメーションアイコンを横に並べる入れ物。 */
export const SettingsLabelWithInfo = chakra("span", {
  base: { display: "inline-flex", alignItems: "center", gap: "1", minW: 0 },
});

// ラベル (と ⓘ) を左、トグル・選択欄などの操作部品を右端に寄せる。
export const SettingsToggleRow = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "2.5",
    p: "2",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
  },
});

export const SettingsToggleLabel = chakra("label", {
  base: {
    margin: 0,
    fontSize: "md",
    fontWeight: 500,
    color: "app.text",
    display: "inline-flex",
    alignItems: "center",
    gap: "2",
  },
});

// 数値・選択の行。ラベルが残りの幅を取り、入力欄 (固定幅) を右端に置く。
export const SettingsNumberRow = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "3",
    px: "2",
    py: "1.5",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    borderRadius: "md",
    bg: "app.surfaceMuted",
    "& > :first-child": { flex: 1, minW: 0 },
    "& > input, & > select": { width: "120px", flexShrink: 0 },
    "& label": { margin: 0, fontSize: "md", fontWeight: 500, color: "app.text" },
    "& input": { fontSize: "md", borderRadius: "sm" },
  },
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
