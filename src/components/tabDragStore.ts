import { useSyncExternalStore } from "react";
import { durations } from "../motion";
import {
  isDraggedOut,
  resolveTabDrop,
  type PaneGeometry,
  type TabDropResolution,
  type TabDropTarget,
} from "../tabPaneDrop";

/**
 * タブをタブバーから縦に引き出して別ペインへ運ぶポインタ・ドラッグ (#2332) のイベント配線と外部ストア。
 *
 * 同じペイン内の並べ替えは従来どおり Motion の `Reorder` (横方向) が担当する。ポインタが
 * タブバーの帯から縦に `TAB_DRAG_OUT_DISTANCE` 離れた時点で、Reorder のドラッグを取り消して
 * ここのドラッグへ切り替える (ツリー行のドラッグ `treeDragStore.ts` と同じポインタ方式。HTML5 の
 * D&D は WebView2 で使えない)。ドロップ先の判定は純関数 `resolveTabDrop` に任せ、ここは DOM から
 * 幾何を集めて結果を `TabDragOverlay` へ渡すだけ。
 *
 * DOM の目印: ペイン全体 `[data-pane-zone]` (値はペイン id) / タブバー `[data-tab-bar]` /
 * タブ `[data-tab-id]`。
 */

export interface TabDragSnapshot {
  active: boolean;
  tabId: string;
  label: string;
  x: number;
  y: number;
  resolution: TabDropResolution | null;
}

const INACTIVE: TabDragSnapshot = { active: false, tabId: "", label: "", x: 0, y: 0, resolution: null };

let snapshot: TabDragSnapshot = INACTIVE;
const listeners = new Set<() => void>();

function publish(next: TabDragSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

export function useTabDragSnapshot(): TabDragSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// --- ドロップ直後の「着地」(共有要素遷移、#2332) -----------------------------------------------

/** 着地中のタブ。ドロップ地点のゴースト (起点) と移動先のタブ (終点) が同じ layoutId を持つ。 */
export interface TabLanding {
  tabId: string;
  label: string;
  x: number;
  y: number;
}

/** 起点 (ドロップ地点のゴースト) と終点 (移動先のタブ) が共有する layoutId。 */
export function tabDropFlightId(tabId: string): string {
  return `tab-drop-flight:${tabId}`;
}

/** 着地の morph が終わったとみなして起点を外すまでの待ち (ms)。既存の duration トークンから導く。 */
export const TAB_DROP_FLIGHT_MS = Math.round((durations.med + durations.fast) * 1000);

let landing: TabLanding | null = null;
let landingTimer: ReturnType<typeof setTimeout> | null = null;
const landingListeners = new Set<() => void>();

function publishLanding(next: TabLanding | null) {
  landing = next;
  for (const l of landingListeners) l();
}

function beginLanding(next: TabLanding) {
  if (landingTimer) clearTimeout(landingTimer);
  publishLanding(next);
  landingTimer = setTimeout(() => {
    landingTimer = null;
    publishLanding(null);
  }, TAB_DROP_FLIGHT_MS);
}

const subscribeLanding = (l: () => void) => {
  landingListeners.add(l);
  return () => {
    landingListeners.delete(l);
  };
};
const getLanding = () => landing;

export function useTabLanding(): TabLanding | null {
  return useSyncExternalStore(subscribeLanding, getLanding, getLanding);
}

// --- ドラッグ本体 -----------------------------------------------------------------------------

/** 対話要素 (ボタン等) の上で押された場合はドラッグを始めない。 */
const INTERACTIVE = "button, a, input, textarea, select, [role='button']";

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function collectGeometry(): PaneGeometry[] {
  const out: PaneGeometry[] = [];
  for (const zone of document.querySelectorAll<HTMLElement>("[data-pane-zone]")) {
    const bar = zone.querySelector("[data-tab-bar]");
    if (!bar) continue;
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-id]")).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.tabId ?? "", left: r.left, right: r.right };
    });
    out.push({ paneId: zone.dataset.paneZone ?? "", rect: rectOf(zone), bar: rectOf(bar), tabs });
  }
  return out;
}

export interface TabDragSession {
  tabId: string;
  paneId: string;
  label: string;
  /** ドロップが成立したときに呼ぶ。 */
  onDrop: (tabId: string, target: TabDropTarget) => void;
}

/**
 * タブの pointerdown から呼ぶ。しきい値を超えるまでは何もしない (Reorder とクリックに任せる)。
 * 解除はセッション内で完結する (pointerup / cancel / Esc / blur で後始末)。
 */
export function startTabDrag(down: PointerEvent, session: TabDragSession): void {
  if (down.button !== 0 || !down.isPrimary || snapshot.active) return;
  if (down.target instanceof Element && down.target.closest(INTERACTIVE)) return;
  const sourceBar = (down.target as Element | null)?.closest("[data-tab-bar]");
  if (!sourceBar) return;

  let dragged = false;
  // Reorder の取り消しに自分で投げた pointercancel を、自分の取り消しと取り違えない。
  let synthetic = false;
  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    if (dragged) {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    }
    publish(INACTIVE);
  };

  // ドラッグ後にボタンを離すと発火するクリックを 1 回だけ握りつぶす (タブの選択を防ぐ)。
  const swallowClick = () => {
    const stop = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, true), 0);
  };

  const resolve = (x: number, y: number) =>
    resolveTabDrop(x, y, collectGeometry(), session.paneId, session.tabId);

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    if (e.buttons === 0) {
      onCancel(e);
      return;
    }
    if (!dragged) {
      if (!isDraggedOut(e.clientX, e.clientY, sourceBar.getBoundingClientRect())) return;
      dragged = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      // Motion の Reorder が掴んでいるドラッグを終わらせる (タブは元の位置へ戻る)。
      synthetic = true;
      window.dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: down.pointerId, isPrimary: true, button: 0 }),
      );
      synthetic = false;
    }
    publish({
      active: true,
      tabId: session.tabId,
      label: session.label,
      x: e.clientX,
      y: e.clientY,
      resolution: resolve(e.clientX, e.clientY),
    });
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    const wasDragged = dragged;
    const resolution = wasDragged ? resolve(e.clientX, e.clientY) : null;
    cleanup();
    if (!wasDragged) return;
    swallowClick();
    if (!resolution) return;
    beginLanding({ tabId: session.tabId, label: session.label, x: e.clientX, y: e.clientY });
    session.onDrop(session.tabId, resolution.target);
  };

  const onCancel = (e: PointerEvent) => {
    if (synthetic || e.pointerId !== down.pointerId) return;
    const wasDragged = dragged;
    cleanup();
    if (wasDragged) swallowClick();
  };

  const onBlur = () => cleanup();

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dragged) return;
    e.stopPropagation();
    e.preventDefault();
    // ボタンを離した後のクリックだけ握りつぶし、何も移さずに終える。
    cleanup();
    // ボタンを離すのはこれからなので、離した時点で発火するクリックを待って握りつぶす。
    window.addEventListener("pointerup", swallowClick, { capture: true, once: true });
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
}
