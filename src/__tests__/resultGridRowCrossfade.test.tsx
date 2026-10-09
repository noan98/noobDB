import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, fireEvent, screen, waitFor, within } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale, t } from "../i18n";

// クライアント側ソート / フィルタ適用時の <tbody> クロスフェード (#1416)。
// jsdom には Element.animate が無いのでスタブして呼び出しを見る。

const reducedRef = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("motion/react")>();
  return { ...mod, useReducedMotionConfig: () => reducedRef.value };
});

const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "a", type_name: "VARCHAR" },
];
const tableColumns = columns.map((c, i) => ({
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
const result: QueryResult = {
  columns,
  rows: Array.from({ length: 10 }, (_, i) => [i, `v${9 - i}`]),
  rows_affected: 10,
  elapsed_ms: 1,
};

describe("結果グリッドの行クロスフェード (#1416)", () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
    reducedRef.value = false;
    animate.mockClear();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("マウント時は再生せず、ソートで <tbody> に opacity を 1 回だけ再生し、DOM は作り直さない", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    expect(animate).not.toHaveBeenCalled();
    const tbody = container.querySelector("tbody");
    const cellBefore = Array.from(container.querySelectorAll("tbody td[role='gridcell']")).find(
      (td) => td.textContent === "v9",
    );
    await user.click(container.querySelectorAll<HTMLElement>(".th-sort-button")[1]);
    expect(animate).toHaveBeenCalledTimes(1);
    const calls = animate.mock.calls as unknown as unknown[][];
    expect(animate.mock.contexts[0]).toBe(tbody);
    expect(calls[0][0]).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
    // 再マウントされていない (スクロール・選択・編集状態が保たれる)。
    expect(container.querySelector("tbody")).toBe(tbody);
    expect(cellBefore?.isConnected).toBe(true);
  });

  it("検索 (グローバルフィルタ) の連続入力では、入力が落ち着いてから 1 回だけ再生する", async () => {
    const user = userEvent.setup();
    const { rerender, container } = renderWithProviders(<ResultGrid result={result} />);
    rerender(<ResultGrid result={result} />);
    expect(animate).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(t("gridSearchAria")), "v1");
    // 入力直後 (待ち時間内) はまだ再生しない = 1 文字ごとに再スタートして明滅しない。
    expect(animate).not.toHaveBeenCalled();
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 400));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(container.querySelector("tbody"));
  });

  it("別の結果 (gridViewKey が変わる) に差し替わったときは、保存済みソートが復元されても再生しない", async () => {
    const user = userEvent.setup();
    const other: QueryResult = { ...result, columns: [{ name: "m", type_name: "INT" }, columns[1]] };
    // other 側のソートを保存済みにする: 一度ソートしてから戻る。
    const { rerender } = renderWithProviders(<ResultGrid result={other} />);
    await user.click(document.querySelectorAll<HTMLElement>(".th-sort-button")[0]);
    rerender(<ResultGrid result={result} />);
    animate.mockClear();
    rerender(<ResultGrid result={other} />);
    await new Promise((r) => setTimeout(r, 400));
    expect(animate).not.toHaveBeenCalled();
  });

  it("インライン編集中にソートが変わっても、編集中の input は接続されたまま値を保つ", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ResultGrid result={result} editable tableColumns={tableColumns} onSetCellEdit={vi.fn()} />,
    );
    const cell = Array.from(container.querySelectorAll("tbody td[role='gridcell']")).find(
      (td) => td.textContent === "v9",
    ) as HTMLElement;
    await user.dblClick(cell);
    const input = within(cell).getByRole("textbox") as HTMLInputElement;
    await user.type(input, "zz");
    const value = input.value;
    // フォーカスを動かさずにソートだけを変える (実クリックだと blur で編集が確定する)。
    fireEvent.click(container.querySelectorAll<HTMLElement>(".th-sort-button")[0]);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(value);
  });

  it("reduced-motion では再生しない", async () => {
    reducedRef.value = true;
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    await user.click(container.querySelectorAll<HTMLElement>(".th-sort-button")[1]);
    expect(animate).not.toHaveBeenCalled();
  });
});
