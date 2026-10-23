// 無効な主アクション (Modal の `submitDisabled` 中の Cmd/Ctrl+Enter / 無効な主ボタン) が
// 操作されたときに、「拒否された」ことを一度だけ視覚で返す (#1831)。無言で握り潰すと
// 「効いていない」と誤解されるため、モーダル本体へ `data-submit-rejected` を付け、
// App.css の `submit-reject-shake` キーフレームで微小に横揺れさせる。
// reduced-motion / hc-* / forced-colors の判定は F6 着地パルスと同じ (focusLandingPulse.ts)。

import { focusLandingPulseEnabled } from "./focusLandingPulse";

const REJECT_ATTR = "data-submit-rejected";

function onRejectEnd(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  // 子孫要素のアニメーション完了 (バブリング) では外さない。
  if (e.target !== el) return;
  clear(el);
}

// 連打時、付け直し前の古いアニメーションの cancel が遅れて届く。新しいアニメーションが
// 走っている間は外さない (getAnimations が無い環境では cancel を無視し、次回の拒否で再生し直す)。
function onRejectCancel(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  if (e.target !== el) return;
  if (typeof el.getAnimations !== "function" || el.getAnimations().length > 0) return;
  clear(el);
}

function clear(el: HTMLElement): void {
  el.removeAttribute(REJECT_ATTR);
  el.removeEventListener("animationend", onRejectEnd);
  el.removeEventListener("animationcancel", onRejectCancel);
}

/**
 * `el` に拒否演出を一度だけ適用する。属性は animationend で外す (タイマーを持たない)。
 * 連打時はいったん外して強制リフローし、頭から再生し直す。演出が抑制される環境では
 * 属性を付けない。理由 (`[role="alert"]` の FieldError / ErrorNote) があれば、抑制時も
 * 視界へ寄せる。
 */
export function rejectSubmit(el: HTMLElement): void {
  const reason = el.querySelector<HTMLElement>('[role="alert"]');
  if (reason && typeof reason.scrollIntoView === "function") {
    reason.scrollIntoView({ block: "nearest" });
  }
  if (!focusLandingPulseEnabled()) return;
  clear(el);
  void el.offsetWidth; // 連続して拒否されても再生し直す
  el.setAttribute(REJECT_ATTR, "");
  el.addEventListener("animationend", onRejectEnd);
  el.addEventListener("animationcancel", onRejectCancel);
}
