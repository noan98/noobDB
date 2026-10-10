import {
  IDLE_PHASE,
  cancelPhase,
  movePhase,
  pickDropTarget,
  pressPhase,
  releasePhase,
  type TreeDragPhase,
} from "./treeDragGesture";
import { treeDragLabel, type TreeDragItem } from "./treeDragInsert";

/**
 * スキーマツリー行 → SQL エディタのポインタ・ドラッグ (#1414) のイベント配線と外部ストア。
 *
 * ツリー (`ConnectionList`) とエディタ (`QueryEditor`) は別コンポーネントなので、
 * - エディタはマウント時に `registerTreeDropTarget` でドロップ先を登録し、
 * - ツリー行は `attachTreeDragSource` でドラッグ元になり、
 * - ゴースト (`TreeDragGhost`) は `useTreeDragSnapshot` 経由でドラッグ状態を購読する。
 *
 * HTML5 の D&D は使わない (Windows の WebView2 は OS ファイルのドロップ処理と排他のため)。
 */

/** エディタ側が実装するドロップ先。 */
export interface TreeDropTarget {
  /** ポインタがこの要素の内側ならドロップ先として扱う。 */
  element: Element;
  /** 画面座標 → ドキュメント位置。 */
  posAtCoords: (x: number, y: number) => number | null;
  /** 挿入予定位置のマーカーを出す / 消す (null)。 */
  setMarker: (pos: number | null) => void;
  /** `pos` へ挿入する。`qualified=false` は列名のみ (Alt)。 */
  insert: (item: TreeDragItem, pos: number | null, qualified: boolean) => void;
}

export interface TreeDragSnapshot {
  active: boolean;
  label: string;
  x: number;
  y: number;
  overEditor: boolean;
}

const INACTIVE: TreeDragSnapshot = { active: false, label: "", x: 0, y: 0, overEditor: false };

const targets = new Set<TreeDropTarget>();
let snapshot: TreeDragSnapshot = INACTIVE;
const listeners = new Set<() => void>();

function publish(next: TreeDragSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export function subscribeTreeDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTreeDragSnapshot(): TreeDragSnapshot {
  return snapshot;
}

export function registerTreeDropTarget(target: TreeDropTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/** 対話要素 (ボタン等) の上で押された場合はドラッグを始めない。 */
const INTERACTIVE = "button, a, input, textarea, select, [role='button']";

/**
 * 行 `el` をドラッグ元にする。返り値は解除関数。
 *
 * pointerdown は `stopPropagation` する: 接続行の `Reorder.Item` (framer-motion) は子孫の
 * どこで押されてもネイティブ pointerdown で並べ替えドラッグを始めてしまうため、テーブル /
 * 列行からは届かせない (並べ替えは接続 / グループ行のみ)。
 */
export function attachTreeDragSource(el: HTMLElement, getItem: () => TreeDragItem): () => void {
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.stopPropagation();
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
    if (snapshot.active) return;
    startSession(el, e, getItem());
  };
  el.addEventListener("pointerdown", onPointerDown);
  return () => el.removeEventListener("pointerdown", onPointerDown);
}

function startSession(source: HTMLElement, down: PointerEvent, item: TreeDragItem) {
  let phase: TreeDragPhase = pressPhase(item, down.clientX, down.clientY);
  let dragged = false;
  let current: TreeDropTarget | null = null;
  let altKey = down.altKey;
  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;

  const setCurrent = (next: TreeDropTarget | null, x: number, y: number) => {
    if (current && current !== next) current.setMarker(null);
    current = next;
    current?.setMarker(current.posAtCoords(x, y));
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    setCurrent(null, 0, 0);
    if (dragged) {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      try {
        source.releasePointerCapture(down.pointerId);
      } catch {
        // 既に解放済み / 未対応環境
      }
    }
    publish(INACTIVE);
  };

  // ドラッグ後にボタンを離すと発火するクリックを 1 回だけ握りつぶす (行の展開 / 選択を防ぐ)。
  const swallowClick = () => {
    const stop = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, true), 0);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    altKey = e.altKey;
    phase = movePhase(phase, e.clientX, e.clientY);
    if (phase.kind !== "dragging") return;
    if (!dragged) {
      dragged = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      try {
        source.setPointerCapture(down.pointerId);
      } catch {
        // 未対応環境では window のリスナだけで追従する
      }
    }
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    setCurrent(pickDropTarget(targets, hit), e.clientX, e.clientY);
    publish({ active: true, label: treeDragLabel(phase.item), x: e.clientX, y: e.clientY, overEditor: current !== null });
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    const wasDragged = dragged;
    const { drop } = releasePhase(phase);
    phase = IDLE_PHASE;
    const target = current;
    const pos = target ? target.posAtCoords(e.clientX, e.clientY) : null;
    cleanup();
    if (wasDragged) swallowClick();
    if (drop && target) target.insert(drop, pos, !(e.altKey || altKey));
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    phase = cancelPhase();
    const wasDragged = dragged;
    cleanup();
    if (wasDragged) swallowClick();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    // ボタンを離すまで pointerup を待ち、離した時点で何もせず終わる (クリックも握りつぶす)。
    phase = cancelPhase();
    setCurrent(null, 0, 0);
    publish(INACTIVE);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("keydown", onKey, true);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
}
