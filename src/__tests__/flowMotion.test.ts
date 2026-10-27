import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { staggerTiming } from "../motion";
import {
  FLOW_MORPH_MS,
  FLOW_STAGGER_MAX_INDEX,
  flowEntranceMs,
  rankIndices,
  staggerStyle,
} from "../components/flowMotion";

describe("rankIndices", () => {
  it("同じ中心は同じ深さ、昇順に 0 始まりで振る (入力順は保つ)", () => {
    expect(rankIndices([300, 100, 100.4, 200])).toEqual([2, 0, 0, 1]);
  });
  it("空と単一ノード", () => {
    expect(rankIndices([])).toEqual([]);
    expect(rankIndices([42])).toEqual([0]);
  });
  it("許容差を超えるずれは別の深さ", () => {
    expect(rankIndices([0, 1.5])).toEqual([0, 1]);
  });
  it("深さは上限で頭打ち", () => {
    const centers = Array.from({ length: FLOW_STAGGER_MAX_INDEX + 5 }, (_, i) => i * 100);
    expect(Math.max(...rankIndices(centers))).toBe(FLOW_STAGGER_MAX_INDEX);
  });
});

describe("flowEntranceMs / staggerStyle", () => {
  it("深いほど長く、上限を超えない", () => {
    expect(flowEntranceMs(3)).toBeGreaterThan(flowEntranceMs(0));
    expect(flowEntranceMs(999)).toBe(flowEntranceMs(FLOW_STAGGER_MAX_INDEX));
  });
  it("カスタムプロパティ名", () => {
    expect(staggerStyle(2)).toEqual({ "--stagger-index": 2 });
  });
});

describe("App.css の React Flow モーション (#1861)", () => {
  const css = readFileSync("src/App.css", "utf8").replace(/\r\n/g, "\n");
  it("ドラッグ中は transform の transition を外す", () => {
    expect(css).toMatch(/\.react-flow__node\.flow-node-enter\.dragging\s*\{\s*transition: opacity/);
  });
  it("reduced-motion では入場の遅延も 0 にする", () => {
    expect(css).toMatch(/:root\[data-motion="reduced"\] \.flow-node-enter[^{]*\{\s*animation-delay: 0s/);
  });
  it("CSS トークンが motion.ts の staggerTiming / FLOW_MORPH_MS と一致する", () => {
    const ms = (name: string) => Number(new RegExp(`--${name}: (\\d+)ms`).exec(css)?.[1]);
    expect(ms("stagger-each")).toBe(staggerTiming.each * 1000);
    expect(ms("stagger-delay")).toBe(staggerTiming.delay * 1000);
    expect(ms("dur-med")).toBe(FLOW_MORPH_MS);
  });
});
