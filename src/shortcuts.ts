import type { I18nKey } from "./i18n";

/**
 * キーボードショートカット定義の単一ソース。
 *
 * `HelpView` のショートカット節と、`?` キーで開くチートシート
 * オーバーレイ (`ShortcutCheatSheet`) の双方がこの配列を参照するため、定義の
 * 二重管理が起きない。表示文言は i18n キー越しに引くので、英語/日本語の両方で
 * 一貫したラベルになる。
 *
 * `category` はチートシートでの見出しグルーピングに使う。`HelpView` はフラットな
 * 一覧として描画するためカテゴリを無視してよい。
 *
 * 一部の「主要アクション」はユーザが再割り当てできる (#557)。これらには `id` /
 * `scope` / `defaultCombo` を持たせ、設定の上書きマップ
 * (`Settings.shortcutOverrides`) を `resolveShortcutBindings` で既定にマージする。
 * 衝突検出は `scope` (どのキーリスナが捌くか) 単位で行い、`category` (表示見出し)
 * とは別軸にしている — 例えばグローバル window ハンドラの `Mod+Shift+Enter` と
 * CodeMirror エディタの `Mod+Shift+Enter` はフォーカス文脈で住み分くため衝突
 * 扱いにしない。`id` を持たないショートカットは表示専用 (再割り当て不可)。
 */

/** チートシートでの見出し分類。 */
export type ShortcutCategory = "global" | "editor" | "grid" | "tabs";

/**
 * 再割り当て可能なショートカットの識別子 (#557)。永続化キー (`shortcutOverrides`)
 * 兼、各キーハンドラが解決済みバインドを引くためのキー。
 */
export type ShortcutId =
  | "commandPalette"
  | "objectSearch"
  | "sidebarFilter"
  | "resultSearch"
  | "maximizeResult"
  | "focusEditor"
  | "runNewTab"
  | "newTab"
  | "closeTab"
  | "run"
  | "runStatement"
  | "preview"
  | "format"
  | "openSettings"
  | "openHelp"
  | "toggleTheme"
  | "toggleSidebar"
  | "cyclePaneFocus"
  | "gridPageNext"
  | "gridPagePrev"
  | "gridCopy"
  | "gridCopyHeaders"
  | "gridInspector"
  | "gridUndo"
  | "gridRedo";

/**
 * 衝突検出のスコープ = どのキーリスナが捌くか。`global` は window レベルの
 * keydown ハンドラ (`App.tsx`)、`editor` は CodeMirror のキーマップ、`grid` は
 * `ResultGrid` (内側 `DataGrid`) 自身の keydown ハンドラ。異なるスコープ間の
 * 同一キーは衝突としない。
 */
export type ShortcutScope = "global" | "editor" | "grid";

export interface ShortcutDef {
  /** キー表記の i18n キー (例: "Cmd/Ctrl+Enter")。再割り当て不可時の表示に使う。 */
  keysKey: I18nKey;
  /** 説明文の i18n キー。 */
  descKey: I18nKey;
  category: ShortcutCategory;
  /** 再割り当て可能なショートカットのみ持つ識別子。 */
  id?: ShortcutId;
  /** 再割り当て可能なショートカットの衝突検出スコープ。 */
  scope?: ShortcutScope;
  /** 既定のコンボ文字列 (`shortcutKeys.ts` の正規化形式)。 */
  defaultCombo?: string;
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
 * `helpShortcut*` キーを再利用しているため、`HelpView` の表記と完全に一致する。
 */
export const SHORTCUTS: ShortcutDef[] = [
  { keysKey: "shortcutCommandPaletteTitle", descKey: "shortcutCommandPaletteDesc", category: "global", id: "commandPalette", scope: "global", defaultCombo: "Mod+K" },
  { keysKey: "shortcutCheatSheetTitle", descKey: "shortcutCheatSheetDesc", category: "global" },
  { keysKey: "shortcutSidebarFilterTitle", descKey: "shortcutSidebarFilterDesc", category: "global", id: "sidebarFilter", scope: "global", defaultCombo: "Mod+P" },
  { keysKey: "shortcutObjectSearchTitle", descKey: "shortcutObjectSearchDesc", category: "global", id: "objectSearch", scope: "global", defaultCombo: "Mod+Shift+O" },
  { keysKey: "shortcutOpenSettingsTitle", descKey: "shortcutOpenSettingsDesc", category: "global", id: "openSettings", scope: "global", defaultCombo: "Mod+," },
  { keysKey: "shortcutOpenHelpTitle", descKey: "shortcutOpenHelpDesc", category: "global", id: "openHelp", scope: "global", defaultCombo: "F1" },
  { keysKey: "shortcutToggleThemeTitle", descKey: "shortcutToggleThemeDesc", category: "global", id: "toggleTheme", scope: "global", defaultCombo: "Mod+Shift+L" },
  { keysKey: "shortcutToggleSidebarTitle", descKey: "shortcutToggleSidebarDesc", category: "global", id: "toggleSidebar", scope: "global", defaultCombo: "Mod+B" },
  { keysKey: "shortcutCyclePaneTitle", descKey: "shortcutCyclePaneDesc", category: "global", id: "cyclePaneFocus", scope: "global", defaultCombo: "F6" },
  { keysKey: "helpShortcutRunTitle", descKey: "helpShortcutRunDesc", category: "editor", id: "run", scope: "editor", defaultCombo: "Mod+Enter" },
  { keysKey: "shortcutRunStatementTitle", descKey: "shortcutRunStatementDesc", category: "editor", id: "runStatement", scope: "editor", defaultCombo: "Mod+Alt+Enter" },
  { keysKey: "shortcutRunNewTabTitle", descKey: "shortcutRunNewTabDesc", category: "editor", id: "runNewTab", scope: "global", defaultCombo: "Mod+Shift+Enter" },
  { keysKey: "helpShortcutPreviewTitle", descKey: "helpShortcutPreviewDesc", category: "editor", id: "preview", scope: "editor", defaultCombo: "Mod+Shift+Enter" },
  { keysKey: "helpShortcutFormatTitle", descKey: "helpShortcutFormatDesc", category: "editor", id: "format", scope: "editor", defaultCombo: "Mod+Shift+F" },
  { keysKey: "shortcutFocusEditorTitle", descKey: "shortcutFocusEditorDesc", category: "editor", id: "focusEditor", scope: "global", defaultCombo: "Mod+Shift+E" },
  { keysKey: "helpShortcutCompleteTitle", descKey: "helpShortcutCompleteDesc", category: "editor" },
  { keysKey: "shortcutEditorFindTitle", descKey: "shortcutEditorFindDesc", category: "editor" },
  { keysKey: "helpShortcutSearchTitle", descKey: "helpShortcutSearchDesc", category: "grid", id: "resultSearch", scope: "global", defaultCombo: "Mod+F" },
  { keysKey: "shortcutFindNavTitle", descKey: "shortcutFindNavDesc", category: "grid" },
  { keysKey: "shortcutGridNavTitle", descKey: "shortcutGridNavDesc", category: "grid" },
  { keysKey: "shortcutGridSelectTitle", descKey: "shortcutGridSelectDesc", category: "grid" },
  { keysKey: "shortcutGridCopyTitle", descKey: "shortcutGridCopyDesc", category: "grid", id: "gridCopy", scope: "grid", defaultCombo: "Mod+C" },
  { keysKey: "shortcutGridCopyHeadersTitle", descKey: "shortcutGridCopyHeadersDesc", category: "grid", id: "gridCopyHeaders", scope: "grid", defaultCombo: "Mod+Shift+C" },
  { keysKey: "shortcutGridInspectorTitle", descKey: "shortcutGridInspectorDesc", category: "grid", id: "gridInspector", scope: "grid", defaultCombo: "Alt+Enter" },
  { keysKey: "shortcutEditUndoTitle", descKey: "shortcutEditUndoDesc", category: "grid", id: "gridUndo", scope: "grid", defaultCombo: "Mod+Z" },
  { keysKey: "shortcutGridRedoTitle", descKey: "shortcutGridRedoDesc", category: "grid", id: "gridRedo", scope: "grid", defaultCombo: "Mod+Shift+Z" },
  { keysKey: "shortcutGridPageNextTitle", descKey: "shortcutGridPageNextDesc", category: "grid", id: "gridPageNext", scope: "global", defaultCombo: "Alt+ArrowRight" },
  { keysKey: "shortcutGridPagePrevTitle", descKey: "shortcutGridPagePrevDesc", category: "grid", id: "gridPagePrev", scope: "global", defaultCombo: "Alt+ArrowLeft" },
  { keysKey: "shortcutMaximizeResultTitle", descKey: "shortcutMaximizeResultDesc", category: "grid", id: "maximizeResult", scope: "global", defaultCombo: "Mod+Shift+M" },
  { keysKey: "helpShortcutNewTabTitle", descKey: "helpShortcutNewTabDesc", category: "tabs", id: "newTab", scope: "global", defaultCombo: "Mod+T" },
  { keysKey: "helpShortcutCloseTabTitle", descKey: "helpShortcutCloseTabDesc", category: "tabs", id: "closeTab", scope: "global", defaultCombo: "Mod+W" },
  { keysKey: "helpShortcutCycleTabTitle", descKey: "helpShortcutCycleTabDesc", category: "tabs" },
  { keysKey: "helpShortcutNthTabTitle", descKey: "helpShortcutNthTabDesc", category: "tabs" },
];

/** 再割り当て可能なショートカットだけを抜き出した定義 (id 必須)。 */
export type RebindableShortcut = ShortcutDef & {
  id: ShortcutId;
  scope: ShortcutScope;
  defaultCombo: string;
};

/** 設定 UI / 解決処理が走査する、再割り当て可能なショートカット一覧。 */
export const REBINDABLE_SHORTCUTS: RebindableShortcut[] = SHORTCUTS.filter(
  (s): s is RebindableShortcut =>
    s.id !== undefined && s.scope !== undefined && s.defaultCombo !== undefined,
);

/** id → 既定コンボ。 */
export const DEFAULT_SHORTCUT_COMBOS: Record<ShortcutId, string> = Object.fromEntries(
  REBINDABLE_SHORTCUTS.map((s) => [s.id, s.defaultCombo]),
) as Record<ShortcutId, string>;

/** id → 衝突検出スコープ。 */
export const SHORTCUT_SCOPES: Record<ShortcutId, ShortcutScope> = Object.fromEntries(
  REBINDABLE_SHORTCUTS.map((s) => [s.id, s.scope]),
) as Record<ShortcutId, ShortcutScope>;

/**
 * 上書きマップを既定にマージして、id → 実効コンボの完全な表を返す。空文字や
 * 未知 id は無視して既定へフォールバックする (壊れた localStorage 耐性)。
 */
export function resolveShortcutBindings(
  overrides: Record<string, string> | undefined,
): Record<ShortcutId, string> {
  const out = { ...DEFAULT_SHORTCUT_COMBOS };
  if (overrides) {
    for (const s of REBINDABLE_SHORTCUTS) {
      const ov = overrides[s.id];
      if (typeof ov === "string" && ov.trim().length > 0) out[s.id] = ov;
    }
  }
  return out;
}
