import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";

// motion 用 props の `transition` は Chakra のスタイルプロップ名と衝突するため、明示的に転送する
// (`TabBar` の `MotionIndicator` と同じパターン)。
const MotionHighlight = chakra(motion.div, {}, { forwardProps: ["transition"] });

/**
 * キーボード駆動リスト (コマンドパレット・横断検索・履歴検索など) のアクティブ行の背後を
 * 滑らせる共有ハイライト (#976 / #1502)。
 *
 * アクティブな行の内側 (行は `position: relative`) にだけ `{active && <ActiveRowHighlight />}` の
 * 形でマウントする。同じ `layoutId` を持つ要素が行間を移ると、Motion が前回位置 → 新しい位置の
 * layout アニメーションを自動計算する。reduced-motion は `MotionConfig` が自動で瞬時化する。
 *
 * `layoutId` は画面内で一意にすること。モーダルごとに `useId()` で名前空間を分ける
 * (呼び出し側で `${prefix}-${useId()}` を作って渡す)。
 */
export function ActiveRowHighlight({ layoutId }: { layoutId: string }) {
  return (
    <MotionHighlight
      layoutId={layoutId}
      transition={transitions.emphasized}
      position="absolute"
      inset="0"
      bg="app.active"
      zIndex={0}
      pointerEvents="none"
      aria-hidden
      data-testid="active-row-highlight"
    />
  );
}
