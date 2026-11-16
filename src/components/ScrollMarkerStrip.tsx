import { memo, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { TooltipBubble, useDelegatedTooltip } from "./Tooltip";
import {
  buildScrollTicks,
  type ScrollMarkKind,
  type ScrollMarkSnapshot,
  type ScrollTick,
} from "./scrollMarkers";

/** ティック 1 本ぶんの縦の幅 (帯の高さをこれで割った数をバケット数にする)。 */
const TICK_SLOT_PX = 4;
const MIN_BUCKETS = 16;
const MAX_BUCKETS = 400;
const FALLBACK_HEIGHT_PX = 320;

const KIND_LABEL_KEY = {
  error: "editorScrollMarkerError",
  warning: "editorScrollMarkerWarning",
  search: "editorScrollMarkerSearch",
  ok: "editorScrollMarkerOk",
} as const satisfies Record<ScrollMarkKind, string>;

/** ツールチップの本文 (種別 + 本文の 1 行目、行番号、まとまった印の数)。 */
export function scrollTickLabel(
  tick: Pick<ScrollTick, "kind" | "label" | "line" | "count">,
  t: ReturnType<typeof useT>,
): string {
  const head = tick.label ? `${t(KIND_LABEL_KEY[tick.kind])}: ${tick.label}` : t(KIND_LABEL_KEY[tick.kind]);
  const more = tick.count > 1 ? `\n${t("editorScrollMarkerMore", { n: tick.count - 1 })}` : "";
  return `${head}\n${t("editorScrollMarkerLine", { line: tick.line })}${more}`;
}

/**
 * エディタ右端の俯瞰マーカー帯 (#2382)。`scrollMarkers` (ViewPlugin) が用意した要素へ portal で描く。
 * 重なりの判定は純関数 `buildScrollTicks`、ツールチップは共通の `useDelegatedTooltip`。
 */
export const ScrollMarkerStrip = memo(function ScrollMarkerStrip({
  host,
  snapshot,
  onJump,
}: {
  host: HTMLElement | null;
  snapshot: ScrollMarkSnapshot | null;
  onJump: (pos: number) => void;
}) {
  const t = useT();
  const { hovered, bind, hide } = useDelegatedTooltip();
  const [height, setHeight] = useState(FALLBACK_HEIGHT_PX);

  useEffect(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (host.clientHeight > 0) setHeight(host.clientHeight);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);

  const buckets = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, Math.floor(height / TICK_SLOT_PX)));
  const ticks = useMemo(
    () => (snapshot ? buildScrollTicks(snapshot.sources, snapshot.totalLines, buckets) : []),
    [snapshot, buckets],
  );
  // ティックが入れ替わったら、古い位置に浮いたツールチップを閉じる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ticks の変化を契機に閉じるだけ
  useEffect(() => hide(), [ticks, hide]);
  if (!host || !snapshot || snapshot.sources.length === 0) return null;
  const range = snapshot.activeLines;
  const lines = Math.max(1, snapshot.totalLines - 1);
  return createPortal(
    <>
      {range && (
        <div
          className="cm-scroll-marker-active"
          aria-hidden="true"
          style={{
            top: `${(Math.max(0, range.from - 1) / lines) * 100}%`,
            height: `${(Math.max(0, range.to - range.from) / lines) * 100}%`,
          }}
        />
      )}
      {ticks.map((tick) => {
        const label = scrollTickLabel(tick, t);
        return (
          <button
            key={`${tick.line}:${tick.kind}`}
            type="button"
            className={`cm-scroll-marker cm-scroll-marker-${tick.kind}`}
            style={{ ["--tick-pos" as string]: tick.frac }}
            tabIndex={-1}
            aria-label={label.replace(/\n/g, " ")}
            // CodeMirror の選択を奪わない (ボタンの mousedown でエディタが blur しないように)。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onJump(tick.pos)}
            {...bind(label)}
          />
        );
      })}
      {hovered && <TooltipBubble label={hovered.label} anchor={hovered.rect} placement="left" />}
    </>,
    host,
  );
});
