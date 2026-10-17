/**
 * 結果グリッドの列幅ドラッグ (#1312)。
 *
 * TanStack の `columnResizeMode: "onChange"` はマウスが動くたびに `columnSizing` の
 * state を更新し、DataGrid 全体の再レンダー・列仮想化の再計測・localStorage 書き込みを
 * 毎回走らせていた。ここではドラッグ中の幅を `<col>` と `<table>` の style へ直接
 * 反映し (rAF でフレームごとに 1 回)、離したときだけ `onCommit` で state と保存を確定する。
 */

/** ドラッグ量から新しい列幅を求める (min / max に収める)。 */
export function resizedColumnWidth(
  startSize: number,
  delta: number,
  minSize: number,
  maxSize: number,
): number {
  const next = startSize + delta;
  return Math.max(minSize, Math.min(maxSize, next));
}

/** 幅バッジに出す数値 (整数 px)。 */
export function formatResizeWidth(size: number): string {
  return String(Math.round(size));
}

/** 幅が最小 / 最大に張り付いているか (バッジの強調表示用)。 */
export function resizeClampState(size: number, minSize: number, maxSize: number): "min" | "max" | null {
  if (size <= minSize) return "min";
  if (size >= maxSize) return "max";
  return null;
}

/**
 * ドラッグ中だけ出すライブガイド (縦線 + 幅バッジ) (#1580)。単一の `position: fixed` 要素を
 * `document.body` へ足し、`transform` だけを rAF で動かす (React の state / 再レンダーには
 * 乗せない)。離したら取り除く。見た目は `App.css` の `.col-resize-guide`。
 */
function createResizeGuide(header: HTMLElement, table: HTMLElement | null, label: (width: string) => string) {
  const el = document.createElement("div");
  el.className = "col-resize-guide";
  el.setAttribute("aria-hidden", "true");
  const badge = document.createElement("span");
  badge.className = "col-resize-guide-badge";
  el.appendChild(badge);
  // ガイドの範囲: スクロール領域 (祖先) の内側に収める。縦はヘッダ上端から
  // min(スクロール領域の下端, テーブルの下端) まで (行が少ないとき空白を貫かない)。
  let scrollEl: HTMLElement | null = table?.parentElement ?? null;
  while (scrollEl && scrollEl !== document.body) {
    const oy = getComputedStyle(scrollEl).overflowY;
    if (oy === "auto" || oy === "scroll") break;
    scrollEl = scrollEl.parentElement;
  }
  if (scrollEl === document.body) scrollEl = null;
  const scrollRect = scrollEl?.getBoundingClientRect() ?? null;
  const topRect = header.getBoundingClientRect();
  const bottoms = [table?.getBoundingClientRect().bottom, scrollRect?.bottom].filter(
    (v): v is number => typeof v === "number",
  );
  const bottom = bottoms.length > 0 ? Math.min(...bottoms) : topRect.bottom;
  el.style.top = `${topRect.top}px`;
  el.style.height = `${Math.max(0, bottom - topRect.top)}px`;
  // バッジは右隣の列ヘッダ名を隠さないよう、ヘッダ行の下に出す。
  badge.style.top = `${Math.max(0, (topRect.bottom ?? topRect.top) - topRect.top)}px`;
  const place = () => {
    let x = header.getBoundingClientRect().right;
    if (scrollRect) x = Math.min(Math.max(x, scrollRect.left), scrollRect.right);
    el.style.transform = `translateX(${x}px)`;
    // 右端に近いときはバッジを線の左側へ反転する。
    const limit = scrollRect ? scrollRect.right : window.innerWidth;
    el.dataset.flip = x + badge.offsetWidth + 16 > limit ? "left" : "";
  };
  // 初回の位置は追加前に確定させる (transition で画面左端から滑ってこないように)。
  place();
  document.body.appendChild(el);
  return {
    update(size: number, clamp: "min" | "max" | null) {
      badge.textContent = label(formatResizeWidth(size));
      place();
      el.dataset.clamp = clamp ?? "";
    },
    remove() {
      el.remove();
    },
  };
}

export interface ColumnResizeDragOptions {
  /** `mousedown` / `touchstart` のイベント。 */
  event: React.MouseEvent | React.TouchEvent;
  startSize: number;
  minSize: number;
  maxSize: number;
  /** 幅を直接書き換える `<col>`。 */
  col: HTMLElement | null;
  /** 全体幅を合わせて書き換える `<table>`。 */
  table: HTMLElement | null;
  /** 列ヘッダ `<th>` (リサイズ中の見た目用クラスを付ける)。 */
  header: HTMLElement | null;
  /** 幅バッジの文言 (数値文字列 → 表示文)。省略するとライブガイドを出さない。 */
  guideLabel?: (width: string) => string;
  /** 確定した幅。変化が無ければ呼ばれない。 */
  onCommit: (size: number) => void;
}

function clientXOf(e: MouseEvent | TouchEvent): number | null {
  if ("touches" in e) {
    const t = e.touches[0] ?? e.changedTouches[0];
    return t ? t.clientX : null;
  }
  return e.clientX;
}

/** ドラッグを開始する。ドキュメントへ move / up を張り、終了時に解除する。 */
export function beginColumnResizeDrag(opts: ColumnResizeDragOptions): void {
  const { event, startSize, minSize, maxSize, col, table, header, guideLabel, onCommit } = opts;
  const native = event.nativeEvent;
  // 副ボタンのクリックではドラッグしない (TanStack の既定と同じ)。
  if ("button" in native && native.button !== 0 && native.type === "mousedown") return;
  if ("touches" in native && native.touches.length > 1) return;
  const startX = clientXOf(native);
  if (startX === null) return;
  const isTouch = "touches" in native;
  const startTableWidth = table ? table.getBoundingClientRect().width : 0;

  let size = startSize;
  let pendingX: number | null = null;
  let raf = 0;
  header?.classList.add("is-resizing");
  const guide = header && guideLabel ? createResizeGuide(header, table, guideLabel) : null;
  guide?.update(size, resizeClampState(size, minSize, maxSize));

  const apply = (x: number) => {
    size = resizedColumnWidth(startSize, x - startX, minSize, maxSize);
    if (col) col.style.width = `${size}px`;
    if (table && startTableWidth > 0) table.style.width = `${startTableWidth + (size - startSize)}px`;
    guide?.update(size, resizeClampState(size, minSize, maxSize));
  };
  const flush = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (pendingX !== null) {
      apply(pendingX);
      pendingX = null;
    }
  };
  const onMove = (e: MouseEvent | TouchEvent) => {
    const x = clientXOf(e);
    if (x === null) return;
    // フォーカス喪失などで mouseup を取り逃がした場合は、ボタンが離れていればここで終える。
    if (!isTouch && (e as MouseEvent).buttons === 0) {
      onEnd();
      return;
    }
    if (isTouch && e.cancelable) e.preventDefault();
    pendingX = x;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        flush();
      });
    }
  };
  const onEnd = () => {
    flush();
    document.removeEventListener(isTouch ? "touchmove" : "mousemove", onMove);
    document.removeEventListener(isTouch ? "touchend" : "mouseup", onEnd);
    if (isTouch) document.removeEventListener("touchcancel", onEnd);
    window.removeEventListener("blur", onEnd);
    header?.classList.remove("is-resizing");
    guide?.remove();
    if (size !== startSize) onCommit(size);
  };
  document.addEventListener(isTouch ? "touchmove" : "mousemove", onMove, { passive: false });
  document.addEventListener(isTouch ? "touchend" : "mouseup", onEnd);
  if (isTouch) document.addEventListener("touchcancel", onEnd);
  window.addEventListener("blur", onEnd);
}
