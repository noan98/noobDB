import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { springs, transitions, variants } from "../motion";
import { tabDropFlightId, useTabDragSnapshot, useTabLanding } from "./tabDragStore";

const MotionBox = chakra(motion.div, {}, { forwardProps: ["transition"] });

const ghostProps = {
  position: "fixed",
  zIndex: "popover",
  ml: "3",
  mt: "3",
  px: "2.5",
  py: "1",
  bg: "app.surface",
  border: "1px solid",
  borderColor: "app.accent",
  borderRadius: "md",
  boxShadow: "var(--shadow-lg)",
  fontSize: "sm",
  color: "app.text",
  whiteSpace: "nowrap",
  pointerEvents: "none",
} as const;

/**
 * タブをペインへドラッグしている間の描画 (#2332)。App に 1 つだけ置く。
 *
 * - ポインタに追従するゴースト (タブ名)
 * - ドロップ先のプレビュー: ペイン本体は `app.accent` の薄い面 + 枠 (`variants.fadeScale` + `springs.gentle`)、
 *   タブバーは挿入位置の縦線
 * - ドロップ後は、ドロップ地点にゴーストを短く残し、移動先のタブと `layoutId` を共有して着地させる
 *   (`sharedElement.ts` と同じ所作。reduced-motion ではルートの `MotionConfig` が即時にする)
 *
 * すべて pointer-events なし。操作を邪魔しない。
 */
export function TabDragOverlay() {
  const drag = useTabDragSnapshot();
  const landing = useTabLanding();
  const preview = drag.active ? drag.resolution?.preview : undefined;
  const rect = preview?.rect;
  return createPortal(
    <>
      <AnimatePresence>
        {drag.active && (
          <MotionBox
            key="tab-drag-ghost"
            {...variants.fade}
            transition={transitions.crossfade}
            {...ghostProps}
            data-testid="tab-drag-ghost"
            style={{ left: drag.x, top: drag.y }}
            aria-hidden
          >
            {drag.label}
          </MotionBox>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {rect && preview?.kind === "face" && (
          <MotionBox
            key="tab-drop-face"
            {...variants.fadeScale}
            transition={springs.gentle}
            position="fixed"
            zIndex="popover"
            bg="app.accentHighlight"
            border="2px solid"
            borderColor="app.accent"
            borderRadius="md"
            pointerEvents="none"
            data-testid="tab-drop-preview"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.right - rect.left,
              height: rect.bottom - rect.top,
            }}
            aria-hidden
          />
        )}
        {rect && preview?.kind === "marker" && (
          <MotionBox
            key="tab-drop-marker"
            {...variants.fade}
            transition={transitions.crossfade}
            position="fixed"
            zIndex="popover"
            w="0.5"
            bg="app.accent"
            borderRadius="pill"
            pointerEvents="none"
            data-testid="tab-drop-marker"
            style={{ left: rect.left, top: rect.top, height: rect.bottom - rect.top }}
            aria-hidden
          />
        )}
      </AnimatePresence>
      {landing && (
        <MotionBox
          key={`landing-${landing.tabId}`}
          layoutId={tabDropFlightId(landing.tabId)}
          {...ghostProps}
          data-testid="tab-drop-landing"
          style={{ left: landing.x, top: landing.y }}
          aria-hidden
        >
          <Box as="span">{landing.label}</Box>
        </MotionBox>
      )}
    </>,
    document.body,
  );
}
