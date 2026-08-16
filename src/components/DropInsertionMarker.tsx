import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions } from "../motion";

/**
 * ドラッグ並べ替え・キーボード移動の「着地位置マーカー」(#1007)。
 *
 * `TabBar` が最初に持っていた `AnimatePresence` + アクセントバーの挿入マーカーを
 * 汎用化した共有実装で、`TabBar` (タブ間の縦バー) と `ConnectionList` (プロファイル/
 * グループ行の上端横バー) の両方がこれを参照する。新しい並べ替え可能なリストを
 * 追加するときも、着地位置表示はここを再利用すること (新規の Motion 基盤を増やさない)。
 *
 * - **出入り**: `opacity` + `scale` (縦バーは `scaleY`、横バーは `scaleX`) を
 *   `transitions.crossfade` で補間する。`prefers-reduced-motion` /
 *   `motionPreference="reduced"` はルートの `<MotionConfig reducedMotion="user">`
 *   (`src/main.tsx`) が自動で即時化するため、ここで分岐は書かない。
 * - **色**: `var(--ws-accent, var(--accent))` — 接続切替 (#978) のアクセント変化に
 *   常時追従する。
 * - **配置**: `position: absolute` で描画するため、呼び出し側の行/タブ要素は
 *   `position: relative` を持つ必要がある。
 * - **a11y**: 装飾のみのため常に `aria-hidden`。読み上げは並べ替え操作そのものの
 *   既存ロジック (roving tabindex 等) が担い、ここには関与しない。
 */
const MotionIndicator = chakra(motion.span, {}, { forwardProps: ["transition"] });

export interface DropInsertionMarkerProps {
  /** マーカーを表示するか。false → true の遷移で enter アニメが再生される。 */
  visible: boolean;
  /**
   * `"vertical"`: タブの先頭辺に立てる縦バー (`TabBar`)。
   * `"horizontal"`: ツリー行の上端に横たえる横バー (`ConnectionList`)。
   */
  orientation: "vertical" | "horizontal";
}

export function DropInsertionMarker({ visible, orientation }: DropInsertionMarkerProps) {
  const vertical = orientation === "vertical";
  return (
    <AnimatePresence>
      {visible && (
        <MotionIndicator
          key="drop"
          initial={vertical ? { opacity: 0, scaleY: 0.4 } : { opacity: 0, scaleX: 0.4 }}
          animate={vertical ? { opacity: 1, scaleY: 1 } : { opacity: 1, scaleX: 1 }}
          exit={vertical ? { opacity: 0, scaleY: 0.4 } : { opacity: 0, scaleX: 0.4 }}
          transition={transitions.crossfade}
          position="absolute"
          left={vertical ? "-1px" : "0"}
          right={vertical ? undefined : "0"}
          top={vertical ? "2px" : "-1px"}
          bottom={vertical ? "2px" : undefined}
          w={vertical ? "2px" : undefined}
          h={vertical ? undefined : "2px"}
          borderRadius="1px"
          bg="var(--ws-accent, var(--accent))"
          zIndex={4}
          aria-hidden
        />
      )}
    </AnimatePresence>
  );
}
