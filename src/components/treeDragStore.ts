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
  /** 現在の選択範囲 (無ければキャレット位置) を置き換えて挿入する (メニューからの「エディタへ挿入」用, #2406)。未実装なら文書末尾。 */
  insertAtSelection?: (item: TreeDragItem) => void;
  /**
   * `pos` へ挿入する。`qualified=false` は列名のみ (Alt)。`joinFk=true` (Shift を押して
   * ドロップ) は、外部キー列なら通常の列名ではなく `JOIN 参照先 ON ...` の雛形を入れる
   * (#1540。外部キーでない列・FK 情報が無いときは通常の挿入に落とす)。
   */
  insert: (item: TreeDragItem, pos: number | null, qualified: boolean, joinFk: boolean) => void;
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
  trackEditorFocus();
  return () => {
    targets.delete(target);
    if (lastFocusedTarget === target) lastFocusedTarget = null;
  };
}

/** 最後にフォーカスされたドロップ先 (エディタ)。分割ペインで挿入先が複数見えるときの決め手。 */
let lastFocusedTarget: TreeDropTarget | null = null;
let focusTracking = false;
function trackEditorFocus() {
  if (focusTracking || typeof document === "undefined") return;
  focusTracking = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof Node)) return;
      for (const t of targets) if (t.element.contains(el)) lastFocusedTarget = t;
    },
    true,
  );
}

/** `a` と `b` の共通祖先の深さ (深いほど近い)。 */
function commonAncestorDepth(a: Element, b: Element): number {
  let node: Element | null = a;
  while (node && !node.contains(b)) node = node.parentElement;
  let depth = 0;
  for (let n = node; n?.parentElement; n = n.parentElement) depth++;
  return node ? depth : -1;
}

/**
 * ドラッグを使わず、いま見えているエディタへ挿入する (結果グリッドの右クリック「エディタへ挿入」, #2406)。
 * 見えるエディタが無い (別タブの KeepAlive など) ときは何もせず false。複数見えるときは、`anchor`
 * (グリッド) と共通祖先が最も近いエディタ (= 同じペイン)、同点なら最後にフォーカスされたエディタを選ぶ。
 * 挿入は選択範囲を置き換える (通常の貼り付けと同じ)。
 */
export function insertAtEditorCaret(item: TreeDragItem, anchor?: Element | null): boolean {
  const visible = [...targets].filter((t) => t.element.getClientRects().length > 0);
  if (visible.length === 0) return false;
  let target = visible[0];
  if (visible.length > 1) {
    const depthOf = (t: TreeDropTarget) => (anchor ? commonAncestorDepth(anchor, t.element) : -1);
    const best = Math.max(...visible.map(depthOf));
    const nearest = visible.filter((t) => depthOf(t) === best);
    target = nearest.find((t) => t === lastFocusedTarget) ?? nearest[nearest.length - 1];
  }
  if (target.insertAtSelection) target.insertAtSelection(item);
  else target.insert(item, null, true, false);
  return true;
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

/**
 * ツリー行以外 (結果グリッドの選択セルなど) からも、押下済みのポインタでドラッグを始める (#2406)。
 * しきい値未満でボタンを離した場合は `onTap` を呼ぶ (クリック扱い。選択解除などに使う)。
 */
export function beginPointerDrag(
  source: HTMLElement,
  down: PointerEvent,
  item: TreeDragItem,
  onTap?: () => void,
): boolean {
  if (down.button !== 0 || !down.isPrimary || snapshot.active) return false;
  startSession(source, down, item, onTap);
  return true;
}

function startSession(source: HTMLElement, down: PointerEvent, item: TreeDragItem, onTap?: () => void) {
  let phase: TreeDragPhase = pressPhase(item, down.clientX, down.clientY);
  let dragged = false;
  let current: TreeDropTarget | null = null;
  let altKey = down.altKey;
  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;

  // 直前にマーカーを出した位置。同じなら dispatch しない (pointermove は高頻度)。
  let lastPos: number | null | undefined;

  // ドラッグ中にエディタがアンマウントされる (Ctrl+W 等) と登録が外れる。解除済みのビューへ
  // dispatch しないよう、使う直前に登録中か確認する。
  const setCurrent = (next: TreeDropTarget | null, x: number, y: number) => {
    if (current && current !== next) {
      if (targets.has(current)) current.setMarker(null);
      lastPos = undefined;
    }
    current = next && targets.has(next) ? next : null;
    if (!current) {
      lastPos = undefined;
      return;
    }
    const pos = current.posAtCoords(x, y);
    if (pos !== lastPos) {
      lastPos = pos;
      current.setMarker(pos);
    }
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
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
    // ウィンドウ外で離した / Alt+Tab 等で pointerup を取り逃すと、ボタンが離れているのに
    // 動きだけ届く。そのままだと次の普通のクリックがドロップ扱いになるので、ここで打ち切る。
    if (e.buttons === 0) {
      onCancel(e);
      return;
    }
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
    publish({
      active: true,
      label: treeDragLabel(phase.item),
      x: e.clientX,
      y: e.clientY,
      overEditor: current !== null,
    });
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    const wasDragged = dragged;
    const { drop } = releasePhase(phase);
    phase = IDLE_PHASE;
    const target = current && targets.has(current) ? current : null;
    const pos = target ? target.posAtCoords(e.clientX, e.clientY) : null;
    cleanup();
    if (wasDragged) swallowClick();
    else if (onTap) onTap();
    if (drop && target) target.insert(drop, pos, !(e.altKey || altKey), e.shiftKey);
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    phase = cancelPhase();
    const wasDragged = dragged;
    cleanup();
    if (wasDragged) swallowClick();
  };

  // フォーカスを失った (Alt+Tab 等) ら pointerup は届かないので、その場で打ち切る。
  const onBlur = () => {
    phase = cancelPhase();
    cleanup();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // しきい値未満 (まだクリック扱い) の Esc は他の処理 (モーダルを閉じる等) に譲る。
    if (!dragged) return;
    e.stopPropagation();
    // ボタンを離すまで pointerup を待ち、離した時点で何もせず終わる (クリックも握りつぶす)。
    phase = cancelPhase();
    setCurrent(null, 0, 0);
    publish(INACTIVE);
    // カーソルは離すのを待たずに戻す (user-select は離すまで維持)。
    document.body.style.cursor = prevCursor;
    // pointermove は外さない: キャンセル後も buttons===0 を検知して後始末するため。
    // (phase は idle なので再びゴーストが出ることはない)
    window.removeEventListener("keydown", onKey, true);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
}
