import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { transitions } from "../motion";

/**
 * テーマ切替時の控えめなクロスフェード (#465)。`themeKey` (= data-theme) が変わると、
 * 新しいテーマの地色を一瞬全画面に重ねてからフェードアウトし、トークンの瞬時切替を
 * なめらかに見せる。初回マウント時は再生しない。`prefers-reduced-motion` 時は
 * ルートの `<MotionConfig reducedMotion="user">` により即時化される。
 */
export function ThemeTransition({ themeKey }: { themeKey: string }) {
  const [flashKey, setFlashKey] = useState<number | null>(null);
  const prev = useRef(themeKey);
  const counter = useRef(0);

  useEffect(() => {
    if (prev.current === themeKey) return;
    prev.current = themeKey;
    counter.current += 1;
    setFlashKey(counter.current);
  }, [themeKey]);

  return createPortal(
    <AnimatePresence>
      {flashKey !== null && (
        <motion.div
          key={flashKey}
          aria-hidden
          initial={{ opacity: 0.5 }}
          animate={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={transitions.emphasized}
          onAnimationComplete={() => setFlashKey(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--bg)",
            pointerEvents: "none",
            zIndex: "var(--z-toast)" as unknown as number,
          }}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
