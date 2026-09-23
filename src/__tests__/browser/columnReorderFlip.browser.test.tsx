import { beforeEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import type { QueryResult } from "../../api/tauri";

// 列ドラッグ並べ替えの FLIP (#1021) を実ブラウザで検証する。jsdom には
// レイアウトも Web Animations API も無いため、「確定時に動いた列だけが元の位置から
// 滑り、終了後に transform を残さない」「reduced-motion では再生しない」はここで確かめる。

const RESULT: QueryResult = {
  columns: Array.from({ length: 6 }, (_, i) => ({ name: `col_${i}`, type_name: "VARCHAR" })),
  rows: Array.from({ length: 5 }, (_, r) => Array.from({ length: 6 }, (_, c) => `r${r}c${c}`)),
  rows_affected: 0,
  elapsed_ms: 1,
};

function headerCell(id: string): HTMLElement {
  return document.querySelector(`thead th[data-col-id="${id}"]`) as HTMLElement;
}

function bodyCell(text: string): HTMLElement {
  return Array.from(document.querySelectorAll("tbody td")).find(
    (td) => td.textContent === text,
  ) as HTMLElement;
}

/** col_<from> のグリップを col_<to> のヘッダへドラッグ & ドロップする。 */
function dragColumn(from: string, to: string) {
  const grip = headerCell(from).querySelector(".th-drag-grip") as HTMLElement;
  const dt = new DataTransfer();
  grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  return async () => {
    const target = headerCell(to);
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  };
}

async function tick() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

function headerOrder(): string[] {
  return Array.from(document.querySelectorAll("thead th[data-col-id]")).map(
    (th) => (th as HTMLElement).dataset.colId ?? "",
  );
}

describe("列ドラッグ並べ替えの FLIP (#1021, 実ブラウザ)", () => {
  // 列順は localStorage に永続化されるので、テスト間で持ち越さない。
  beforeEach(() => {
    localStorage.clear();
  });

  it("確定時に動いた列だけがスライドし、終了後に transform を残さない", async () => {
    const screen = await renderInBrowser(
      <MotionConfig reducedMotion="never">
        <div style={{ width: 1000, height: 400, display: "flex", flexDirection: "column" }}>
          <ResultGrid result={RESULT} onChangeView={() => {}} />
        </div>
      </MotionConfig>,
    );
    await expect.element(screen.getByText("r0c0")).toBeVisible();
    const startLeft = headerCell("0").getBoundingClientRect().left;

    const drop = dragColumn("0", "3");
    await tick();
    await drop();
    await expect.poll(headerOrder).toEqual(["1", "2", "0", "3", "4", "5"]);

    // 動いた列 (0, 1, 2) のヘッダ・本体セルにアニメーションが付き、動かない列には付かない。
    for (const id of ["0", "1", "2"]) expect(headerCell(id).getAnimations().length).toBe(1);
    for (const id of ["3", "4", "5"]) expect(headerCell(id).getAnimations().length).toBe(0);
    expect(bodyCell("r0c0").getAnimations().length).toBe(1);
    expect(bodyCell("r0c4").getAnimations().length).toBe(0);

    // 再生開始時点では、移動した列は元の位置付近に見えている (瞬間移動しない)。
    const anim = headerCell("0").getAnimations()[0];
    anim.pause();
    anim.currentTime = 0;
    expect(Math.round(headerCell("0").getBoundingClientRect().left)).toBe(Math.round(startLeft));

    // 終了後は inline transform を残さず定位置に収まる。
    anim.finish();
    expect(headerCell("0").style.transform).toBe("");
    expect(headerCell("0").getBoundingClientRect().left).toBeGreaterThan(startLeft);
  });

  it("reduced-motion では再生しない (並べ替え自体は行う)", async () => {
    const screen = await renderInBrowser(
      <MotionConfig reducedMotion="always">
        <div style={{ width: 1000, height: 400, display: "flex", flexDirection: "column" }}>
          <ResultGrid result={RESULT} onChangeView={() => {}} />
        </div>
      </MotionConfig>,
    );
    await expect.element(screen.getByText("r0c0")).toBeVisible();
    const drop = dragColumn("5", "1");
    await tick();
    await drop();
    await expect.poll(headerOrder).toEqual(["0", "5", "1", "2", "3", "4"]);
    for (const id of ["1", "2", "3", "4", "5"]) {
      expect(headerCell(id).getAnimations().length).toBe(0);
    }
  });
});
