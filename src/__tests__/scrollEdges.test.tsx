import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import { computeScrollEdges, sameScrollEdges, type ScrollMetrics } from "../components/scrollEdges";
import { ScrollEdgeShadows } from "../components/ScrollEdgeShadows";

/**
 * スクロール端影 (#1073)。判定ロジック (`computeScrollEdges`) の境界と、
 * 共有コンポーネント (`ScrollEdgeShadows`) がスクロールに追従して影を出し入れし、
 * 表示専用 (aria-hidden / pointer-events なし) であることを固定する。
 */
const base: ScrollMetrics = {
  scrollLeft: 0,
  scrollTop: 0,
  scrollWidth: 1000,
  scrollHeight: 300,
  clientWidth: 400,
  clientHeight: 300,
};

describe("computeScrollEdges (#1073)", () => {
  it("はみ出していなければどの端にも影を出さない", () => {
    expect(
      computeScrollEdges({ ...base, scrollWidth: 400, scrollHeight: 300 }),
    ).toEqual({ start: false, end: false, top: false, bottom: false });
  });

  it("左端にいるときは右 (end) のみ", () => {
    expect(computeScrollEdges(base)).toMatchObject({ start: false, end: true });
  });

  it("途中では左右両方", () => {
    expect(computeScrollEdges({ ...base, scrollLeft: 300 })).toMatchObject({ start: true, end: true });
  });

  it("右端に到達したら右の影は消える", () => {
    expect(computeScrollEdges({ ...base, scrollLeft: 600 })).toMatchObject({ start: true, end: false });
  });

  it("threshold 未満の残り (小数スクロール) は到達済みとみなす", () => {
    expect(computeScrollEdges({ ...base, scrollLeft: 599.5 })).toMatchObject({ end: false });
    expect(computeScrollEdges({ ...base, scrollLeft: 0.5 })).toMatchObject({ start: false });
    expect(computeScrollEdges({ ...base, scrollLeft: 598 })).toMatchObject({ end: true });
  });

  it("オーバースクロール (範囲外の scrollLeft) を丸める", () => {
    expect(computeScrollEdges({ ...base, scrollLeft: -20 })).toMatchObject({ start: false, end: true });
    expect(computeScrollEdges({ ...base, scrollLeft: 900 })).toMatchObject({ start: true, end: false });
  });

  it("縦方向も同じ規則で判定する", () => {
    const m = { ...base, scrollHeight: 1000 };
    expect(computeScrollEdges(m)).toMatchObject({ top: false, bottom: true });
    expect(computeScrollEdges({ ...m, scrollTop: 350 })).toMatchObject({ top: true, bottom: true });
    expect(computeScrollEdges({ ...m, scrollTop: 700 })).toMatchObject({ top: true, bottom: false });
  });

  it("ピン留め帯がビューポートを覆い尽くすときは横の影を出さない", () => {
    const m = { ...base, scrollLeft: 300 };
    expect(computeScrollEdges(m, { insetStart: 250, insetEnd: 150 })).toMatchObject({
      start: false,
      end: false,
    });
    expect(computeScrollEdges(m, { insetStart: 200, insetEnd: 100 })).toMatchObject({
      start: true,
      end: true,
    });
    expect(
      computeScrollEdges(m, { insetStart: 200, insetEnd: 100, minVisibleWidth: 100 }),
    ).toMatchObject({ start: false, end: false });
  });

  it("不正な option 値は既定値として扱う", () => {
    expect(
      computeScrollEdges({ ...base, scrollLeft: 300 }, { threshold: Number.NaN, insetStart: -5 }),
    ).toMatchObject({ start: true, end: true });
  });

  it("sameScrollEdges は 4 端すべてを比較する", () => {
    const a = computeScrollEdges(base);
    expect(sameScrollEdges(a, { ...a })).toBe(true);
    expect(sameScrollEdges(a, { ...a, bottom: !a.bottom })).toBe(false);
  });
});

function Harness({ insetStart = 0, insetEnd = 0 }: { insetStart?: number; insetEnd?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="scroller">
      <ScrollEdgeShadows scrollRef={ref} insetStart={insetStart} insetEnd={insetEnd} />
    </div>
  );
}

function setMetrics(el: HTMLElement, m: Partial<ScrollMetrics>) {
  for (const [k, v] of Object.entries(m)) {
    Object.defineProperty(el, k, { configurable: true, writable: true, value: v });
  }
}

describe("ScrollEdgeShadows (#1073)", () => {
  it("表示専用: aria-hidden で、影はスクロール位置に追従して出入りする", async () => {
    const { getByTestId, container } = renderWithProviders(<Harness insetStart={40} insetEnd={30} />);
    const scroller = getByTestId("scroller");
    const root = container.querySelector(".scroll-edge-shadows") as HTMLElement;
    expect(root).toHaveAttribute("aria-hidden", "true");

    const start = root.querySelector('[data-edge="start"]') as HTMLElement;
    const end = root.querySelector('[data-edge="end"]') as HTMLElement;
    // 縦の影は既定 (axis="x") では描かない。
    expect(root.querySelector('[data-edge="top"]')).toBeNull();
    // ピン境界 (inset) の内側に置く。
    expect(start.style.left).toBe("40px");
    expect(end.style.right).toBe("30px");

    setMetrics(scroller, { ...base, scrollLeft: 0 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(end).toHaveAttribute("data-visible", "true"));
    expect(start).toHaveAttribute("data-visible", "false");
    expect(end.style.height).toBe("300px");

    setMetrics(scroller, { scrollLeft: 600 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(end).toHaveAttribute("data-visible", "false"));
    expect(start).toHaveAttribute("data-visible", "true");
  });

  it("inset が変わると再判定する (ピン留めでビューポートが埋まると消える)", async () => {
    const { getByTestId, container, rerender } = renderWithProviders(<Harness />);
    const scroller = getByTestId("scroller");
    setMetrics(scroller, { ...base, scrollLeft: 300 });
    fireEvent.scroll(scroller);
    const start = container.querySelector('[data-edge="start"]') as HTMLElement;
    await waitFor(() => expect(start).toHaveAttribute("data-visible", "true"));
    await act(async () => {
      rerender(<Harness insetStart={300} insetEnd={200} />);
    });
    await waitFor(() => expect(start).toHaveAttribute("data-visible", "false"));
  });
});
