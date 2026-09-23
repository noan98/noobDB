import { chakra } from "@chakra-ui/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  computeScrollEdges,
  NO_SCROLL_EDGES,
  sameScrollEdges,
  type ScrollEdges,
} from "./scrollEdges";

/**
 * スクロール端影 (#1073) の共有実装。
 *
 * 横 (必要なら縦) にスクロールするコンテナの端に、**その方向にまだ内容が続くときだけ**
 * 控えめなグラデーション影を出す。`TabBar` がオーバーフロー時に矢印を出すのと同じ
 * 「まだ先がある」手がかりを、結果グリッドのような広い面にも与えるためのもの。
 * 判定は純モジュール `scrollEdges.ts` (`computeScrollEdges`)、ここは購読と描画だけ。
 *
 * ## 使い方
 *
 * スクロールコンテナの **直下の先頭の子** として置く。
 *
 * ```tsx
 * <Box ref={scrollRef} overflow="auto">
 *   <ScrollEdgeShadows scrollRef={scrollRef} insetStart={pinnedLeftWidth} />
 *   <table>…</table>
 * </Box>
 * ```
 *
 * ## 実装方針
 *
 * - **レイアウトを誘発しない。** 高さ 0 の `position: sticky` (top/left 0) の帯を
 *   スクロールポートの左上に貼り付け、その中に絶対配置した影を置く。流れの中の
 *   高さは 0 なので後続の内容 (表の列整列・密度・フォント拡大) には一切影響しない。
 *   影の出入りは `opacity` の補間だけで、`width` などは動かさない。
 * - **表示専用。** `pointer-events: none` + `aria-hidden` で、スクロール・クリック・
 *   キーボードナビゲーション・読み上げに一切関与しない。
 * - **スクロールしない帯を尊重する。** ピン留め列のようにビューポート端を占める帯が
 *   あるときは、`insetStart` / `insetEnd` でその内側の境界に影を出す (帯の上には
 *   載せない)。
 * - **再レンダーを最小化する。** scroll は passive で購読し rAF で 1 フレーム 1 回に
 *   まとめ、判定結果 (真偽 4 つ) かビューポート寸法が変わったときだけ state を更新する。
 *   親 (巨大な結果グリッド) は再レンダーされない。
 * - **色は既存トークンのみ。** ピン留め列の境界影と同じ `var(--text)` 由来の
 *   `color-mix` で、ライト/ダーク/各テーマプリセットに自動追従する (新規色は定義しない)。
 * - reduced-motion では `App.css` 末尾のグローバル規則が opacity の transition を止める。
 */
export interface ScrollEdgeShadowsProps {
  /** 影を出す対象のスクロールコンテナ。このコンポーネントはその直下の先頭に置く。 */
  scrollRef: RefObject<HTMLElement | null>;
  /** 影を出す軸。既定は横のみ (`"x"`)。 */
  axis?: "x" | "y" | "both";
  /** ビューポート左端のスクロールしない帯の幅 (px)。左の影はこの右端に出る。 */
  insetStart?: number;
  /** ビューポート右端のスクロールしない帯の幅 (px)。右の影はこの左端に出る。 */
  insetEnd?: number;
}

interface Viewport {
  width: number;
  height: number;
}

const EDGE_FADE = "color-mix(in srgb, var(--text) 16%, transparent)";

const SHADOWS_CSS = {
  position: "sticky",
  top: 0,
  left: 0,
  height: 0,
  // グリッドのスティッキーなヘッダ (2) / 行番号 (3) / 集計フッター (4, 5) より前面。
  zIndex: 6,
  pointerEvents: "none",
  "& > [data-edge]": {
    position: "absolute",
    pointerEvents: "none",
    opacity: 0,
    transition: "opacity var(--dur-fast) var(--ease)",
  },
  "& > [data-edge][data-visible='true']": { opacity: 1 },
  "& > [data-edge='start'], & > [data-edge='end']": { top: 0, width: "var(--space-3)" },
  "& > [data-edge='top'], & > [data-edge='bottom']": { left: 0, height: "var(--space-3)" },
  "& > [data-edge='start']": { background: `linear-gradient(to right, ${EDGE_FADE}, transparent)` },
  "& > [data-edge='end']": { background: `linear-gradient(to left, ${EDGE_FADE}, transparent)` },
  "& > [data-edge='top']": { background: `linear-gradient(to bottom, ${EDGE_FADE}, transparent)` },
  "& > [data-edge='bottom']": { background: `linear-gradient(to top, ${EDGE_FADE}, transparent)` },
} as const;

export function ScrollEdgeShadows({
  scrollRef,
  axis = "x",
  insetStart = 0,
  insetEnd = 0,
}: ScrollEdgeShadowsProps) {
  const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL_EDGES);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  // 購読をやり直さずに最新の inset で判定できるよう ref に置く。
  const insetsRef = useRef({ insetStart, insetEnd });
  insetsRef.current = { insetStart, insetEnd };
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = computeScrollEdges(
        {
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
        },
        insetsRef.current,
      );
      setEdges((prev) => (sameScrollEdges(prev, next) ? prev : next));
      setViewport((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      );
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    measureRef.current = schedule;
    measure();
    el.addEventListener("scroll", schedule, { passive: true });

    // コンテナ自身 (ビューポート寸法) と子 (表の幅 = scrollWidth) の変化を拾う。
    // 子の入れ替え (スケルトン ⇔ 表など) にも追従するよう childList を監視して
    // 観測対象を張り直す。
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(schedule);
      ro = observer;
      const observeAll = () => {
        observer.disconnect();
        observer.observe(el);
        for (const child of Array.from(el.children)) observer.observe(child);
      };
      observeAll();
      if (typeof MutationObserver !== "undefined") {
        mo = new MutationObserver(() => {
          observeAll();
          schedule();
        });
        mo.observe(el, { childList: true });
      }
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
      mo?.disconnect();
      measureRef.current = () => {};
    };
  }, [scrollRef]);

  // inset (ピン留め幅) が変わったら判定し直す。
  useEffect(() => {
    measureRef.current();
  }, [insetStart, insetEnd]);

  const showX = axis !== "y";
  const showY = axis !== "x";
  return (
    <chakra.div className="scroll-edge-shadows" aria-hidden css={SHADOWS_CSS}>
      {showX && (
        <>
          <span
            data-edge="start"
            data-visible={edges.start}
            style={{ left: insetStart, height: viewport.height }}
          />
          <span
            data-edge="end"
            data-visible={edges.end}
            style={{ right: insetEnd, height: viewport.height }}
          />
        </>
      )}
      {showY && (
        <>
          <span data-edge="top" data-visible={edges.top} style={{ top: 0, width: viewport.width }} />
          <span
            data-edge="bottom"
            data-visible={edges.bottom}
            style={{ top: viewport.height, width: viewport.width, transform: "translateY(-100%)" }}
          />
        </>
      )}
    </chakra.div>
  );
}
