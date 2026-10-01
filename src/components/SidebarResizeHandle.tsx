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
  const handleRef = useRef<HTMLDivElement | null>(null);
  // ドラッグ / キー操作中の「いま見えている」幅 (#1312)。ドラッグ中は React の state
  // (= App 全体の再レンダー) も localStorage も触らず、グリッド親の CSS 変数
  // `--sidebar-width` を直接書き換える。確定 (pointerup / keyup / ダブルクリック) で
  // `onWidthChange` を 1 回だけ呼び、App の state 更新と保存はそこで行う。
  const liveWidthRef = useRef(width);
  const dirtyRef = useRef(false);
  const pendingXRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  if (!dirtyRef.current && !draggingRef.current) liveWidthRef.current = width;

  const applyLive = useCallback((w: number) => {
    liveWidthRef.current = w;
    dirtyRef.current = true;
    const el = handleRef.current;
    el?.parentElement?.style.setProperty("--sidebar-width", `${w}px`);
    el?.setAttribute("aria-valuenow", String(Math.round(w)));
  }, []);

  const commit = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const x = pendingXRef.current;
    pendingXRef.current = null;
    if (x !== null) applyLive(clampSidebarWidth(x));
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onWidthChange(liveWidthRef.current);
  }, [applyLive, onWidthChange]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

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
      // 高リフレッシュレートでもフレームごとに 1 回だけ反映する。
      pendingXRef.current = e.clientX;
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const x = pendingXRef.current;
          pendingXRef.current = null;
          if (x !== null) applyLive(clampSidebarWidth(x));
        });
      }
    },
    [applyLive],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) {
        draggingRef.current = false;
        commit();
      }
      onResizingChange(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [commit, onResizingChange],
  );

  // キー操作も CSS 変数へ直接反映し、確定 (keyup / blur) で state と保存を 1 回だけ行う。
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const next = sidebarWidthForKey(liveWidthRef.current, e.key, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      applyLive(next);
    },
    [applyLive],
  );

  const onDoubleClick = useCallback(() => {
    applyLive(SIDEBAR_DEFAULT_WIDTH);
    commit();
  }, [applyLive, commit]);

  return (
    <Box
      ref={handleRef}
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
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onKeyUp={commit}
      onBlur={commit}
    >
      <Box className="sidebar-resize-grip" aria-hidden>
        <span />
        <span />
        <span />
      </Box>
    </Box>
  );
}
