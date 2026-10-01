import type { IconName } from "./Icon";
import type { I18nKey } from "../i18n";

/**
 * タブが 1 つも無い空状態 (#1271) の補助導線。主操作は「新しいクエリ」のまま、
 * 次の一手として SQL ファイル / スニペット / ER 図 / コマンドパレットへ 1 クリックで
 * 行けるようにする。並び順と文言キー・アイコンをここに固定し (純ロジック)、
 * ハンドラとパレットのショートカット表記は呼び出し側 (App.tsx) が渡す。
 */
export type TabsEmptyActionId = "openSqlFile" | "snippets" | "erDiagram" | "commandPalette";

export interface TabsEmptyActionDef {
  id: TabsEmptyActionId;
  labelKey: I18nKey;
  icon: IconName;
}

export const TABS_EMPTY_ACTIONS: readonly TabsEmptyActionDef[] = [
  { id: "openSqlFile", labelKey: "tabsEmptyOpenSqlFile", icon: "upload" },
  { id: "snippets", labelKey: "tabsEmptySnippets", icon: "snippet" },
  { id: "erDiagram", labelKey: "tabsEmptyErDiagram", icon: "er-diagram" },
  { id: "commandPalette", labelKey: "tabsEmptyCommandPalette", icon: "search" },
];

export interface TabsEmptyActionItem {
  id: TabsEmptyActionId;
  label: string;
  icon: IconName;
  /** 表示専用のショートカット (例: `Ctrl+K`)。無ければ省略。 */
  shortcut?: string;
  onClick: () => void;
}

/** 定義 + ハンドラ + 解決済み文言から、EmptyState に渡す補助アクション列を作る。 */
export function buildTabsEmptyActions(
  translate: (key: I18nKey) => string,
  handlers: Record<TabsEmptyActionId, () => void>,
  paletteShortcut?: string,
): TabsEmptyActionItem[] {
  return TABS_EMPTY_ACTIONS.map((def) => ({
    id: def.id,
    label: translate(def.labelKey),
    icon: def.icon,
    shortcut: def.id === "commandPalette" ? paletteShortcut : undefined,
    onClick: handlers[def.id],
  }));
}
