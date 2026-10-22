// F6 の領域フォーカス巡回 (#681) で「着地した領域」を一瞬パルスさせる (#1764)。
// `.focus()` だけではネイティブのフォーカスリングが当たる場所に依存し、キーボード
// 利用者が現在地を見失いやすい。着地領域へ `is-focus-landing` クラスを付け、App.css の
// `focus-landing-pulse*` キーフレームで外枠を一瞬光らせて消す (レイアウトは動かさない)。

const LANDING_CLASS = "is-focus-landing";

const OVERLAY_CLASS = "is-focus-landing-overlay";

// 着地領域の外枠を出す要素の解決。内側のフォーカス要素から辿る。
// - サイドバー: `aside`
// - エディタ: `.cm-editor` の親の親 (QueryEditor のルート = ツールバー + エディタ)。
//   `.cm-editor` 自身は CodeMirror がフォーカス変化のたびに `className` を丸ごと書き換えるので、
//   付けたクラスが消える。host (`.cm-editor` の親) はスクロールコンテナで、疑似要素だと
//   スクロールで流れる。
// - 結果グリッド: フォーカス要素 (コンテナ) 自身。
// overlay=true の領域は疑似要素 (::after) のリングで描く。outline / inset box-shadow は
// `position: relative` の子孫 (CodeMirror など) の下に隠れてしまうため。
function resolveRegion(focused: Element): { el: HTMLElement; overlay: boolean } {
  const editorRoot = focused.closest<HTMLElement>(".cm-editor")?.parentElement?.parentElement;
  if (editorRoot) return { el: editorRoot, overlay: true };
  const aside = focused.closest<HTMLElement>("aside");
  if (aside) return { el: aside, overlay: true };
  return { el: focused as HTMLElement, overlay: false };
}

/** 現在パルス中の要素。連続して F6 が押されたとき、前の領域のクラスを確実に外す。 */
let current: HTMLElement | null = null;

/** reduced-motion (OS / アプリ設定 #787) と hc-* テーマでは演出を出さない。 */
export function focusLandingPulseEnabled(): boolean {
  const root = document.documentElement;
  const theme = root.getAttribute("data-theme") ?? "";
  if (theme.startsWith("hc-")) return false;
  const motion = root.getAttribute("data-motion");
  if (motion === "reduced") return false;
  if (motion === "full") return true;
  return !(
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function onLandingEnd(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  // 子孫要素のアニメーション完了では外さない。
  if (e.target !== el) return;
  clear(el);
  el.removeEventListener("animationend", onLandingEnd);
  if (current === el) current = null;
}

function clear(el: HTMLElement): void {
  el.classList.remove(LANDING_CLASS, OVERLAY_CLASS);
}

/**
 * フォーカスが着地した要素 (`document.activeElement`) を含む領域の外枠をパルスさせる。
 * クラスは animationend で外す (タイマーを持たないのでリークしない)。連打時は
 * いったん外して強制リフローし、アニメーションを頭から再生し直す。
 */
export function pulseFocusLanding(focused: Element | null = document.activeElement): void {
  if (!focused || !focusLandingPulseEnabled()) return;
  const { el: region, overlay } = resolveRegion(focused);
  if (current && current !== region) clear(current);
  clear(region);
  void region.offsetWidth; // 同じ領域への連続着地でも再生し直す
  region.classList.add(LANDING_CLASS);
  if (overlay) region.classList.add(OVERLAY_CLASS);
  current = region;
  // 同じ関数参照なので、連打しても購読は 1 つのまま (重複登録されない)。
  region.addEventListener("animationend", onLandingEnd);
}
