import { beforeEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { PivotView } from "../../components/PivotView";
import type { QueryResult } from "../../api/tauri";

// ピボット再集計の <tbody> クロスフェード (#1862) を実ブラウザで検証する。

const RESULT: QueryResult = {
  columns: [
    { name: "region", type_name: "VARCHAR" },
    { name: "amount", type_name: "INT" },
  ],
  rows: [
    ["east", 10],
    ["west", 20],
    ["east", 5],
  ],
  rows_affected: 0,
  elapsed_ms: 1,
};

function mount(reduced: "never" | "always") {
  return renderInBrowser(
    <MotionConfig reducedMotion={reduced}>
      <div style={{ width: 800, height: 400, display: "flex", flexDirection: "column" }}>
        <PivotView result={RESULT} driver="mysql" sourceSql="SELECT 1" onChangeView={() => {}} />
      </div>
    </MotionConfig>,
  );
}

function toggleHeatmap() {
  (document.querySelector("input[type='checkbox']") as HTMLElement).click();
}

describe("ピボットの再集計クロスフェード (#1862, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("設定の切替で <tbody> にだけ opacity アニメーションが付き、DOM は作り直されない", async () => {
    const screen = await mount("never");
    await expect.element(screen.getByText("east", { exact: true })).toBeVisible();
    const tbody = document.querySelector("tbody") as HTMLElement;
    expect(tbody.getAnimations().length).toBe(0);
    toggleHeatmap();
    await expect.poll(() => tbody.getAnimations().length).toBe(1);
    const frames = ((tbody.getAnimations()[0] as Animation).effect as KeyframeEffect).getKeyframes();
    expect(frames.map((f) => f.opacity)).toEqual(["0.35", "1"]);
    expect(document.querySelector("tbody")).toBe(tbody);
  });

  it("reduced-motion では再生しない", async () => {
    const screen = await mount("always");
    await expect.element(screen.getByText("east", { exact: true })).toBeVisible();
    const tbody = document.querySelector("tbody") as HTMLElement;
    toggleHeatmap();
    // 再生されるならクリック直後 (同期) のコミットで始まる。待たずに確認する。
    expect(tbody.getAnimations().length).toBe(0);
  });
});
