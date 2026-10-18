import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";

// クリック&ドラッグのマーキー選択 (#1578)。既存のセル内テキスト選択・Shift+クリック・
// 入力欄 (FK ジャンプ / 編集) ・右クリックと衝突しないことを固定する。

const RESULT: QueryResult = {
  columns: [
    { name: "a", type_name: "INT" },
    { name: "b", type_name: "INT" },
    { name: "c", type_name: "INT" },
  ],
  rows: [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ],
  rows_affected: 0,
  elapsed_ms: 1,
};

const cell = (c: HTMLElement, r: number, col: number) =>
  c.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${col}"]`) as HTMLElement;
const selected = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("td.is-selected-cell")).map(
    (el) => `${el.getAttribute("data-r")}:${el.getAttribute("data-c")}`,
  );

describe("結果グリッドのマーキー選択 (#1578)", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
  });

  it("別セルへドラッグすると基点からの矩形が選択され、離すと確定する", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const start = cell(container, 0, 0);
    fireEvent.mouseDown(start, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.focus(start);
    fireEvent.mouseMove(cell(container, 1, 1), { buttons: 1, clientX: 60, clientY: 40 });
    expect(selected(container).sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(container.querySelector("[data-marquee='on']")).not.toBeNull();
    // さらに別セルへ → 矩形が追従する。
    fireEvent.mouseMove(cell(container, 2, 2), { buttons: 1, clientX: 120, clientY: 70 });
    expect(selected(container)).toHaveLength(9);
    fireEvent.mouseUp(document.body);
    expect(container.querySelector("[data-marquee='on']")).toBeNull();
    // 離した後のマウス移動では選択が変わらない。
    fireEvent.mouseMove(cell(container, 0, 0), { buttons: 0, clientX: 10, clientY: 10 });
    expect(selected(container)).toHaveLength(9);
  });

  it("基点セルへ戻すと選択は解除される", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    fireEvent.mouseDown(cell(container, 1, 1), { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(cell(container, 2, 2), { buttons: 1, clientX: 100, clientY: 90 });
    expect(selected(container).length).toBeGreaterThan(1);
    fireEvent.mouseMove(cell(container, 1, 1), { buttons: 1, clientX: 52, clientY: 52 });
    expect(selected(container)).toHaveLength(0);
    fireEvent.mouseUp(document.body);
  });

  it("同じセルの中でのドラッグ (セル内テキスト選択) はマーキーにしない", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const start = cell(container, 0, 0);
    fireEvent.mouseDown(start, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(start, { buttons: 1, clientX: 40, clientY: 12 });
    expect(selected(container)).toHaveLength(0);
    expect(container.querySelector("[data-marquee='on']")).toBeNull();
    fireEvent.mouseUp(document.body);
  });

  it("手ぶれ程度 (しきい値未満) の移動では別セルへ入っても始まらない", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    fireEvent.mouseDown(cell(container, 0, 0), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(cell(container, 0, 1), { buttons: 1, clientX: 11, clientY: 11 });
    expect(selected(container)).toHaveLength(0);
    fireEvent.mouseUp(document.body);
  });

  it("右クリック・修飾キー付きでは始まらない (右クリックメニュー / Shift+クリックを壊さない)", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    for (const init of [{ button: 2 }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }]) {
      fireEvent.mouseDown(cell(container, 0, 0), { clientX: 10, clientY: 10, ...init });
      fireEvent.mouseMove(cell(container, 1, 1), { buttons: 1, clientX: 80, clientY: 60 });
      expect(selected(container)).toHaveLength(0);
      fireEvent.mouseUp(document.body);
    }
  });

  it("Shift+クリックは従来どおり範囲拡張で、ドラッグ追跡は始めない", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const start = cell(container, 0, 0);
    fireEvent.focus(start);
    fireEvent.mouseDown(cell(container, 1, 1), { button: 0, shiftKey: true, clientX: 50, clientY: 50 });
    expect(selected(container).sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    fireEvent.mouseMove(cell(container, 2, 2), { buttons: 1, clientX: 120, clientY: 90 });
    expect(selected(container)).toHaveLength(4);
    fireEvent.mouseUp(document.body);
  });

  it("ボタンを離したイベントを取りこぼしても (buttons=0 の移動で) 追跡を止める", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    fireEvent.mouseDown(cell(container, 0, 0), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(cell(container, 1, 1), { buttons: 1, clientX: 80, clientY: 60 });
    fireEvent.mouseMove(cell(container, 2, 2), { buttons: 0, clientX: 120, clientY: 90 });
    expect(container.querySelector("[data-marquee='on']")).toBeNull();
    expect(selected(container).sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
  });

  it("マーキー後も基点セルがアクティブのまま (矢印キー移動の起点になる)", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const start = cell(container, 0, 0);
    fireEvent.mouseDown(start, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.focus(start);
    fireEvent.mouseMove(cell(container, 2, 2), { buttons: 1, clientX: 120, clientY: 90 });
    fireEvent.mouseUp(document.body);
    expect(start.classList.contains("is-active-cell")).toBe(true);
    expect(cell(container, 2, 2).classList.contains("is-active-cell")).toBe(false);
  });
});
