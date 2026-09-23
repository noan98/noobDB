import { useCallback, useEffect, useRef } from "react";
import { Box } from "@chakra-ui/react";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarWidthForKey,
} from "./sidebarLayout";

/**
 * サイドバー右端の幅変更ハンドル (#1112)。
 *
 * 以前は `App.tsx` に直書きされたポインタ専用の区切りで、キーボードでは動かせず
 * 読み上げ名も「サイドバーを折りたたむ」だった。ワークスペース内の区切り
 * (`Splitter`) と操作体系・見た目を揃える:
 *
 * - ポインタのドラッグ / ダブルクリックで既定幅に戻す (従来どおり)
 * - フォーカスして ← / → (Shift で大きく)・Home / End・Enter (既定幅)
 * - `role="separator"` + `aria-valuenow/min/max` (px) で現在幅を支援技術へ伝える
 * - ホバー / ドラッグ / フォーカスでアクセント色の線とグリップを出す
 *
 * キー → 幅の対応とクランプは `sidebarLayout.ts` (純ロジック)。
 */
export function SidebarResizeHandle({
  width,
  onWidthChange,
  resizing,
  onResizingChange,
  ariaLabel,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  /** ドラッグ中か。親はこれでグリッドのトランジションを止める。 */
  resizing: boolean;
  onResizingChange: (resizing: boolean) => void;
  ariaLabel: string;
}) {
  const draggingRef = useRef(false);

  // ドラッグ中はカーソルを固定し、細いハンドルから外れてもちらつかないようにする。
  useEffect(() => {
    if (!resizing) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [resizing]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      onResizingChange(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [onResizingChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      onWidthChange(clampSidebarWidth(e.clientX));
    },
    [onWidthChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      onResizingChange(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [onResizingChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next = sidebarWidthForKey(width, e.key, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      onWidthChange(next);
    },
    [width, onWidthChange],
  );

  return (
    <Box
      position="absolute"
      top={0}
      bottom={0}
      left="var(--sidebar-width, 300px)"
      width="9px"
      transform="translateX(-5px)"
      cursor="ew-resize"
      zIndex={45}
      touchAction="none"
      userSelect="none"
      display="flex"
      alignItems="center"
      justifyContent="center"
      data-dragging={resizing ? "true" : undefined}
      css={{
        "&::after": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "5px",
          width: "1px",
          background: "transparent",
          transition:
            "background var(--dur-fast, 0.12s) var(--ease, ease), width var(--dur-fast, 0.12s) var(--ease, ease)",
        },
        "&:hover::after, &[data-dragging='true']::after, &:focus-visible::after": {
          background: "var(--accent)",
          width: "2px",
        },
        // `Splitter` と同じグリップ (ドット)。ホバー / ドラッグ / フォーカスで出す。
        "& .sidebar-resize-grip": {
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-0-75)",
          opacity: 0,
          transition: "opacity var(--dur-fast) var(--ease)",
        },
        "&:hover .sidebar-resize-grip, &[data-dragging='true'] .sidebar-resize-grip, &:focus-visible .sidebar-resize-grip":
          { opacity: 0.9 },
        "& .sidebar-resize-grip > span": {
          width: "3px",
          height: "3px",
          borderRadius: "50%",
          background: "var(--accent)",
        },
        "&:focus-visible": { outline: "none" },
      }}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
    >
      <Box className="sidebar-resize-grip" aria-hidden>
        <span />
        <span />
        <span />
      </Box>
    </Box>
  );
}
