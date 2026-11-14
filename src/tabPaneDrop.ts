/**
 * タブをペインへドラッグして移す / 分割する操作 (#2332) の純ロジック。DOM・React に
 * 触れないので Vitest で単体テストできる。ポインタの配線とゴースト描画は
 * `components/tabDragStore.ts` / `components/TabDragOverlay.tsx` が担当し、ここは
 *
 * 1. 「縦に引き出したらドラッグへ切り替える」判定 (`isDraggedOut`)
 * 2. ポインタ座標 → ドロップ先 + プレビュー面の判定 (`resolveTabDrop`)
 * 3. ドロップ先を適用したペイン配列の算出 (`applyTabDrop`)
 *
 * を提供する。3 は App の `moveTabToOtherPane` (メニュー操作) も使い、メニューとドラッグで
 * 状態遷移がズレないようにする。ピン留め (#1486) の正規化は App の安全網 effect が
 * どの経路でも掛けるので、ここでは並びを素直に挿すだけでよい。タブ本体 (`tabs`) は
 * 触らないので、ストリーミング中のタブの購読は移動しても途切れない。
 */

/** 画面 (viewport) 座標の矩形。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 通常のタブドラッグ (Reorder) から切り替える、タブバーの帯からの縦方向の距離の、バーの高さに対する比。
 * 実寸はバーの高さ (フォント拡大・密度に追従する) から導くので px 直値を持たない。
 */
export const TAB_DRAG_OUT_RATIO = 0.75;

/** 1 ペインのとき、ペイン本体の右端のこの割合が「分割ゾーン」になる。 */
export const SPLIT_EDGE_RATIO = 0.25;

/** ペインを分割できる上限 (App のペインは最大 2 つ)。 */
export const MAX_PANES = 2;

export interface TabGeometry {
  id: string;
  left: number;
  right: number;
}

/** 1 ペイン分の幾何。`rect` はペイン全体 (タブバー込み)、`bar` はタブバーの帯。 */
export interface PaneGeometry {
  paneId: string;
  rect: Rect;
  bar: Rect;
  /** 左から右の並びで、いま描画されているタブの位置。 */
  tabs: TabGeometry[];
}

/** ドロップの意味。`applyTabDrop` へそのまま渡せる。 */
export type TabDropTarget =
  | { kind: "bar"; paneId: string; index: number }
  | { kind: "append"; paneId: string }
  | { kind: "split" };

export interface TabDropResolution {
  target: TabDropTarget;
  /** 表示するプレビュー。`marker` は挿入位置の縦線 (幅 0)、`face` は面。 */
  preview: { kind: "marker" | "face"; rect: Rect };
}

/** 引き出しと見なす縦方向の距離。バーの高さ × `TAB_DRAG_OUT_RATIO`。 */
export function dragOutDistance(bar: Rect): number {
  return (bar.bottom - bar.top) * TAB_DRAG_OUT_RATIO;
}

/**
 * ポインタが元のタブバーから出て、Reorder の並べ替えからドロップ操作へ切り替える位置か。
 * 縦にバーの高さに比例した距離 (`dragOutDistance`) 以上離れた場合と、別のペインのタブバー
 * (`otherBars`) の上に入った場合が対象。元のバー内の横移動は従来どおり Reorder が並べ替える。
 */
export function isDraggedOut(x: number, y: number, bar: Rect, otherBars: readonly Rect[] = []): boolean {
  const d = dragOutDistance(bar);
  return y < bar.top - d || y > bar.bottom + d || otherBars.some((b) => inside(b, x, y));
}

const inside = (r: Rect, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/**
 * タブバー上の x に対する挿入位置 (0..tabs.length)。タブの中点より左なら手前、
 * どこにも当たらなければ末尾。`exclude` のタブ (ドラッグ中のもの) は数えない。
 */
export function insertionIndex(tabs: readonly TabGeometry[], x: number, exclude?: string): number {
  const rest = exclude ? tabs.filter((tb) => tb.id !== exclude) : tabs;
  const i = rest.findIndex((tb) => x < (tb.left + tb.right) / 2);
  return i < 0 ? rest.length : i;
}

/** 挿入位置のマーカーを出す x 座標 (タブの境界)。常にタブバーの内側 (スクロールで見切れたタブの外へ出さない)。 */
function markerX(pane: PaneGeometry, index: number): number {
  const { tabs, bar } = pane;
  let x = bar.left;
  if (tabs.length > 0) {
    if (index <= 0) x = tabs[0].left;
    else if (index >= tabs.length) x = tabs[tabs.length - 1].right;
    else x = tabs[index].left;
  }
  return Math.max(bar.left, Math.min(bar.right, x));
}

/**
 * ポインタ位置 `(x, y)` から、ドロップ先とプレビューを決める。落とせない場所は null。
 *
 * - 元のペイン以外のタブバー → その位置へ挿入 (`bar`)
 * - 2 ペイン: 元と別のペイン本体 → その末尾へ (`append`)
 * - 1 ペイン: 本体の右端 → 右半面へ分割 (`split`)。元のペインにタブが 1 つしか無いと
 *   分割後に元が空になるので落とせない
 * - 元のペイン自身の上 (タブバー含む) は null。同ペイン内の並べ替えは通常のドラッグが担当する。
 */
export function resolveTabDrop(
  x: number,
  y: number,
  panes: readonly PaneGeometry[],
  sourcePaneId: string,
  tabId: string,
): TabDropResolution | null {
  const pane = panes.find((p) => inside(p.rect, x, y));
  if (!pane) return null;
  const isSource = pane.paneId === sourcePaneId;

  if (inside(pane.bar, x, y)) {
    if (isSource) return null;
    const index = insertionIndex(pane.tabs, x, tabId);
    const mx = markerX({ ...pane, tabs: pane.tabs.filter((tb) => tb.id !== tabId) }, index);
    return {
      target: { kind: "bar", paneId: pane.paneId, index },
      preview: { kind: "marker", rect: { left: mx, right: mx, top: pane.bar.top, bottom: pane.bar.bottom } },
    };
  }

  // ここから本体 (タブバーより下)。
  const body: Rect = { ...pane.rect, top: pane.bar.bottom };
  if (panes.length >= MAX_PANES) {
    if (isSource) return null;
    return { target: { kind: "append", paneId: pane.paneId }, preview: { kind: "face", rect: body } };
  }

  // 1 ペイン: 右端で分割 (左分割は Splitter の first 枠から既存ペインが移って再マウントされるので持たない, #1310)。
  const source = panes.find((p) => p.paneId === sourcePaneId);
  if (!source || source.tabs.length < 2) return null;
  const width = body.right - body.left;
  const edge = width * SPLIT_EDGE_RATIO;
  const mid = (body.left + body.right) / 2;
  if (x >= body.right - edge) {
    return {
      target: { kind: "split" },
      preview: { kind: "face", rect: { ...body, left: mid } },
    };
  }
  return null;
}

/** `applyTabDrop` が必要とするペインの最小形 (App の `PaneState` はこれを満たす)。 */
export interface DropPane {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface TabDropResult<P extends DropPane> {
  panes: P[];
  /** ドロップ後にフォーカスするペイン。 */
  activePaneId: string;
}

/**
 * `tabId` を `target` へ移した結果を返す。元のペインが空になれば取り除く (1 ペインへ戻る)。
 * 成立しない (タブが無い・同じペイン・分割で元が空になる・ペイン数上限) ときは null。
 * 元のペインのアクティブタブは、移したのがアクティブだったときだけ隣へ移す。
 */
export function applyTabDrop<P extends DropPane>(
  panes: readonly P[],
  tabId: string,
  target: TabDropTarget,
  newPaneId: () => string,
): TabDropResult<P> | null {
  const source = panes.find((p) => p.tabIds.includes(tabId));
  if (!source) return null;
  const idx = source.tabIds.indexOf(tabId);
  const remaining = source.tabIds.filter((id) => id !== tabId);
  const sourceActive =
    source.activeTabId === tabId ? (remaining[idx] ?? remaining[idx - 1] ?? null) : source.activeTabId;
  const shrunk: P = { ...source, tabIds: remaining, activeTabId: sourceActive };

  if (target.kind === "split") {
    if (panes.length >= MAX_PANES || remaining.length === 0) return null;
    const created = { id: newPaneId(), tabIds: [tabId], activeTabId: tabId } as P;
    const next = panes.map((p) => (p.id === source.id ? shrunk : p));
    return { panes: [...next, created], activePaneId: created.id };
  }

  const dest = panes.find((p) => p.id === target.paneId);
  if (!dest || dest.id === source.id) return null;
  const at =
    target.kind === "bar"
      ? Math.max(0, Math.min(dest.tabIds.length, Math.trunc(target.index)))
      : dest.tabIds.length;
  const inserted: P = {
    ...dest,
    tabIds: [...dest.tabIds.slice(0, at), tabId, ...dest.tabIds.slice(at)],
    activeTabId: tabId,
  };
  const next = panes
    .map((p) => (p.id === source.id ? shrunk : p.id === dest.id ? inserted : p))
    .filter((p) => p.id !== source.id || remaining.length > 0);
  return { panes: next, activePaneId: dest.id };
}
