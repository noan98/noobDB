import type { I18nKey } from "./i18n";
import { formatCombo } from "./shortcutKeys";
import {
  SHORTCUTS,
  type ShortcutCategory,
  type ShortcutDef,
  type ShortcutId,
  type ShortcutScope,
} from "./shortcuts";

/**
 * 修飾キー長押しのショートカットヒント (which-key 風, #1487) の純ロジック。
 *
 * 一覧は `shortcuts.ts` の `SHORTCUTS` (単一ソース) と解決済みバインド (再割り当て反映済み)
 * から生成するだけで、キー定義を二重に持たない。表示コンポーネントは
 * `components/ShortcutHintOverlay.tsx`。
 */

/**
 * ヒントを出す文脈。`editor` = SQL エディタにフォーカス、`grid` = 結果グリッドにフォーカス、
 * `global` = ワークスペースのそれ以外、`surface` = ER 図などの全画面サーフェス / 未接続。
 */
export type HintContext = "editor" | "grid" | "global" | "surface";

/** 押されている補助修飾キー (主修飾キー Cmd/Ctrl は押されている前提)。 */
export interface HeldModifiers {
  shift: boolean;
  alt: boolean;
}

export interface HintItem {
  /** React key 兼テスト用 (`id` があれば id、なければ keysKey)。 */
  key: string;
  category: ShortcutCategory;
  label: string;
  keys: string;
}

/** 文脈ごとに出してよいカテゴリ。 */
const CONTEXT_CATEGORIES: Record<HintContext, ShortcutCategory[]> = {
  editor: ["global", "editor", "tabs"],
  grid: ["global", "grid", "tabs"],
  global: ["global", "tabs"],
  surface: ["global"],
};

function scopeApplies(scope: ShortcutScope, context: HintContext): boolean {
  if (scope === "global") return true;
  return scope === context;
}

/** 補助修飾キーの絞り込み。押している Shift / Alt を含まないコンボは出さない。 */
function matchesHeld(keysText: string, held: HeldModifiers): boolean {
  const parts = keysText.split("+");
  if (held.shift && !parts.includes("Shift")) return false;
  if (held.alt && !parts.some((p) => p === "Alt" || p === "Alt/Option")) return false;
  return true;
}

/**
 * 現在の文脈で「主修飾キーを押したまま押せる」ショートカットの一覧を返す。
 * - 再割り当て可能な項目は解決済みコンボ (`bindings`) を `formatCombo` で表記する。
 * - 同じコンボが複数ある場合 (グローバルの Run in new tab とエディタの Preview など) は
 *   スコープが具体的な (global でない) 項目を優先し、重複を出さない。
 * - 並びは `SHORTCUTS` の定義順 (= チートシートと同じ)。
 */
export function buildShortcutHints(
  context: HintContext,
  bindings: Record<ShortcutId, string>,
  held: HeldModifiers,
  t: (key: I18nKey) => string,
  defs: readonly ShortcutDef[] = SHORTCUTS,
): HintItem[] {
  const cats = CONTEXT_CATEGORIES[context];
  const candidates: { item: HintItem; specific: boolean }[] = [];
  for (const def of defs) {
    if (def.hint === false || !cats.includes(def.category)) continue;
    let keys: string;
    let specific = false;
    if (def.id && def.scope) {
      if (!scopeApplies(def.scope, context)) continue;
      const combo = bindings[def.id];
      if (!combo.startsWith("Mod+")) continue;
      keys = formatCombo(combo);
      specific = def.scope !== "global";
    } else {
      const combo = def.hintCombo;
      if (!combo || !/^(Mod|Ctrl)\+/.test(combo)) continue;
      // Ctrl 固定 (Cmd では効かない) は "Ctrl+R" のまま、それ以外は Cmd/Ctrl 表記にする。
      keys = combo.startsWith("Ctrl+") ? combo : formatCombo(combo);
    }
    if (!matchesHeld(keys, held)) continue;
    candidates.push({
      item: {
        key: def.id ?? def.keysKey,
        category: def.category,
        label: t(def.hintKey ?? def.descKey),
        keys,
      },
      specific,
    });
  }
  // 同一コンボの重複は具体スコープ側を残す (表示順は定義順のまま)。
  const winner = new Map<string, number>();
  candidates.forEach((c, i) => {
    const prev = winner.get(c.item.keys);
    if (prev === undefined || (c.specific && !candidates[prev].specific)) winner.set(c.item.keys, i);
  });
  const keep = new Set(winner.values());
  return candidates.filter((_, i) => keep.has(i)).map((c) => c.item);
}

/** フォーカス要素の分類。`text` = CodeMirror 以外のテキスト入力 (ヒントを抑制する)。 */
export type FocusKind = "editor" | "grid" | "text" | "other";

export function classifyFocus(el: Element | null): FocusKind {
  if (!el) return "other";
  if (el.closest(".cm-editor")) return "editor";
  if (el.closest('[role="grid"]')) return "grid";
  if (el instanceof HTMLTextAreaElement) return "text";
  if (el instanceof HTMLInputElement) {
    // チェックボックス等はテキスト入力ではない。
    const nonText = ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"];
    return nonText.includes(el.type) ? "other" : "text";
  }
  if (el instanceof HTMLSelectElement) return "other";
  if (
    el instanceof HTMLElement &&
    (el.isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"]'))
  ) {
    return "text";
  }
  return "other";
}

/** フォーカス分類と「全画面サーフェスか」から、ヒントの文脈を決める。 */
export function hintContextFor(kind: FocusKind, surface: boolean): HintContext {
  if (surface) return "surface";
  if (kind === "editor") return "editor";
  if (kind === "grid") return "grid";
  return "global";
}

/** 画面に出す最大件数。超えた分は「ほか N 件」に畳む。 */
export const MAX_HINT_ITEMS = 24;
