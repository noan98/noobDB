import type { ReactNode } from "react";
import { motion } from "motion/react";
import { transitions } from "../motion";

/**
 * shared-element 連続性 (#1415) の起点 / 終点アイコンを包む薄いラッパ。
 * `flightId` があるときだけ `layoutId` を持ち、同じ ID の要素の間で位置を morph する。
 * 無いときは見た目に影響しない `inline-flex` の span。ID の決め方は `sharedElement.ts`。
 */
export function FlightIcon({ flightId, children }: { flightId: string | null; children: ReactNode }) {
  return (
    // layoutId は mount 時にしか共有スタックへ登録されないため、ID の有無が変わったら
    // key で作り直す (付け外しだけでは起点が morph に参加しない)。
    <motion.span
      key={flightId ?? "idle"}
      layoutId={flightId ?? undefined}
      transition={transitions.emphasized}
      style={{ display: "inline-flex" }}
    >
      {children}
    </motion.span>
  );
}
