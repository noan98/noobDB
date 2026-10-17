/**
 * 結果グリッドの「滑って追従する」選択/アクティブセル/検索ヒット枠 (#1578) と、
 * クリック&ドラッグのマーキー選択の純ロジック。DOM の計測・再生は
 * `useGlideFrame.ts`、ポインタ操作の配線は `ResultGrid.tsx` が受け持つ。
 */

/** スクロールコンテンツ座標系 (スクロールコンテナの padding box 原点) の矩形。 */
export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `getBoundingClientRect()` 相当 (ビューポート座標)。 */
export interface ClientRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** スクロールコンテナの計測値。 */
export interface ScrollerMetrics {
  /** コンテナ自身の `getBoundingClientRect()` の left / top。 */
  left: number;
  top: number;
  /** ボーダー幅 (`clientLeft` / `clientTop`)。 */
  clientLeft: number;
  clientTop: number;
  scrollLeft: number;
  scrollTop: number;
}

/** ビューポート座標の矩形をスクロールコンテンツ座標へ直す (枠は絶対配置でコンテンツと一緒にスクロールする)。 */
export function toContentBox(rect: ClientRectLike, m: ScrollerMetrics): BoxRect {
  return {
    left: rect.left - m.left - m.clientLeft + m.scrollLeft,
    top: rect.top - m.top - m.clientTop + m.scrollTop,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  };
}

/** 複数セルの外接矩形。空なら `null`。 */
export function unionBoxes(boxes: readonly BoxRect[]): BoxRect | null {
  if (boxes.length === 0) return null;
  let l = Number.POSITIVE_INFINITY;
  let t = Number.POSITIVE_INFINITY;
  let r = Number.NEGATIVE_INFINITY;
  let b = Number.NEGATIVE_INFINITY;
  for (const x of boxes) {
    l = Math.min(l, x.left);
    t = Math.min(t, x.top);
    r = Math.max(r, x.left + x.width);
    b = Math.max(b, x.top + x.height);
  }
  return { left: l, top: t, width: r - l, height: b - t };
}

/** 矩形が (サブピクセル誤差を除いて) 同じか。 */
export function boxesEqual(a: BoxRect | null, b: BoxRect | null, eps = 0.5): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.left - b.left) < eps &&
    Math.abs(a.top - b.top) < eps &&
    Math.abs(a.width - b.width) < eps &&
    Math.abs(a.height - b.height) < eps
  );
}

/** 枠を滑らせる最大距離 (ビューポート高さの倍数)。これより遠い移動 (Ctrl+↓ で末尾へ、など) は即座に置く。 */
export const GLIDE_MAX_VIEWPORTS = 2;

/**
 * `from` → `to` を滑らせて見せるか。直前の位置が無い (初回表示) / 動いていない /
 * 遠すぎる移動なら false (その場に置く)。
 */
export function shouldGlide(from: BoxRect | null, to: BoxRect, viewportHeight: number): boolean {
  if (from === null || boxesEqual(from, to)) return false;
  const limit = Math.max(viewportHeight, 1) * GLIDE_MAX_VIEWPORTS;
  return Math.abs(to.top - from.top) <= limit && Math.abs(to.left - from.left) <= limit * 2;
}

/**
 * 枠の対象を識別するキー。同じキーの間は「同じ対象のレイアウト再計測」とみなして
 * アニメーションせずに追従する (スクロールによる窓の更新・列幅変更など)。
 */
export function activeFrameKey(cell: { rowIdx: number; colIdx: number } | null): string | null {
  return cell ? `c:${cell.rowIdx}:${cell.colIdx}` : null;
}

export function selectionFrameKey(
  sel: { anchor: { rowIdx: number; colIdx: number }; focus: { rowIdx: number; colIdx: number } } | null,
): string | null {
  return sel ? `s:${sel.anchor.rowIdx}:${sel.anchor.colIdx}:${sel.focus.rowIdx}:${sel.focus.colIdx}` : null;
}

// ── マーキー (ドラッグ) 選択 ─────────────────────────────────────────

/** ドラッグ開始とみなすポインタ移動量 (px)。クリックの手ぶれでは始まらない。 */
export const MARQUEE_DRAG_THRESHOLD = 4;

export function exceedsDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= MARQUEE_DRAG_THRESHOLD;
}

/**
 * マーキーを開始してよいか。素の左クリックのドラッグだけが対象で、次の場合は既存の挙動に
 * 任せる: 修飾キー付き (Shift+クリックは範囲拡張・Ctrl/Cmd は OS 慣習)、編集中、
 * 入力欄 / ボタン / リンク上 (FK ジャンプ・編集欄のテキスト選択)。
 */
export function canStartMarquee(args: {
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  editing: boolean;
  onInteractive: boolean;
}): boolean {
  return (
    args.button === 0 &&
    !args.shiftKey &&
    !args.ctrlKey &&
    !args.metaKey &&
    !args.altKey &&
    !args.editing &&
    !args.onInteractive
  );
}

/** 端オートスクロールが効き始める、ビューポート端からの距離 (px)。 */
export const AUTOSCROLL_EDGE = 32;
/** 1 フレームあたりの最大スクロール量 (px)。 */
export const AUTOSCROLL_MAX_SPEED = 28;

/**
 * 1 軸のオートスクロール量 (px/フレーム。負は上/左へ)。`pos` が `[min + edge, max - edge]` の
 * 内側なら 0、端に近づくほど二次曲線で加速し、端を越えても `AUTOSCROLL_MAX_SPEED` で頭打ち。
 * `min`/`max` は固定列・ヘッダを除いたスクロール領域の端。
 */
export function autoScrollDelta(
  pos: number,
  min: number,
  max: number,
  edge = AUTOSCROLL_EDGE,
  maxSpeed = AUTOSCROLL_MAX_SPEED,
): number {
  if (!Number.isFinite(pos) || max - min <= 2 * edge) return 0;
  if (pos < min + edge) {
    const depth = Math.min(1, (min + edge - pos) / edge);
    return -Math.max(1, Math.round(depth * depth * maxSpeed));
  }
  if (pos > max - edge) {
    const depth = Math.min(1, (pos - (max - edge)) / edge);
    return Math.max(1, Math.round(depth * depth * maxSpeed));
  }
  return 0;
}

/**
 * ドラッグ中のポインタ位置で、`anchor` と `hover` の間の範囲を選択に反映する。単一セルに
 * 戻ったら選択を解除 (`null`) して、通常のクリックと同じ「アクティブセルだけ」に戻す。
 */
export function marqueeSelection(
  anchor: { rowIdx: number; colIdx: number },
  hover: { rowIdx: number; colIdx: number } | null,
): { anchor: { rowIdx: number; colIdx: number }; focus: { rowIdx: number; colIdx: number } } | null {
  if (!hover) return null;
  if (hover.rowIdx === anchor.rowIdx && hover.colIdx === anchor.colIdx) return null;
  return { anchor, focus: hover };
}

/** セル参照キー (`"<行 index>:<列 index>"`) を分解する。壊れていれば `null`。 */
export function parseCellKey(key: string): { rowIdx: number; colIdx: number } | null {
  const sep = key.indexOf(":");
  if (sep <= 0) return null;
  const rowIdx = Number(key.slice(0, sep));
  const colIdx = Number(key.slice(sep + 1));
  return Number.isInteger(rowIdx) && Number.isInteger(colIdx) ? { rowIdx, colIdx } : null;
}
