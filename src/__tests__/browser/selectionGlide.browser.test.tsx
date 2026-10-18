import { beforeEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import type { QueryResult, TableColumnInfo } from "../../api/tauri";

// 滑って追従する選択枠 (#1578) を実ブラウザで検証する。枠がセルの矩形に重なり、
// 移動で Animation が付き、reduced-motion では付かないこと、元のセル単位のリングが
// 消えること、スクロールしても枠がセルに付いてくることを確かめる。

const RESULT: QueryResult = {
  columns: [
    { name: "a", type_name: "INT" },
    { name: "b", type_name: "INT" },
    { name: "c", type_name: "INT" },
  ],
  rows: Array.from({ length: 200 }, (_, r) => [r, r * 2, r * 3]),
  rows_affected: 0,
  elapsed_ms: 1,
};

const TABLE_COLUMNS = RESULT.columns.map((c, i) => ({
  name: c.name,
  type_name: c.type_name,
  nullable: i !== 0,
  key: i === 0 ? "PRI" : "",
  default_value: null,
  extra: "",
  comment: null,
  referenced_table: null,
  referenced_column: null,
})) as unknown as TableColumnInfo[];

function Host({ reduced, editable }: { reduced: "never" | "always"; editable?: boolean }) {
  return (
    <MotionConfig reducedMotion={reduced}>
      <div style={{ width: 700, height: 400, display: "flex", flexDirection: "column" }}>
        {editable ? (
          <ResultGrid result={RESULT} editable tableColumns={TABLE_COLUMNS} onSetCellEdit={() => {}} />
        ) : (
          <ResultGrid result={RESULT} />
        )}
      </div>
    </MotionConfig>
  );
}

const td = (r: number, c: number) =>
  document.querySelector(`td[data-r="${r}"][data-c="${c}"]`) as HTMLElement;
const frame = (kind: "active" | "selection") => document.querySelector(`.grid-glide-${kind}`) as HTMLElement;
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const near = (a: number, b: number) => Math.abs(a - b) < 1.5;

function expectOver(f: HTMLElement, el: HTMLElement) {
  const a = f.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  expect(near(a.left, b.left)).toBe(true);
  expect(near(a.top, b.top)).toBe(true);
  expect(near(a.width, b.width)).toBe(true);
  expect(near(a.height, b.height)).toBe(true);
}

describe("滑って追従する選択枠 (#1578, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("アクティブセルの枠がセルに重なり、矢印移動で滑らせ、元のセル単位のリングは消える", async () => {
    await renderInBrowser(<Host reduced="never" />);
    await expect.poll(() => td(0, 0)).not.toBeNull();
    td(0, 0).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    expectOver(frame("active"), td(0, 0));
    expect(getComputedStyle(td(0, 0)).boxShadow).toBe("none");

    key(td(0, 0), "ArrowDown");
    await expect.poll(() => td(1, 0).classList.contains("is-active-cell")).toBe(true);
    // 確定時に 1 回だけ、枠の位置/大きさを動かす Animation が付く。
    expect(frame("active").getAnimations().length).toBe(1);
    for (const a of frame("active").getAnimations()) a.finish();
    expectOver(frame("active"), td(1, 0));
  });

  it("reduced-motion では滑らせず即座に置く", async () => {
    await renderInBrowser(<Host reduced="always" />);
    await expect.poll(() => td(0, 0)).not.toBeNull();
    td(0, 0).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    key(td(0, 0), "ArrowDown");
    await expect.poll(() => td(1, 0).classList.contains("is-active-cell")).toBe(true);
    expect(frame("active").getAnimations().length).toBe(0);
    expectOver(frame("active"), td(1, 0));
  });

  it("Shift+矢印の範囲選択で選択枠が矩形全体を覆い、解除で隠れる", async () => {
    await renderInBrowser(<Host reduced="never" />);
    await expect.poll(() => td(0, 0)).not.toBeNull();
    td(0, 0).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    expect(frame("selection").hidden).toBe(true);
    key(td(0, 0), "ArrowRight", { shiftKey: true });
    await expect.poll(() => td(0, 1).classList.contains("is-active-cell")).toBe(true);
    key(td(0, 1), "ArrowDown", { shiftKey: true });
    await expect.poll(() => frame("selection").hidden).toBe(false);
    for (const a of frame("selection").getAnimations()) a.finish();
    const f = frame("selection").getBoundingClientRect();
    const tl = td(0, 0).getBoundingClientRect();
    const br = td(1, 1).getBoundingClientRect();
    expect(near(f.left, tl.left) && near(f.top, tl.top)).toBe(true);
    expect(near(f.right, br.right) && near(f.bottom, br.bottom)).toBe(true);
    // 範囲内のセルは単独のリングを持たない (枠が矩形全体を囲う)。
    expect(getComputedStyle(td(0, 0)).boxShadow).toBe("none");
    key(td(1, 1), "Escape");
    await expect.poll(() => frame("selection").hidden).toBe(true);
  });

  it("スクロールしても枠はセルに付いてくる", async () => {
    await renderInBrowser(<Host reduced="always" />);
    await expect.poll(() => td(2, 1)).not.toBeNull();
    td(2, 1).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    const scroller = frame("active").parentElement as HTMLElement;
    scroller.scrollTop = 20;
    await new Promise((r) => setTimeout(r, 50));
    expectOver(frame("active"), td(2, 1));
  });

  it("アクティブセルが描画窓の外へ出たら枠は隠れ、戻ると再び重なる", async () => {
    await renderInBrowser(<Host reduced="always" />);
    await expect.poll(() => td(0, 0)).not.toBeNull();
    td(0, 0).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    const scroller = frame("active").parentElement as HTMLElement;
    scroller.scrollTop = 4000;
    await expect.poll(() => document.querySelector('td[data-r="0"][data-c="0"]')).toBeNull();
    await expect.poll(() => frame("active").hidden).toBe(true);
    scroller.scrollTop = 0;
    await expect.poll(() => frame("active").hidden).toBe(false);
    expectOver(frame("active"), td(0, 0));
  });

  it("マーキーでビューポート下端へドラッグし続けるとオートスクロールして選択が伸びる", async () => {
    await renderInBrowser(<Host reduced="always" />);
    await expect.poll(() => td(0, 0)).not.toBeNull();
    const scroller = frame("active").parentElement as HTMLElement;
    const start = td(0, 0).getBoundingClientRect();
    const mouse = (type: string, target: EventTarget, x: number, y: number, buttons: number) =>
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y }),
      );
    mouse("mousedown", td(0, 0), start.left + 5, start.top + 5, 1);
    td(0, 0).focus();
    const second = td(1, 1).getBoundingClientRect();
    mouse("mousemove", td(1, 1), second.left + 5, second.top + 5, 1);
    await expect.poll(() => document.querySelectorAll("td.is-selected-cell").length).toBe(4);
    // ポインタをスクロール領域の下端の外へ置いたまま待つ。
    const r = scroller.getBoundingClientRect();
    mouse("mousemove", document.body, second.left + 5, r.bottom + 40, 1);
    await expect.poll(() => scroller.scrollTop, { timeout: 3000 }).toBeGreaterThan(100);
    const before = document.querySelectorAll("td.is-selected-cell").length;
    expect(before).toBeGreaterThan(4);
    mouse("mouseup", document.body, second.left + 5, r.bottom + 40, 0);
    const top = scroller.scrollTop;
    await new Promise((res) => setTimeout(res, 120));
    expect(scroller.scrollTop).toBe(top);
    // 基点 (アクティブセル) は動かない。
    expect(document.querySelector("td.is-active-cell")?.getAttribute("data-r")).toBe("0");
  });

  it("編集可能なグリッドで矢印移動しても、移動先のセル単独のリングは出ない (二重表示しない)", async () => {
    await renderInBrowser(<Host reduced="always" editable />);
    await expect.poll(() => td(0, 1)).not.toBeNull();
    td(0, 1).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    key(td(0, 1), "ArrowDown");
    await expect.poll(() => td(1, 1).classList.contains("is-active-cell")).toBe(true);
    expect(td(1, 1).classList.contains("is-editable-cell")).toBe(true);
    expect(getComputedStyle(td(1, 1)).boxShadow).toBe("none");
    expectOver(frame("active"), td(1, 1));
  });

  it("列並べ替えの FLIP 再生中に計測しても、枠は並べ替え後のセルに重なる", async () => {
    await renderInBrowser(<Host reduced="never" />);
    await expect.poll(() => td(0, 0)).not.toBeNull();
    td(0, 0).focus();
    await expect.poll(() => frame("active").hidden).toBe(false);
    for (const a of frame("active").getAnimations()) a.finish();
    const grip = document.querySelector("thead .th-drag-grip") as HTMLElement;
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await expect
      .poll(() => document.querySelector("thead th[data-col-id]")?.getAttribute("data-col-id"))
      .not.toBe("0");
    await expect.poll(() => td(0, 0).getBoundingClientRect().left).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 30));
    const f = frame("active");
    // 再生を終わらせた後、枠とセルが (getBoundingClientRect で) 重なる。
    for (const a of document.getAnimations()) a.finish();
    expectOver(f, td(0, 0));
  });
});
