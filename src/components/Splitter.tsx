import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box } from "@chakra-ui/react";
import { animate, useReducedMotion } from "motion/react";
import { durations, easings } from "../motion";

type Direction = "row" | "column";

interface Props {
  // "row" = side-by-side panes, drag the divider left/right.
  // "column" = stacked panes, drag the divider up/down.
  direction: Direction;
  first: ReactNode;
  second: ReactNode;
  // Initial fraction (0..1) of the first pane. Used only when nothing is persisted.
  defaultFraction?: number;
  // Minimum size in px for either pane while dragging.
  minSize?: number;
  // If set, the user's split ratio is persisted under this localStorage key.
  storageKey?: string;
  ariaLabel?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function readStoredFraction(storageKey: string | undefined, fallback: number): number {
  if (!storageKey) return fallback;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      const f = Number(stored);
      if (Number.isFinite(f) && f > 0 && f < 1) return f;
    }
  } catch {
    // ignore
  }
  return fallback;
}

export function Splitter({
  direction,
  first,
  second,
  defaultFraction = 0.5,
  minSize = 80,
  storageKey,
  ariaLabel,
}: Props) {
  const [fraction, setFraction] = useState<number>(() =>
    readStoredFraction(storageKey, defaultFraction),
  );
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, fraction.toFixed(4));
    } catch {
      // ignore
    }
  }, [fraction, storageKey]);

  // Lock the global cursor while dragging so it doesn't flicker when the
  // pointer wanders outside the (thin) handle.
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = direction === "row" ? "ew-resize" : "ns-resize";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragging, direction]);

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = direction === "row" ? rect.width : rect.height;
      if (total <= 0) return;
      const offset = direction === "row" ? clientX - rect.left : clientY - rect.top;
      const minF = total > 2 * minSize ? minSize / total : 0;
      const maxF = total > 2 * minSize ? 1 - minSize / total : 1;
      setFraction(clamp(offset / total, minF, maxF));
    },
    [direction, minSize],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      updateFromPointer(e.clientX, e.clientY);
    },
    [dragging, updateFromPointer],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const prefersReducedMotion = useReducedMotion();

  const onDoubleClick = useCallback(() => {
    if (prefersReducedMotion) {
      setFraction(defaultFraction);
      return;
    }
    animate(fraction, defaultFraction, {
      duration: durations.slow,
      ease: easings.out,
      onUpdate: (v) => setFraction(v),
    });
  }, [defaultFraction, fraction, prefersReducedMotion]);

  // Keyboard resize (a11y): arrow keys nudge the divider, Home/End jump to the
  // min/max, Enter/Backspace reset to the default split. Step respects the same
  // min-size clamp as pointer dragging.
  const nudge = useCallback(
    (delta: number) => {
      const el = containerRef.current;
      const total = el ? (direction === "row" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height) : 0;
      const minF = total > 2 * minSize ? minSize / total : 0;
      const maxF = total > 2 * minSize ? 1 - minSize / total : 1;
      setFraction((f) => clamp(f + delta, minF, maxF));
    },
    [direction, minSize],
  );

  const isRow = direction === "row";

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const dec = isRow ? "ArrowLeft" : "ArrowUp";
      const inc = isRow ? "ArrowRight" : "ArrowDown";
      if (e.key === dec) {
        e.preventDefault();
        nudge(-0.02);
      } else if (e.key === inc) {
        e.preventDefault();
        nudge(0.02);
      } else if (e.key === "Home") {
        e.preventDefault();
        nudge(-1);
      } else if (e.key === "End") {
        e.preventDefault();
        nudge(1);
      } else if (e.key === "Enter" || e.key === "Backspace") {
        e.preventDefault();
        setFraction(defaultFraction);
      }
    },
    [isRow, nudge, defaultFraction],
  );

  return (
    <Box
      ref={containerRef}
      display="flex"
      flexDirection={isRow ? "row" : "column"}
      flex="1 1 auto"
      minW={0}
      minH={0}
      overflow="hidden"
    >
      <Box
        display="flex"
        flexDirection="column"
        overflow="hidden"
        minW={0}
        minH={0}
        style={{ flexGrow: fraction, flexShrink: 1, flexBasis: 0 }}
      >
        {first}
      </Box>
      <Box
        flex="0 0 auto"
        position="relative"
        zIndex={4}
        display="flex"
        alignItems="center"
        justifyContent="center"
        userSelect="none"
        touchAction="none"
        // Hit area is deliberately wider than the visible line so the divider is
        // easy to grab; the line itself (the ::before child) stays thin.
        width={isRow ? "11px" : undefined}
        height={isRow ? undefined : "11px"}
        marginX={isRow ? "-3px" : undefined}
        marginY={isRow ? undefined : "-3px"}
        cursor={isRow ? "ew-resize" : "ns-resize"}
        role="separator"
        tabIndex={0}
        aria-orientation={isRow ? "vertical" : "horizontal"}
        aria-label={ariaLabel}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="pane-splitter"
        data-dragging={dragging ? "" : undefined}
        data-row={isRow ? "" : undefined}
        css={{
          // 細い視認ライン (見た目)。ホバー/ドラッグ/フォーカスでアクセント色に。
          "&::before": {
            content: '""',
            position: "absolute",
            background: "var(--border)",
            transition: "background var(--dur-fast) var(--ease)",
            ...(isRow
              ? { top: 0, bottom: 0, left: "50%", width: "1px", transform: "translateX(-50%)" }
              : { left: 0, right: 0, top: "50%", height: "1px", transform: "translateY(-50%)" }),
          },
          "&:hover::before, &[data-dragging]::before, &:focus-visible::before": {
            background: "var(--accent)",
            ...(isRow ? { width: "2px" } : { height: "2px" }),
          },
          // つかみどころのグリップ (ドット)。ホバー/フォーカスで出す。
          "& .pane-splitter-grip": {
            position: "relative",
            zIndex: 1,
            display: "flex",
            flexDirection: isRow ? "column" : "row",
            gap: "3px",
            opacity: 0,
            transition: "opacity var(--dur-fast) var(--ease)",
          },
          "&:hover .pane-splitter-grip, &[data-dragging] .pane-splitter-grip, &:focus-visible .pane-splitter-grip":
            { opacity: 0.9 },
          "& .pane-splitter-grip > span": {
            width: "3px",
            height: "3px",
            borderRadius: "50%",
            background: "var(--accent)",
          },
          "&:focus-visible": {
            outline: "none",
            boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)",
          },
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <Box className="pane-splitter-grip" aria-hidden>
          <span />
          <span />
          <span />
        </Box>
      </Box>
      <Box
        display="flex"
        flexDirection="column"
        overflow="hidden"
        minW={0}
        minH={0}
        style={{ flexGrow: 1 - fraction, flexShrink: 1, flexBasis: 0 }}
      >
        {second}
      </Box>
    </Box>
  );
}
