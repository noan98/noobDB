import type { I18nKey } from "./i18n";

/**
 * キーボードショートカット定義の単一ソース (#448)。
 *
 * 従来 `HelpView` の中にだけ存在していたショートカット一覧を、ここへ切り出して
 * 一元管理する。`HelpView` のショートカット節と、`?` キーで開くチートシート
 * オーバーレイ (`ShortcutCheatSheet`) の双方がこの配列を参照するため、定義の
 * 二重管理が起きない。表示文言は i18n キー越しに引くので、英語/日本語の両方で
 * 一貫したラベルになる。
 *
 * `category` はチートシートでの見出しグルーピングに使う。`HelpView` はフラットな
 * 一覧として描画するためカテゴリを無視してよい。
 */

/** チートシートでの見出し分類。 */
export type ShortcutCategory = "global" | "editor" | "grid" | "tabs";

export interface ShortcutDef {
  /** キー表記の i18n キー (例: "Cmd/Ctrl+Enter")。 */
  keysKey: I18nKey;
  /** 説明文の i18n キー。 */
  descKey: I18nKey;
  category: ShortcutCategory;
}

/** カテゴリ見出しの i18n キー。チートシートのセクション順にも対応する。 */
export const SHORTCUT_CATEGORY_LABEL: Record<ShortcutCategory, I18nKey> = {
  global: "shortcutCatGlobal",
  editor: "shortcutCatEditor",
  grid: "shortcutCatGrid",
  tabs: "shortcutCatTabs",
};

/** チートシートのセクション表示順。 */
export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = ["global", "editor", "grid", "tabs"];

/**
 * 全ショートカット定義。`keysKey` / `descKey` は `i18n.ts` の既存
 * `helpShortcut*` キーを再利用しているため、`HelpView` の従来表記と完全に一致する。
 */
export const SHORTCUTS: ShortcutDef[] = [
  { keysKey: "shortcutCommandPaletteTitle", descKey: "shortcutCommandPaletteDesc", category: "global" },
  { keysKey: "shortcutCheatSheetTitle", descKey: "shortcutCheatSheetDesc", category: "global" },
  { keysKey: "shortcutSidebarFilterTitle", descKey: "shortcutSidebarFilterDesc", category: "global" },
  { keysKey: "shortcutObjectSearchTitle", descKey: "shortcutObjectSearchDesc", category: "global" },
  { keysKey: "helpShortcutRunTitle", descKey: "helpShortcutRunDesc", category: "editor" },
  { keysKey: "shortcutRunNewTabTitle", descKey: "shortcutRunNewTabDesc", category: "editor" },
  { keysKey: "helpShortcutPreviewTitle", descKey: "helpShortcutPreviewDesc", category: "editor" },
  { keysKey: "helpShortcutFormatTitle", descKey: "helpShortcutFormatDesc", category: "editor" },
  { keysKey: "helpShortcutCompleteTitle", descKey: "helpShortcutCompleteDesc", category: "editor" },
  { keysKey: "shortcutEditorFindTitle", descKey: "shortcutEditorFindDesc", category: "editor" },
  { keysKey: "helpShortcutSearchTitle", descKey: "helpShortcutSearchDesc", category: "grid" },
  { keysKey: "shortcutGridNavTitle", descKey: "shortcutGridNavDesc", category: "grid" },
  { keysKey: "shortcutGridSelectTitle", descKey: "shortcutGridSelectDesc", category: "grid" },
  { keysKey: "shortcutGridCopyTitle", descKey: "shortcutGridCopyDesc", category: "grid" },
  { keysKey: "shortcutGridCopyHeadersTitle", descKey: "shortcutGridCopyHeadersDesc", category: "grid" },
  { keysKey: "shortcutGridInspectorTitle", descKey: "shortcutGridInspectorDesc", category: "grid" },
  { keysKey: "helpShortcutNewTabTitle", descKey: "helpShortcutNewTabDesc", category: "tabs" },
  { keysKey: "helpShortcutCloseTabTitle", descKey: "helpShortcutCloseTabDesc", category: "tabs" },
  { keysKey: "helpShortcutCycleTabTitle", descKey: "helpShortcutCycleTabDesc", category: "tabs" },
  { keysKey: "helpShortcutNthTabTitle", descKey: "helpShortcutNthTabDesc", category: "tabs" },
];
