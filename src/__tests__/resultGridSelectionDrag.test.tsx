import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, within } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import { registerTreeDropTarget } from "../components/treeDragStore";
import type { QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";
import { setColumnMaskEnabled, setColumnMaskPatterns } from "../settings";

// 選択セルのエディタへのドラッグ挿入 (#2406)。マーキー選択 (#1578) とは、
// 「複数セルの矩形選択の内側を押したときだけ」ドラッグ挿入になることで棲み分ける。

const RESULT: QueryResult = {
  columns: [
    { name: "a", type_name: "INT" },
    { name: "b", type_name: "INT" },
  ],
  rows: [
    [1, 2],
    [4, 5],
    [4, 8],
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

/** pointerdown → mousedown を同じ座標で送る (実ブラウザと同じ順序)。 */
function press(el: HTMLElement, x: number, y: number) {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      bubbles: true,
      clientX: x,
      clientY: y,
    }),
  );
  fireEvent.mouseDown(el, { button: 0, clientX: x, clientY: y });
}
const ptr = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
  new PointerEvent(type, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    bubbles: true,
    clientX: x,
    clientY: y,
    ...init,
  });

describe("結果グリッドの選択セルのドラッグ挿入 (#2406)", () => {
  let editor: HTMLElement;
  let insert: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
  let off: () => void;
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
    editor = document.createElement("div");
    document.body.append(editor);
    document.elementFromPoint = () => editor;
    insert = vi.fn();
    off = registerTreeDropTarget({ element: editor, posAtCoords: () => 5, setMarker: () => {}, insert });
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
    document.elementFromPoint = originalElementFromPoint;
    off();
    editor.remove();
  });

  function selectColumn(container: HTMLElement) {
    fireEvent.focus(cell(container, 0, 0));
    fireEvent.keyDown(cell(container, 0, 0), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cell(container, 1, 0), { key: "ArrowDown", shiftKey: true });
    expect(selected(container).sort()).toEqual(["0:0", "1:0", "2:0"]);
  }

  it("矩形選択の内側を押してエディタへドラッグすると IN リストが挿入され、マーキーは始まらない", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} driver="mysql" />);
    selectColumn(container);
    press(cell(container, 1, 0), 10, 10);
    window.dispatchEvent(ptr("pointermove", 60, 10));
    expect(container.querySelector("[data-marquee='on']")).toBeNull();
    window.dispatchEvent(ptr("pointerup", 60, 10));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({ kind: "text", text: "`a` IN (1, 4)" });
    expect(insert.mock.calls[0][1]).toBe(5);
    // 選択は維持される。
    expect(selected(container)).toHaveLength(3);
  });

  it("Esc で取り消すと挿入されず、選択も変わらない", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} driver="mysql" />);
    selectColumn(container);
    press(cell(container, 1, 0), 10, 10);
    window.dispatchEvent(ptr("pointermove", 60, 10));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(ptr("pointerup", 60, 10, { buttons: 0 }));
    expect(insert).not.toHaveBeenCalled();
    expect(selected(container)).toHaveLength(3);
  });

  it("選択の内側をクリックだけして離すと選択が解除される (従来の mousedown と同じ)", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} driver="mysql" />);
    selectColumn(container);
    press(cell(container, 1, 0), 10, 10);
    act(() => void window.dispatchEvent(ptr("pointerup", 10, 10)));
    expect(insert).not.toHaveBeenCalled();
    expect(selected(container)).toHaveLength(0);
  });

  it("未選択のセルを押してドラッグするとマーキー選択になる", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} driver="mysql" />);
    press(cell(container, 0, 0), 10, 10);
    fireEvent.focus(cell(container, 0, 0));
    fireEvent.mouseMove(cell(container, 1, 1), { buttons: 1, clientX: 60, clientY: 40 });
    expect(container.querySelector("[data-marquee='on']")).not.toBeNull();
    expect(selected(container).sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    fireEvent.mouseUp(document.body);
    window.dispatchEvent(ptr("pointerup", 60, 40));
    expect(insert).not.toHaveBeenCalled();
  });

  it("単独のアクティブセルを押してドラッグしても、エディタ挿入ではなくマーキー選択を始められる", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} driver="mysql" />);
    fireEvent.focus(cell(container, 0, 0));
    press(cell(container, 0, 0), 10, 10);
    fireEvent.mouseMove(cell(container, 1, 1), { buttons: 1, clientX: 60, clientY: 40 });
    expect(container.querySelector("[data-marquee='on']")).not.toBeNull();
    expect(selected(container)).toHaveLength(4);
    fireEvent.mouseUp(document.body);
    window.dispatchEvent(ptr("pointerup", 60, 40));
    expect(insert).not.toHaveBeenCalled();
  });

  it("ダブルクリックでセルの編集に入れる (ドラッグ挿入に奪われない)", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ResultGrid
        result={{
          ...RESULT,
          columns: [RESULT.columns[0], { name: "b", type_name: "VARCHAR" }],
          rows: [[1, "x"]],
        }}
        driver="mysql"
        editable
        tableColumns={[
          {
            name: "a",
            data_type: "int",
            nullable: false,
            key: "PRI",
            default: null,
            extra: "",
            referenced_table: null,
            referenced_column: null,
          },
          {
            name: "b",
            data_type: "varchar",
            nullable: true,
            key: "",
            default: null,
            extra: "",
            referenced_table: null,
            referenced_column: null,
          },
        ]}
        onSetCellEdit={vi.fn()}
      />,
    );
    const target = container.querySelector("td.is-editable-cell") as HTMLElement;
    await user.click(target);
    await user.dblClick(target);
    expect(within(target).getByRole("textbox")).toBeTruthy();
  });

  it("マスク中のセルを含む選択ではドラッグ挿入を始めない (値を持ち出さない)", () => {
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(["secret"]);
    onTestFinished(() => {
      setColumnMaskEnabled(false);
      setColumnMaskPatterns([]);
    });
    const masked: QueryResult = {
      ...RESULT,
      columns: [
        { name: "id", type_name: "INT" },
        { name: "secret", type_name: "INT" },
      ],
    };
    const { container } = renderWithProviders(<ResultGrid result={masked} driver="mysql" />);
    fireEvent.focus(cell(container, 0, 1));
    fireEvent.keyDown(cell(container, 0, 1), { key: "ArrowDown", shiftKey: true });
    press(cell(container, 1, 1), 10, 10);
    window.dispatchEvent(ptr("pointermove", 60, 10));
    window.dispatchEvent(ptr("pointerup", 60, 10));
    expect(insert).not.toHaveBeenCalled();
  });
});
