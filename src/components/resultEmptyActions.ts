import type { IconName } from "./Icon";
import type { I18nKey } from "../i18n";

/**
 * 結果ペインの「クエリ実行前」状態 (#1784) の補助導線。書く → 実行 (Cmd/Ctrl+Enter) という
 * 核の実行ループをその場で教えるため、実行 / スニペット / コマンドパレットを並べる。
 * 並び順と文言キー・アイコンをここに固定し (純ロジック、`tabsEmptyActions.ts` と同方式)、
 * ハンドラとショートカット表記 (`shortcutKeys.formatCombo` で解決した文字列) は
 * 呼び出し側 (PaneView) が渡す。
 */
export type ResultEmptyActionId = "run" | "snippets" | "commandPalette";

export interface ResultEmptyActionDef {
  id: ResultEmptyActionId;
  labelKey: I18nKey;
  icon: IconName;
}

export const RESULT_EMPTY_ACTIONS: readonly ResultEmptyActionDef[] = [
  { id: "run", labelKey: "resultEmptyRun", icon: "play" },
  { id: "snippets", labelKey: "resultEmptySnippets", icon: "snippet" },
  { id: "commandPalette", labelKey: "resultEmptyCommandPalette", icon: "search" },
];

export interface ResultEmptyActionItem {
  id: ResultEmptyActionId;
  label: string;
  icon: IconName;
  /** 表示専用のショートカット (例: `Ctrl+Enter`)。無ければ省略。 */
  shortcut?: string;
  onClick: () => void;
}

/** 定義 + ハンドラ + 解決済み文言/ショートカットから、EmptyState の補助アクション列を作る。 */
export function buildResultEmptyActions(
  translate: (key: I18nKey) => string,
  handlers: Record<ResultEmptyActionId, () => void>,
  shortcuts: Partial<Record<ResultEmptyActionId, string>> = {},
): ResultEmptyActionItem[] {
  return RESULT_EMPTY_ACTIONS.map((def) => ({
    id: def.id,
    label: translate(def.labelKey),
    icon: def.icon,
    shortcut: shortcuts[def.id],
    onClick: handlers[def.id],
  }));
}
