import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { ExplainGraphView } from "../../components/ExplainGraphView";
import type { PlanNode } from "../../components/explainPlan";

// EXPLAIN グラフの凡例とノード種別アイコン (#2017) を実ブラウザで検証する。

const ROOT: PlanNode = {
  id: "r",
  kind: "Sort",
  label: "Sort",
  cost: 200,
  attrs: [],
  children: [
    { id: "r/0", kind: "Seq Scan", label: "Seq Scan on users", cost: 150, attrs: [], children: [] },
    {
      id: "r/1",
      kind: "Index Scan",
      label: "Index Scan using users_pkey",
      cost: 10,
      attrs: [],
      children: [],
    },
  ],
};

const killStyle = () => document.querySelector("style[data-test-disable-animations]") as HTMLStyleElement;

function Host() {
  return (
    <div style={{ width: 900, height: 500 }}>
      <ExplainGraphView root={ROOT} maxCost={200} selectedId={null} onSelect={() => {}} />
    </div>
  );
}

describe("EXPLAIN グラフの凡例 (#2017, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-motion");
    // 共通セットアップのアニメ無効化 CSS を外し、実際の duration を検証する
    (killStyle().sheet as CSSStyleSheet).disabled = true;
  });
  afterEach(() => {
    (killStyle().sheet as CSSStyleSheet).disabled = false;
    document.documentElement.removeAttribute("data-motion");
  });

  it("凡例とノード頭のアイコンが表示され、種別一覧は開閉できる", async () => {
    await renderInBrowser(<Host />);
    await expect.poll(() => document.querySelector('[data-testid="explain-legend"]')).not.toBeNull();
    const legend = document.querySelector('[data-testid="explain-legend"]') as HTMLElement;
    expect(legend.querySelector(".explain-legend-fill")).not.toBeNull();
    await expect.poll(() => document.querySelectorAll('[role="button"][aria-label] svg').length).toBe(3);
    const toggle = legend.querySelector("button") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const before = legend.querySelectorAll("svg").length;
    toggle.click();
    await expect.poll(() => legend.querySelectorAll("svg").length).toBeGreaterThan(before);
    expect(legend.getBoundingClientRect().width).toBeLessThan(400);
  });

  it("通常時は勾配バーに入場アニメが付き、reduced-motion では即時になる", async () => {
    document.documentElement.setAttribute("data-motion", "full");
    const full = await renderInBrowser(<Host />);
    await expect.poll(() => document.querySelector(".explain-legend-fill")).not.toBeNull();
    const bar = document.querySelector(".explain-legend-fill") as HTMLElement;
    expect(getComputedStyle(bar).animationName).toBe("explain-legend-fill");
    expect(Number.parseFloat(getComputedStyle(bar).animationDuration)).toBeGreaterThan(0.1);
    await full.unmount();

    document.documentElement.setAttribute("data-motion", "reduced");
    await renderInBrowser(<Host />);
    await expect.poll(() => document.querySelector(".explain-legend-fill")).not.toBeNull();
    const bar2 = document.querySelector(".explain-legend-fill") as HTMLElement;
    expect(Number.parseFloat(getComputedStyle(bar2).animationDuration)).toBeLessThan(0.001);
  });
});
