import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { springs, transitions, variants } from "../motion";
import { useTabDragSnapshot, useTabLanding } from "./tabDragStore";

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
 * - ドロップ後の着地: ゴーストをドロップ地点に残し、移動先に現れたタブの位置へ滑らせながら消す。
 *   タブバーは `overflow` で切り抜かれ、Motion の共有 layoutId も Reorder.Item では起点を拾えなかった
 *   (実測) ため、切り抜かれない portal 側のゴーストで「ドロップ地点からタブが着地する」動きを見せる。
 *
 * reduced-motion では着地は省き、不透明度のフェードも duration 0 にする (`TabBar` と同じ判定)。
 * すべて pointer-events なし。操作を邪魔しない。
 */
export function TabDragOverlay() {
  const drag = useTabDragSnapshot();
  const landing = useTabLanding();
  const reduced = useReducedMotion() ?? false;
  const fade = reduced ? { duration: 0 } : transitions.crossfade;
  // ドロップ後も着地が終わるまで同じゴースト要素を残す。
  const lastDrag = useRef(drag);
  if (drag.active) lastDrag.current = drag;
  const ghost = drag.active
    ? drag
    : !reduced && landing && landing.tabId === lastDrag.current.tabId
      ? lastDrag.current
      : null;
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [fly, setFly] = useState<{ x: number; y: number } | null>(null);
  // 移動先のタブ (移動元以外のバーに現れる) を見つけたら、その位置へ滑らせる。現れるまで数フレーム待つ。
  useEffect(() => {
    if (!landing || reduced) {
      setFly(null);
      return;
    }
    let frame = 0;
    let tries = 0;
    const look = () => {
      const tab = Array.from(document.querySelectorAll<HTMLElement>(`[data-tab-id="${landing.tabId}"]`)).find(
        (el) => el.closest("[data-pane-zone]")?.getAttribute("data-pane-zone") !== landing.fromPaneId,
      );
      const g = ghostRef.current;
      if (tab && g) {
        const t = tab.getBoundingClientRect();
        const gr = g.getBoundingClientRect();
        // ゴーストは余白 (ml / mt) ぶん left / top からずれているので、見た目の箱をタブに合わせる。
        const cur = lastDrag.current;
        setFly({ x: t.left - (gr.left - cur.x), y: t.top - (gr.top - cur.y) });
      } else if (++tries < 30) {
        frame = requestAnimationFrame(look);
      }
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [landing, reduced]);
  const preview = drag.active ? drag.resolution?.preview : undefined;
  const rect = preview?.rect;
  return createPortal(
    <>
      <AnimatePresence>
        {ghost && (
          <MotionBox
            key="tab-drag-ghost"
            ref={ghostRef}
            {...variants.fade}
            animate={fly ? { left: fly.x, top: fly.y, opacity: 0 } : variants.fade.animate}
            transition={fly ? transitions.emphasized : fade}
            {...ghostProps}
            data-testid="tab-drag-ghost"
            style={{ left: ghost.x, top: ghost.y }}
            aria-hidden
          >
            {ghost.label}
          </MotionBox>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {rect && preview?.kind === "face" && (
          <MotionBox
            key="tab-drop-face"
            {...variants.fadeScale}
            transition={reduced ? { duration: 0 } : springs.gentle}
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
            transition={fade}
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
    </>,
    document.body,
  );
}
