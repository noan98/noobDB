import type { ShortcutId } from "./shortcuts";
import { formatCombo } from "./shortcutKeys";

/**
 * ボタンのツールチップ用に「ラベル (キー)」を組み立てる純関数 (#1278)。
 *
 * ショートカットの表記は `shortcuts.ts` (id → コンボ) + `shortcutKeys.ts` の
 * `formatCombo` が単一ソース。ツールチップ側で `"Cmd/Ctrl+K"` のような文字列を
 * 手書きすると、設定で再割り当て (#557) されたときに表示が嘘になるため、必ず
 * ここを経由する。コンボが無い (= ショートカット未割り当て) ときはラベルのみ返す。
 */
export function labelWithShortcut(label: string, combo: string | null | undefined): string {
  const keys = combo ? formatCombo(combo) : "";
  return keys ? `${label} (${keys})` : label;
}

/** 解決済みバインド表 (`resolveShortcutBindings` の戻り値など) から id で引く版。 */
export function shortcutTooltip(
  label: string,
  bindings: Partial<Record<ShortcutId, string>>,
  id: ShortcutId,
): string {
  return labelWithShortcut(label, bindings[id]);
}
