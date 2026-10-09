import { beforeEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import type { QueryResult } from "../../api/tauri";

// クライアント側ソート適用時の <tbody> クロスフェード (#1416) を実ブラウザで検証する。
// 「<tbody> に opacity アニメーションが 1 回だけ付く」「行 (tr) には付かない」
// 「reduced-motion では再生しない」「tbody を作り直さない」を確かめる。

const RESULT: QueryResult = {
  columns: [{ name: "n", type_name: "INT" }],
  rows: Array.from({ length: 8 }, (_, r) => [8 - r]),
  rows_affected: 0,
  elapsed_ms: 1,
};

function sortButton(): HTMLElement {
  return document.querySelector("thead .th-sort-button") as HTMLElement;
}

function mount(reduced: "never" | "always") {
  return renderInBrowser(
    <MotionConfig reducedMotion={reduced}>
      <div style={{ width: 600, height: 300, display: "flex", flexDirection: "column" }}>
        <ResultGrid result={RESULT} onChangeView={() => {}} />
      </div>
    </MotionConfig>,
  );
}

describe("行のクロスフェード (#1416, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("ソートで <tbody> にだけ opacity アニメーションが 1 回付き、DOM は作り直されない", async () => {
    const screen = await mount("never");
    await expect.element(screen.getByText("8", { exact: true }).first()).toBeVisible();
    const tbody = document.querySelector("tbody") as HTMLElement;
    expect(tbody.getAnimations().length).toBe(0);

    sortButton().click();
    await expect.poll(() => tbody.getAnimations().length).toBe(1);
    const anim = tbody.getAnimations()[0] as CSSAnimation | Animation;
    const frames = (anim.effect as KeyframeEffect).getKeyframes();
    expect(frames.map((f) => f.opacity)).toEqual(["0.35", "1"]);
    // 行単位のアニメーションは付かない。
    expect(document.querySelector("tbody tr[role='row']")?.getAnimations().length).toBe(0);
    expect(document.querySelector("tbody")).toBe(tbody);

    anim.finish();
    expect(tbody.getAnimations().length).toBe(0);
    expect(tbody.style.opacity).toBe("");
  });

  it("reduced-motion では再生しない (ソート自体は行う)", async () => {
    const screen = await mount("always");
    await expect.element(screen.getByText("8", { exact: true }).first()).toBeVisible();
    const tbody = document.querySelector("tbody") as HTMLElement;
    sortButton().click();
    await expect
      .poll(() => document.querySelector("thead th[data-col-id]")?.getAttribute("aria-sort"))
      .not.toBe("none");
    expect(tbody.getAnimations().length).toBe(0);
  });
});
