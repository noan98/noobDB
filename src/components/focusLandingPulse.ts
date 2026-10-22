// F6 の領域フォーカス巡回 (#681) で「着地した領域」を一瞬パルスさせる (#1764)。
// `.focus()` だけではネイティブのフォーカスリングが当たる場所に依存し、キーボード
// 利用者が現在地を見失いやすい。着地領域へ `is-focus-landing` クラスを付け、App.css の
// `focus-landing-pulse` キーフレームで外枠を一瞬光らせて消す (レイアウトは動かさない)。

import { isHighContrastDataTheme } from "./revealOrigin";

const LANDING_CLASS = "is-focus-landing";

/** 着地領域の外枠を出す要素の印 (サイドバー aside / QueryEditor ルート / 結果グリッド外枠)。 */
const REGION_SELECTOR = "[data-focus-landing-region]";

// 領域は DOM 構造ではなく `data-focus-landing-region` を付けた祖先として解決する。
// 外枠は疑似要素 (::after) のリングで描く (App.css)。スクロールしない外側要素に付けるので、
// スクロールで流れず、sticky 行 / CodeMirror など position: relative の子孫の上に出せる。
// `.cm-editor` 自身は CodeMirror がフォーカス変化のたびに `className` を丸ごと書き換える
// ので、そこにクラスは付けない。
function resolveRegion(focused: Element): HTMLElement | null {
  return focused.closest<HTMLElement>(REGION_SELECTOR);
}

/** 現在パルス中の要素。連続して F6 が押されたとき、前の領域のクラスを確実に外す。 */
let current: HTMLElement | null = null;

/** reduced-motion (OS / アプリ設定 #787)・hc-* テーマ・forced-colors では演出を出さない。 */
export function focusLandingPulseEnabled(): boolean {
  const root = document.documentElement;
  if (isHighContrastDataTheme(root.getAttribute("data-theme") ?? "")) return false;
  if (typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches) {
    return false;
  }
  const motion = root.getAttribute("data-motion");
  if (motion === "reduced") return false;
  if (motion === "full") return true;
  return !(
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function onLandingEnd(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  // 子孫要素のアニメーション完了 (バブリング) では外さない。
  if (e.target !== el) return;
  clear(el);
  if (current === el) current = null;
}

function clear(el: HTMLElement): void {
  el.classList.remove(LANDING_CLASS);
  el.removeEventListener("animationend", onLandingEnd);
  el.removeEventListener("animationcancel", onLandingEnd);
}

/**
 * フォーカスが着地した要素 (`document.activeElement`) を含む領域の外枠をパルスさせる。
 * クラスは animationend で外す (タイマーを持たないのでリークしない)。連打時は
 * いったん外して強制リフローし、アニメーションを頭から再生し直す。
 */
export function pulseFocusLanding(focused: Element | null = document.activeElement): void {
  if (!focused || !focusLandingPulseEnabled()) return;
  // フォーカスが移らず body / html のままのときは何も光らせない。
  if (focused === document.body || focused === document.documentElement) return;
  const region = resolveRegion(focused);
  if (!region) return;
  if (current && current !== region) clear(current);
  clear(region);
  void region.offsetWidth; // 同じ領域への連続着地でも再生し直す
  region.classList.add(LANDING_CLASS);
  current = region;
  // 同じ関数参照なので、連打しても購読は 1 つのまま (重複登録されない)。
  region.addEventListener("animationend", onLandingEnd);
  region.addEventListener("animationcancel", onLandingEnd);
}
