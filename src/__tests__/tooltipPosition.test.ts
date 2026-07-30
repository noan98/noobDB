import { describe, expect, it } from "vitest";

import { computeTooltipPosition, type TooltipRect } from "../components/tooltipPosition";

// 共有 Tooltip プリミティブ (#814) の測定→クランプ→フリップ純ロジック。
// `ColumnTooltip` (ConnectionList.tsx) が手書きしていたのと同じ形の計算を
// 一本化したもので、ここでの境界固定がそのままどちらの利用側にも効く。
const viewport = { width: 1000, height: 800 };

function rect(partial: Partial<TooltipRect> & { top: number; left: number; width: number; height: number }): TooltipRect {
  const { top, left, width, height } = partial;
  return { top, left, width, height, right: left + width, bottom: top + height };
}

describe("computeTooltipPosition", () => {
  it("top: アンカー中央上に、上寄せで配置する", () => {
    const anchor = rect({ top: 300, left: 400, width: 100, height: 20 });
    const size = { width: 120, height: 40 };
    expect(computeTooltipPosition(anchor, size, "top", 8, viewport)).toEqual({
      left: 400 + 50 - 60, // アンカー中央 - バブル幅/2
      top: 300 - 8 - 40,
    });
  });

  it("top: 上に収まらないときは下へフリップする", () => {
    const anchor = rect({ top: 10, left: 400, width: 100, height: 20 });
    const size = { width: 120, height: 40 };
    const pos = computeTooltipPosition(anchor, size, "top", 8, viewport);
    expect(pos.top).toBe(anchor.bottom + 8);
  });

  it("bottom: アンカー中央下に配置し、収まらなければ上へフリップする", () => {
    const anchor = rect({ top: 300, left: 400, width: 100, height: 20 });
    const size = { width: 120, height: 40 };
    expect(computeTooltipPosition(anchor, size, "bottom", 8, viewport).top).toBe(anchor.bottom + 8);

    const nearBottom = rect({ top: 780, left: 400, width: 100, height: 20 });
    expect(computeTooltipPosition(nearBottom, size, "bottom", 8, viewport).top).toBe(nearBottom.top - 8 - 40);
  });

  it("right: 中央揃え (既定) と start 揃え (ColumnTooltip 相当) を区別する", () => {
    const anchor = rect({ top: 200, left: 500, width: 40, height: 60 });
    const size = { width: 200, height: 100 };
    const centered = computeTooltipPosition(anchor, size, "right", 8, viewport, "center");
    expect(centered.top).toBe(anchor.top + anchor.height / 2 - size.height / 2);

    const started = computeTooltipPosition(anchor, size, "right", 8, viewport, "start");
    expect(started.top).toBe(anchor.top);
  });

  it("right: 右に収まらないときは左へフリップする (ColumnTooltip のフリップと同型)", () => {
    const anchor = rect({ top: 100, left: 900, width: 40, height: 20 });
    const size = { width: 200, height: 60 };
    const pos = computeTooltipPosition(anchor, size, "right", 8, viewport, "start");
    // 右に出すと 900+40+8+200=1148 > 1000 なので左側 (anchor.left - margin - width) にフリップ
    expect(pos.left).toBe(anchor.left - 8 - size.width);
  });

  it("left: 左に収まらないときは右へフリップする", () => {
    const anchor = rect({ top: 100, left: 20, width: 40, height: 20 });
    const size = { width: 200, height: 60 };
    const pos = computeTooltipPosition(anchor, size, "left", 8, viewport);
    expect(pos.left).toBe(anchor.right + 8);
  });

  it("どの方向でもビューポートの外にはみ出さないよう最終クランプする", () => {
    const anchor = rect({ top: 5, left: 5, width: 10, height: 10 });
    const size = { width: 500, height: 500 };
    const pos = computeTooltipPosition(anchor, size, "top", 8, viewport);
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left).toBeLessThanOrEqual(viewport.width - size.width - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.top).toBeLessThanOrEqual(viewport.height - size.height - 8);
  });

  it("バブルがビューポートより大きい退化ケースでもクランプが破綻しない", () => {
    const anchor = rect({ top: 100, left: 100, width: 20, height: 20 });
    const size = { width: 2000, height: 2000 };
    const pos = computeTooltipPosition(anchor, size, "top", 8, viewport);
    // min > max になる退化ケース。clamp 内の Math.max(min, max) 保護で min 側優先。
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(8);
  });
});
