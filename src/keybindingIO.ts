// キー割り当ての入れ替えと JSON の書き出し・読み込み (#1631)。画面 (KeybindingSettings) から切り離した純関数。

import { canonicalizeCombo } from "./shortcutKeys";
import { REBINDABLE_SHORTCUTS, resolveShortcutBindings, SHORTCUT_SCOPES, type ShortcutId } from "./shortcuts";

export const KEYBINDINGS_EXPORT_KIND = "noobdb-keybindings";
export const KEYBINDINGS_EXPORT_VERSION = 1;

/**
 * `id` に `combo` を割り当てるときの上書き差分を返す。同じスコープの別アクションが既に同じコンボを
 * 使っていれば、そのアクションへ `id` の元のコンボを渡して入れ替える (衝突を作らない)。
 * `swapped` は入れ替えた相手 (なければ null)。
 */
export function planBindingAssignment(
  overrides: Record<string, string>,
  id: ShortcutId,
  combo: string,
): { changes: Record<string, string>; swapped: ShortcutId | null } {
  const resolved = resolveShortcutBindings(overrides);
  const target = canonicalizeCombo(combo);
  const scope = SHORTCUT_SCOPES[id];
  const other = REBINDABLE_SHORTCUTS.find(
    (s) => s.id !== id && s.scope === scope && canonicalizeCombo(resolved[s.id]) === target,
  );
  if (!other) return { changes: { [id]: combo }, swapped: null };
  return { changes: { [id]: combo, [other.id]: resolved[id] }, swapped: other.id };
}

/** 現在の上書きを JSON 文字列へ。既定と同じ値は含めない。 */
export function serializeKeybindings(overrides: Record<string, string>): string {
  const resolved = resolveShortcutBindings(overrides);
  const bindings: Record<string, string> = {};
  for (const s of REBINDABLE_SHORTCUTS) {
    if (resolved[s.id] !== s.defaultCombo) bindings[s.id] = resolved[s.id];
  }
  return JSON.stringify(
    { kind: KEYBINDINGS_EXPORT_KIND, version: KEYBINDINGS_EXPORT_VERSION, bindings },
    null,
    2,
  );
}

export type ParseKeybindingsResult =
  | { ok: true; bindings: Record<string, string>; ignored: number; conflicts: number }
  | { ok: false };

/**
 * 書き出した JSON (または素の `{ id: combo }`) を読み込む。既知の id かつ空でない文字列のコンボだけ残し、
 * 保存時の検証 (`sanitizeShortcutOverrides`: 空文字を捨てる) と同じ基準に通す。それ以外は `ignored`。
 * `conflicts` は取り込み後に同じスコープで重複するアクション数 (警告表示用)。
 */
export function parseKeybindings(
  raw: string,
  sanitize: (input: unknown) => Record<string, string>,
): ParseKeybindingsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const obj = parsed as Record<string, unknown>;
  const inner = "bindings" in obj ? obj.bindings : parsed;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return { ok: false };
  const total = Object.keys(inner).length;
  const known = new Set<string>(REBINDABLE_SHORTCUTS.map((s) => s.id));
  const clean = sanitize(inner);
  const bindings: Record<string, string> = {};
  for (const [k, v] of Object.entries(clean)) if (known.has(k)) bindings[k] = v;
  const resolved = resolveShortcutBindings(bindings);
  const seen = new Map<string, number>();
  for (const s of REBINDABLE_SHORTCUTS) {
    const key = `${s.scope}\u0000${canonicalizeCombo(resolved[s.id])}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let conflicts = 0;
  for (const n of seen.values()) if (n > 1) conflicts += n;
  return { ok: true, bindings, ignored: total - Object.keys(bindings).length, conflicts };
}
