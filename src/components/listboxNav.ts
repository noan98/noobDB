/**
 * `ListboxSelect` (#1143) のキーボード操作・型入力ジャンプを担う純ロジック。
 *
 * ネイティブ `<select>` は webkit2gtk (Tauri/Linux) では GTK がポップアップを
 * 描画するためテーマ/モーションに追従しない。`ComboSelect` (自由入力あり) と
 * 同じ WAI-ARIA listbox ポップオーバーを土台に、**自由入力なしの単純選択**用に
 * `ListboxSelect.tsx` を用意する。判定ロジックはコンポーネントから切り離し、
 * ここで純関数としてテストする (`.claude/rules/ui-design-system.md` 6 節)。
 */

/** ↑↓/Home/End によるハイライト移動。空リストでは常に null。
 *  ArrowDown/ArrowUp は端でループする (ComboSelect と同じ挙動)。 */
export function computeListboxMove(
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  current: number | null,
  length: number,
): number | null {
  if (length === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return current === null ? 0 : (current + 1) % length;
  // ArrowUp: ハイライト無しから始めると末尾から (ComboSelect の慣習を踏襲)。
  return current === null ? length - 1 : (current - 1 + length) % length;
}

/** 型入力ジャンプのバッファ状態。 */
export interface TypeaheadState {
  query: string;
  lastKeyAt: number;
}

/** 直前の入力からこの時間 (ms) を超えたらバッファをリセットする。 */
export const TYPEAHEAD_RESET_MS = 800;

/** 印字可能な 1 文字を型入力バッファへ積む。タイムアウトを超えていれば
 *  新しいバッファとして開始する。 */
export function appendTypeaheadKey(
  state: TypeaheadState | null,
  char: string,
  now: number,
): TypeaheadState {
  if (state && now - state.lastKeyAt <= TYPEAHEAD_RESET_MS) {
    return { query: state.query + char.toLowerCase(), lastKeyAt: now };
  }
  return { query: char.toLowerCase(), lastKeyAt: now };
}

/** 型入力バッファに前方一致するラベルを、現在位置の次から探してループする。
 *  一致が無ければ null (ハイライトは変えない)。 */
export function findTypeaheadIndex(
  labels: readonly string[],
  query: string,
  current: number | null,
): number | null {
  const needle = query.toLowerCase();
  if (!needle) return null;
  const n = labels.length;
  if (n === 0) return null;
  const start = current === null ? 0 : (current + 1) % n;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    if (labels[idx].toLowerCase().startsWith(needle)) return idx;
  }
  return null;
}

/** キーボードイベントの 1 文字が型入力ジャンプの対象になるか (修飾キー無しの
 *  印字可能な 1 文字のみ。Space はトグル/選択に使うため対象外)。 */
export function isTypeaheadKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
}
