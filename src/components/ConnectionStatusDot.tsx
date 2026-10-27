import { chakra } from "@chakra-ui/react";
import { useEffect, useRef } from "react";
import { reducedMotionActive } from "../motion";
import { prefersStaticMotion } from "./revealOrigin";

export type ConnectionDotStatus = "connected" | "connecting" | "error" | "idle";

const OPEN_CLASS = "is-tunnel-open";

/**
 * 「トンネル開通」(#1866) を再生すべき遷移か。`connecting` から `connected` へ変わった瞬間だけ
 * true。初期表示で既に接続済み (前回の状態が無い) や、再描画で同じ状態が続く場合は false。
 */
export function shouldPlayTunnelOpen(prev: ConnectionDotStatus | null, next: ConnectionDotStatus): boolean {
  return prev === "connecting" && next === "connected";
}

function onEnd(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  // 子孫要素のアニメーション完了 (バブリング) では外さない。
  if (e.target !== el) return;
  clear(el);
}

// 付け直し前の古いアニメーションの cancel が遅れて届く場合は、新しい再生中なら外さない。
function onCancel(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  if (e.target !== el) return;
  if (typeof el.getAnimations !== "function" || el.getAnimations().length > 0) return;
  clear(el);
}

function clear(el: HTMLElement): void {
  el.classList.remove(OPEN_CLASS);
  el.removeEventListener("animationend", onEnd);
  el.removeEventListener("animationcancel", onCancel);
}

/** reduced-motion (OS / アプリ設定)・hc-* テーマ・forced-colors では再生しない。 */
export function tunnelOpenEnabled(): boolean {
  return !reducedMotionActive() && !prefersStaticMotion();
}

/** 接続状態ドットの状態別 style。色は動的トークンの
 *  ため CSS 変数を直接参照する。`connecting` の脈動は App.css の @keyframes pulse。 */
const STATUS_DOT_STYLE = {
  idle: {
    bg: "var(--status-idle)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-idle) 18%, transparent)",
  },
  connected: {
    bg: "var(--status-connected)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-connected) 25%, transparent)",
  },
  connecting: {
    bg: "var(--status-connecting)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-connecting) 25%, transparent)",
    animation: "pulse 1.2s ease-in-out infinite",
  },
  error: {
    bg: "var(--status-error)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-error) 25%, transparent)",
  },
} as const;

/**
 * 接続状態ドット。`connecting → connected` の遷移を検知した 1 回だけ、DOM へ直接
 * `is-tunnel-open` を付けて App.css の `tunnel-open-bloom` を再生する (React 再描画なし)。
 * クラスは animationend / animationcancel で外す。前回の状態は ref に持ち、StrictMode の
 * 二重 effect でも同じ遷移を 2 度再生しない。
 */
export function ConnectionStatusDot({ status, label }: { status: ConnectionDotStatus; label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<ConnectionDotStatus | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = status;
    const el = ref.current;
    if (!el || !shouldPlayTunnelOpen(before, status) || !tunnelOpenEnabled()) return;
    // KeepAlive で非表示中 (display: none) に遷移した場合は、再表示時に遅れて再生しない。
    if (el.getClientRects().length === 0) return;
    clear(el);
    void el.offsetWidth; // 再生し直す
    el.classList.add(OPEN_CLASS);
    el.addEventListener("animationend", onEnd);
    el.addEventListener("animationcancel", onCancel);
  }, [status]);

  useEffect(() => {
    // 再生中に別状態へ変わった / アンマウントされたときはクラスを残さない。
    if (status !== "connected") {
      const el = ref.current;
      if (el) clear(el);
    }
  }, [status]);

  return (
    <chakra.span
      ref={ref}
      display="inline-block"
      width="8px"
      height="8px"
      borderRadius="50%"
      flexShrink={0}
      transitionProperty="background, box-shadow"
      transitionDuration="var(--dur-med)"
      transitionTimingFunction="var(--ease)"
      {...STATUS_DOT_STYLE[status]}
      aria-label={label}
    />
  );
}
