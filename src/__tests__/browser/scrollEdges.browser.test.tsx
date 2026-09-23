import { describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import type { QueryResult } from "../../api/tauri";

// スクロール端影 (#1073) を実ブラウザで検証する。jsdom ではレイアウト (sticky /
// スクロール寸法) が計算されないため、「影がスクロールポートに貼り付いたまま動かない」
// 「表の流れを押し下げない」「ピン境界 (行番号列の右端) に出る」ことはここで確かめる。

const COLS = 40;
const WIDE: QueryResult = {
  columns: Array.from({ length: COLS }, (_, i) => ({ name: `col_${i}`, type_name: "VARCHAR" })),
  rows: Array.from({ length: 30 }, (_, r) => Array.from({ length: COLS }, (_, c) => `r${r}c${c}`)),
  rows_affected: 0,
  elapsed_ms: 1,
};

async function nextFrames() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

describe("スクロール端影 (#1073, 実ブラウザ)", () => {
  it("スクロール可能な方向にだけ出て、端に到達すると消える", async () => {
    const screen = await renderInBrowser(
      <div style={{ width: 800, height: 400, display: "flex", flexDirection: "column" }}>
        <ResultGrid result={WIDE} onChangeView={() => {}} />
      </div>,
    );
    await expect.element(screen.getByText("r0c0")).toBeVisible();
    const root = document.querySelector(".scroll-edge-shadows") as HTMLElement;
    expect(root).not.toBeNull();
    const scroller = root.parentElement as HTMLElement;
    const start = root.querySelector('[data-edge="start"]') as HTMLElement;
    const end = root.querySelector('[data-edge="end"]') as HTMLElement;
    const table = scroller.querySelector("table") as HTMLElement;

    // 高さ 0 の帯なので表の位置を押し下げない。
    expect(root.getBoundingClientRect().height).toBe(0);

    await expect.poll(() => end.dataset.visible).toBe("true");
    expect(start.dataset.visible).toBe("false");

    // 右の影はスクロールポートの右端に接する。左の影は行番号列 (sticky) の右端。
    const sRect = scroller.getBoundingClientRect();
    const rowIndex = scroller.querySelector("thead th.row-index") as HTMLElement;
    expect(Math.round(end.getBoundingClientRect().right)).toBe(
      Math.round(sRect.left + scroller.clientWidth),
    );
    expect(Math.round(start.getBoundingClientRect().left)).toBe(
      Math.round(rowIndex.getBoundingClientRect().right),
    );
    expect(Math.round(end.getBoundingClientRect().height)).toBe(scroller.clientHeight);

    // 途中までスクロール: 両側に出て、影はスクロールポートに貼り付いたまま。
    scroller.scrollLeft = 500;
    scroller.scrollTop = 200;
    await nextFrames();
    await expect.poll(() => start.dataset.visible).toBe("true");
    expect(end.dataset.visible).toBe("true");
    expect(Math.round(end.getBoundingClientRect().right)).toBe(
      Math.round(sRect.left + scroller.clientWidth),
    );
    expect(Math.round(end.getBoundingClientRect().top)).toBe(Math.round(sRect.top));

    // 右端まで到達: 右の影は消える。
    scroller.scrollLeft = scroller.scrollWidth;
    await nextFrames();
    await expect.poll(() => end.dataset.visible).toBe("false");
    expect(start.dataset.visible).toBe("true");
    // 影は操作を奪わない。
    expect(getComputedStyle(end).pointerEvents).toBe("none");
    // 表の横幅 (列整列) は影の有無で変わらない。
    expect(table.getBoundingClientRect().width).toBeGreaterThan(scroller.clientWidth);
  });
});
