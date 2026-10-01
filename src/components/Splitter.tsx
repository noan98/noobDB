import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box } from "@chakra-ui/react";
import { animate, useReducedMotion } from "motion/react";
import { durations, easings } from "../motion";
import { clamp, fractionBounds as boundsFor, normalizeFraction } from "./paneLayout";

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
  /**
   * true のとき 2 つ目のペインを「中身の高さ (幅) だけ」の帯として扱い、セパレータを
   * 隠して 1 つ目のペインに残りを全部渡す。分割を閉じたり開いたりするたびに
   * Splitter ごと出し入れすると `first` の中身 (エディタや結果グリッド) が別の親へ
   * 移って再マウントされ、開閉が重くなる。このフラグで構造を保ったまま畳む。
   */
  secondCollapsed?: boolean;
}

function readStoredFraction(storageKey: string | undefined, fallback: number): number {
  if (!storageKey) return fallback;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) return normalizeFraction(stored, fallback);
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
  secondCollapsed = false,
}: Props) {
  const [fraction, setFraction] = useState<number>(() =>
    readStoredFraction(storageKey, defaultFraction),
  );
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const firstRef = useRef<HTMLDivElement | null>(null);
  const secondRef = useRef<HTMLDivElement | null>(null);
  const separatorRef = useRef<HTMLDivElement | null>(null);
  // ドラッグ / アニメーション中の「いま見えている」比率 (#1312)。ドラッグ中は React の
  // state を更新せず、この ref と DOM (flex-grow / aria-valuenow) へ直接反映する。
  // state と localStorage は確定時 (pointerup・キー操作・アニメ完了) に 1 回だけ更新する。
  const liveFractionRef = useRef(fraction);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);
  const animationRef = useRef<{ stop: () => void } | null>(null);
  const secondCollapsedRef = useRef(secondCollapsed);
  secondCollapsedRef.current = secondCollapsed;

  // state が確定した (キー操作・復元・確定) ときは live 値も追従させる。
  liveFractionRef.current = dragging || animationRef.current ? liveFractionRef.current : fraction;

  const persist = useCallback(
    (f: number) => {
      if (!storageKey) return;
      try {
        localStorage.setItem(storageKey, f.toFixed(4));
      } catch {
        // ignore
      }
    },
    [storageKey],
  );

  // DOM へ直接比率を反映する (React の再レンダーを伴わない)。
  const applyLive = useCallback((f: number) => {
    liveFractionRef.current = f;
    if (!secondCollapsedRef.current) {
      if (firstRef.current) firstRef.current.style.flexGrow = String(f);
      if (secondRef.current) secondRef.current.style.flexGrow = String(1 - f);
    }
    separatorRef.current?.setAttribute("aria-valuenow", String(Math.round(f * 100)));
  }, []);

  // 確定: state を更新して 1 回だけ保存する。
  const commit = useCallback(
    (f: number) => {
      liveFractionRef.current = f;
      setFraction(f);
      persist(f);
    },
    [persist],
  );

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      animationRef.current?.stop();
    },
    [],
  );

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

  // Min/max fraction the divider may take, leaving at least `minSize` px on each
  // side. Shared by pointer drag and keyboard nudge so the clamp stays identical.
  // Delegates to the pure `fractionBounds` so the rule is unit-tested in one place.
  const fractionBounds = useCallback(
    (total: number) => boundsFor(total, minSize),
    [minSize],
  );

  // ポインタ位置から比率を求める。ドラッグ中は DOM へ直接反映するだけで state は触らない。
  const updateFromPointer = useCallback(
    (clientX: number, clientY: number): number | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const total = direction === "row" ? rect.width : rect.height;
      if (total <= 0) return null;
      const offset = direction === "row" ? clientX - rect.left : clientY - rect.top;
      const { minF, maxF } = fractionBounds(total);
      const f = clamp(offset / total, minF, maxF);
      applyLive(f);
      return f;
    },
    [direction, fractionBounds, applyLive],
  );

  const flushPending = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) updateFromPointer(p.x, p.y);
  }, [updateFromPointer]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // ダブルクリックのアニメーション中につかんだら、その地点で止めて引き継ぐ。
    animationRef.current?.stop();
    animationRef.current = null;
    draggingRef.current = true;
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      // 高リフレッシュレートでもフレームごとに 1 回だけ反映する。
      pendingRef.current = { x: e.clientX, y: e.clientY };
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const p = pendingRef.current;
          pendingRef.current = null;
          if (p) updateFromPointer(p.x, p.y);
        });
      }
    },
    [updateFromPointer],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) {
        draggingRef.current = false;
        flushPending();
        commit(liveFractionRef.current);
      }
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [flushPending, commit],
  );

  const prefersReducedMotion = useReducedMotion();

  const onDoubleClick = useCallback(() => {
    animationRef.current?.stop();
    animationRef.current = null;
    if (prefersReducedMotion) {
      commit(defaultFraction);
      return;
    }
    // アニメーション中は DOM へ直接書き、完了時に 1 回だけ state / 保存を確定する (#1312)。
    const controls = animate(liveFractionRef.current, defaultFraction, {
      duration: durations.slow,
      ease: easings.out,
      onUpdate: (v) => applyLive(v),
      onComplete: () => {
        animationRef.current = null;
        commit(defaultFraction);
      },
    });
    animationRef.current = controls;
  }, [defaultFraction, prefersReducedMotion, applyLive, commit]);

  // Keyboard resize (a11y): arrow keys nudge the divider, Home/End jump to the
  // min/max, Enter resets to the default split. Step respects the same min-size
  // clamp as pointer dragging.
  const nudge = useCallback(
    (delta: number) => {
      const el = containerRef.current;
      const total = el ? (direction === "row" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height) : 0;
      const { minF, maxF } = fractionBounds(total);
      commit(clamp(liveFractionRef.current + delta, minF, maxF));
    },
    [direction, fractionBounds, commit],
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
      } else if (e.key === "Enter") {
        // Reset to the default split. (Backspace is intentionally not used — it
        // can trigger browser "back" navigation on a focused non-input element.)
        e.preventDefault();
        commit(defaultFraction);
      }
    },
    [isRow, nudge, defaultFraction, commit],
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
        ref={firstRef}
        display="flex"
        flexDirection="column"
        overflow="hidden"
        minW={0}
        minH={0}
        style={{ flexGrow: secondCollapsed ? 1 : fraction, flexShrink: 1, flexBasis: 0 }}
      >
        {first}
      </Box>
      {!secondCollapsed && (
      <Box
        ref={separatorRef}
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
            gap: "var(--space-0-75)",
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
            boxShadow: "var(--focus-ring)",
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
      )}
      <Box
        ref={secondRef}
        display="flex"
        flexDirection="column"
        overflow="hidden"
        minW={0}
        minH={0}
        style={
          secondCollapsed
            ? { flexGrow: 0, flexShrink: 0, flexBasis: "auto" }
            : { flexGrow: 1 - fraction, flexShrink: 1, flexBasis: 0 }
        }
      >
        {second}
      </Box>
    </Box>
  );
}
