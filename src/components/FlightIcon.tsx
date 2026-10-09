import type { ReactNode } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import { transitions } from "../motion";

/**
 * shared-element 連続性 (#1415) の起点 / 終点アイコンを包む薄いラッパ。
 * 飛行中 (`flightId` あり) だけ `motion.span` + `layoutId` で同じ ID の要素の間を morph する。
 * 待機中は素の span を返す: `motion.*` は layout 無しでも projection node を作って
 * 全体の走査・計測対象になり、行数 / タブ数ぶん常駐すると重くなるため。ID の決め方は `sharedElement.ts`。
 *
 * reduced-motion では ID を無視する。共有 layoutId のクロスフェードは MotionConfig では
 * 止まらず、起点が消えたままになるため (`useReducedMotionConfig` は OS 設定に加えてルート `MotionConfig` のアプリ内設定も見る)。
 */
export function FlightIcon({ flightId, children }: { flightId: string | null; children: ReactNode }) {
  const reducedMotion = useReducedMotionConfig();
  if (flightId === null || reducedMotion) {
    return <span style={{ display: "inline-block" }}>{children}</span>;
  }
  // layoutId は mount 時にしか共有スタックへ登録されないため、span → motion.span の
  // 切替 (= 作り直し) で飛行に参加させる。
  return (
    <motion.span key={flightId} layoutId={flightId} transition={transitions.emphasized} style={{ display: "inline-block" }}>
      {children}
    </motion.span>
  );
}
