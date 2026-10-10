import type { TreeDragItem } from "./treeDragInsert";

/**
 * スキーマツリー行のポインタ・ドラッグ (#1414) の状態遷移。DOM に触れない純関数だけを
 * 置き、`treeDragStore.ts` がイベント配線を担当する。
 *
 * - `idle`: 何も押されていない
 * - `pending`: 押下済みだが移動量がしきい値未満 (= まだクリック扱い)
 * - `dragging`: しきい値を超えてドラッグ中
 */
export type TreeDragPhase =
  | { kind: "idle" }
  | { kind: "pending"; item: TreeDragItem; startX: number; startY: number }
  | { kind: "dragging"; item: TreeDragItem; x: number; y: number };

/** この距離 (CSS px) 以上動いて初めてドラッグを開始する。未満はクリック / ダブルクリック。 */
export const TREE_DRAG_THRESHOLD = 5;

export const IDLE_PHASE: TreeDragPhase = { kind: "idle" };

export function pressPhase(item: TreeDragItem, x: number, y: number): TreeDragPhase {
  return { kind: "pending", item, startX: x, startY: y };
}

/** ポインタ移動を反映する。pending はしきい値を超えたら dragging へ、dragging は座標を更新する。 */
export function movePhase(phase: TreeDragPhase, x: number, y: number): TreeDragPhase {
  if (phase.kind === "pending") {
    const moved = Math.hypot(x - phase.startX, y - phase.startY);
    return moved >= TREE_DRAG_THRESHOLD ? { kind: "dragging", item: phase.item, x, y } : phase;
  }
  if (phase.kind === "dragging") return { kind: "dragging", item: phase.item, x, y };
  return phase;
}

/** ボタンを離したときの結果。ドラッグ中だけドロップを試み、pending は何もしない (クリックに任せる)。 */
export function releasePhase(phase: TreeDragPhase): { phase: TreeDragPhase; drop: TreeDragItem | null } {
  return { phase: IDLE_PHASE, drop: phase.kind === "dragging" ? phase.item : null };
}

/** Esc などでキャンセルする。 */
export function cancelPhase(): TreeDragPhase {
  return IDLE_PHASE;
}

/** ポインタ下の要素を内包する最初のドロップ先 (エディタ) を返す。無ければ null (= ドロップしても何もしない)。 */
export function pickDropTarget<T extends { element: Element }>(
  targets: Iterable<T>,
  hit: Element | null,
): T | null {
  if (!hit) return null;
  for (const t of targets) if (t.element.contains(hit)) return t;
  return null;
}
