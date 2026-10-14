/**
 * キーボードショートカットの「コンボ文字列」を扱う純ロジック (#557)。
 *
 * コンボは `"Mod+Shift+Enter"` のような正規化文字列で表現する:
 *   - `Mod`   … macOS の Cmd / その他の Ctrl (既存ハンドラの `metaKey || ctrlKey`
 *               に合わせ、両者を区別せず 1 つの修飾子として扱う)
 *   - `Alt`   … Alt / Option
 *   - `Shift` … Shift
 *   - 末尾が実キー (1 文字は大文字化、`Enter` などの名前付きキーはそのまま)
 *
 * 修飾子は `Mod → Alt → Shift → キー` の順に正規化する。`KeyboardEvent` との
 * 突き合わせ・表示用整形・スコープ内衝突検出・CodeMirror キー表記への変換を
 * 提供する。副作用が無いので `shortcutKeys.test.ts` で単体テストする。
 */

/** 修飾子キー単体 (実キーが無い) のイベントを弾くための集合。 */
const MODIFIER_ONLY_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"]);

/**
 * 複数語の名前付きキーの正規表記 (`KeyboardEvent.key` / CodeMirror の表記)。
 * 小文字化して先頭だけ大文字にすると `Arrowright` / `Pagedown` になり、表示が崩れ
 * CodeMirror のキーマップにも一致しなくなるため、小文字キー → 正規表記の表で引く。
 */
const CANONICAL_KEY_NAMES: Record<string, string> = Object.fromEntries(
  [
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "CapsLock",
    "NumLock",
    "ScrollLock",
    "PrintScreen",
    "ContextMenu",
    "MediaPlayPause",
  ].map((k) => [k.toLowerCase(), k]),
);

/** 実キー名を正規化する。1 文字は大文字化、空白は `Space`、それ以外は正規表記に揃える。 */
function normalizeKeyName(key: string): string {
  if (key === " " || key === "Spacebar") return "Space";
  if (key.length === 1) return key.toUpperCase();
  // 名前付きキーは先頭大文字・残り小文字に揃える ("enter"/"ENTER" → "Enter")。
  // 複数語のキー (ArrowRight / PageDown) は表で正規表記へ戻す。
  // event 由来・手書きコンボの双方を同じ規則で正規化するため、突き合わせは一貫する。
  const lc = key.toLowerCase();
  return CANONICAL_KEY_NAMES[lc] ?? key.charAt(0).toUpperCase() + lc.slice(1);
}

/**
 * `+` 区切りのコンボ文字列をトークンに分ける。キーそのものが `+` のとき
 * (`Mod+Shift++` / 単独の `+`) は末尾の `++` を区切り + キー `+` として扱い、
 * 空トークンに潰さない (#1604)。
 */
function splitPlusTokens(text: string): string[] {
  const toks = text.split("+");
  const n = toks.length;
  if (n >= 2 && toks[n - 1] === "" && toks[n - 2] === "") {
    return [...toks.slice(0, n - 2), "+"];
  }
  return toks;
}

/**
 * コンボ文字列をトークンへ分解する。修飾子の有無と実キーを返す。未知トークンは
 * キー候補として最後のものを採用する (壊れた入力でも落ちない)。
 */
function parseCombo(combo: string): { mod: boolean; alt: boolean; shift: boolean; key: string } {
  let mod = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const rawTok of splitPlusTokens(combo)) {
    const tok = rawTok.trim();
    if (tok.length === 0) continue;
    const lc = tok.toLowerCase();
    if (
      lc === "mod" ||
      lc === "cmd" ||
      lc === "command" ||
      lc === "ctrl" ||
      lc === "control" ||
      lc === "meta"
    ) {
      mod = true;
    } else if (lc === "alt" || lc === "option" || lc === "opt") {
      alt = true;
    } else if (lc === "shift") {
      shift = true;
    } else {
      key = normalizeKeyName(tok);
    }
  }
  return { mod, alt, shift, key };
}

/** 正規化済みコンボ文字列を組み立てる (`Mod → Alt → Shift → キー`)。 */
function buildCombo(parts: { mod: boolean; alt: boolean; shift: boolean; key: string }): string {
  const out: string[] = [];
  if (parts.mod) out.push("Mod");
  if (parts.alt) out.push("Alt");
  if (parts.shift) out.push("Shift");
  if (parts.key) out.push(parts.key);
  return out.join("+");
}

/** コンボ文字列を正規化する (トークン順・大文字小文字を統一)。 */
export function canonicalizeCombo(combo: string): string {
  return buildCombo(parseCombo(combo));
}

/**
 * `KeyboardEvent` をコンボ文字列へ変換する。修飾子だけ (実キーが無い) の押下では
 * `null` を返す — 記録 UI が修飾子待ち状態を維持できるようにする。
 */
export function eventToCombo(e: KeyboardEvent): string | null {
  if (MODIFIER_ONLY_KEYS.has(e.key)) return null;
  return buildCombo({
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: normalizeKeyName(e.key),
  });
}

/** `KeyboardEvent` が指定コンボに一致するか。 */
export function comboMatchesEvent(combo: string, e: KeyboardEvent): boolean {
  const evtCombo = eventToCombo(e);
  if (evtCombo === null) return false;
  return canonicalizeCombo(combo) === canonicalizeCombo(evtCombo);
}

/**
 * 表示用に整形する。`Mod → Cmd/Ctrl`、`Alt → Alt/Option`、`Shift → Shift` と
 * プラットフォーム非依存の表記にし、既存のヘルプ/チートシート文言と揃える。
 */
export function formatCombo(combo: string): string {
  const p = parseCombo(combo);
  const out: string[] = [];
  if (p.mod) out.push("Cmd/Ctrl");
  if (p.shift) out.push("Shift");
  if (p.alt) out.push("Alt/Option");
  if (p.key) out.push(p.key);
  return out.join("+");
}

/**
 * CodeMirror の `keymap` が解釈するキー表記へ変換する (`-` 区切り、修飾子は
 * `Mod`/`Alt`/`Shift`)。1 文字キーは小文字 (CodeMirror の慣例)、名前付きキーは
 * そのまま。
 */
export function comboToCodeMirror(combo: string): string {
  const p = parseCombo(combo);
  const out: string[] = [];
  if (p.mod) out.push("Mod");
  if (p.alt) out.push("Alt");
  if (p.shift) out.push("Shift");
  if (p.key) out.push(p.key.length === 1 ? p.key.toLowerCase() : p.key);
  return out.join("-");
}

/**
 * 表示用のコンボ/キー文字列 (`formatCombo` の出力や `"Esc"` のような単一トークン)
 * を `+` 区切りで個別キーへ分割する (`Kbd` の `splitCombo` 描画用、#844)。前後の
 * 空白は除去し、空トークンは無視する。`formatCombo` の各修飾子表記
 * (`"Cmd/Ctrl"` / `"Alt/Option"`) は `/` を使うため `+` 分割では割れず、1 トークン
 * のまま残る。`+` を含まない文字列 (`"Esc"` 等) は要素数 1 の配列を返す。
 */
export function splitComboKeys(text: string): string[] {
  return splitPlusTokens(text)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0);
}

/**
 * スコープ内で同一コンボに割り当てられた id の集合を返す (衝突検出)。`scopes` が
 * 同じ id 同士だけを突き合わせ、異なるスコープ (例: グローバル window ハンドラと
 * CodeMirror エディタ) の同一キーは衝突としない (フォーカス文脈で住み分くため)。
 */
export function findShortcutConflicts(
  bindings: Record<string, string>,
  scopes: Record<string, string>,
): Set<string> {
  const groups = new Map<string, string[]>();
  for (const id of Object.keys(bindings)) {
    const combo = bindings[id];
    if (!combo) continue;
    const scope = scopes[id] ?? "";
    const groupKey = `${scope}\u0000${canonicalizeCombo(combo)}`;
    const arr = groups.get(groupKey) ?? [];
    arr.push(id);
    groups.set(groupKey, arr);
  }
  const conflicting = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length > 1) for (const id of ids) conflicting.add(id);
  }
  return conflicting;
}
