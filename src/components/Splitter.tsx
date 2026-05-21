import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
  className?: string;
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
  className,
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

  const onDoubleClick = useCallback(() => {
    setFraction(defaultFraction);
  }, [defaultFraction]);

  const handleClass =
    direction === "row"
      ? "splitter-handle splitter-handle-v"
      : "splitter-handle splitter-handle-h";

  return (
    <div
      ref={containerRef}
      className={`splitter splitter-${direction}${className ? " " + className : ""}`}
    >
      <div
        className="splitter-pane"
        style={{ flexGrow: fraction, flexShrink: 1, flexBasis: 0 }}
      >
        {first}
      </div>
      <div
        className={`${handleClass}${dragging ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation={direction === "row" ? "vertical" : "horizontal"}
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      <div
        className="splitter-pane"
        style={{ flexGrow: 1 - fraction, flexShrink: 1, flexBasis: 0 }}
      >
        {second}
      </div>
    </div>
  );
}
