import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";
import { useTreeDragSnapshot } from "./useTreeDragSource";

const MotionGhost = chakra(motion.div, {}, { forwardProps: ["transition"] });

/**
 * スキーマツリー行をドラッグしている間、ポインタの近くに出す小さなゴースト (#1414)。
 * 何を掴んでいるかをラベルで示し、エディタの上にいる間はアクセント枠で「ここに落とせる」を示す。
 * 入退場は共有 variants (`fade`)、影は `--shadow-lg`。操作を邪魔しないよう pointer-events なし。
 */
export function TreeDragGhost() {
  const drag = useTreeDragSnapshot();
  return createPortal(
    <AnimatePresence>
      {drag.active && (
        <MotionGhost
          key="tree-drag-ghost"
          {...variants.fade}
          transition={transitions.crossfade}
          position="fixed"
          zIndex="popover"
          ml="3"
          mt="3"
          px="2.5"
          py="1"
          bg="app.surface"
          border="1px solid"
          borderColor={drag.overEditor ? "app.accent" : "app.borderStrong"}
          borderRadius="md"
          boxShadow="var(--shadow-lg)"
          fontSize="sm"
          fontFamily="mono"
          color="app.text"
          whiteSpace="nowrap"
          pointerEvents="none"
          data-testid="tree-drag-ghost"
          style={{ left: drag.x, top: drag.y }}
          aria-hidden
        >
          <Box as="span">{drag.label}</Box>
        </MotionGhost>
      )}
    </AnimatePresence>,
    document.body,
  );
}
