import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, within } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale } from "../i18n";

// 行単位の memo (`GridRow`, #1341) が効いていることを「行ごとの再レンダー回数」で確かめる。
// セルは描画のたびに `useDelegatedTooltip().bind(値)` を呼ぶので、そこを数える
// (値は `r<行>c<列>` なので、どの行が描き直されたかが分かる)。

const renders = vi.hoisted(() => ({ byRow: new Map<number, number>(), headerGrips: 0 }));
vi.mock("../components/Tooltip", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../components/Tooltip")>();
  const RealTooltip = mod.Tooltip as unknown as (p: { label?: unknown }) => unknown;
  return {
    ...mod,
    // 列ヘッダのドラッグつまみ (列ごとに 1 つ) の描画回数を数える。
    Tooltip: (props: { label?: unknown }) => {
      if (props.label === "Drag to reorder column") renders.headerGrips += 1;
      return createElement(RealTooltip as never, props as never);
    },
    useDelegatedTooltip: (...args: Parameters<typeof mod.useDelegatedTooltip>) => {
      const real = mod.useDelegatedTooltip(...args);
      return {
        ...real,
        bind: (value: string | undefined | null) => {
          const m = typeof value === "string" ? /^r(\d+)c\d+$/.exec(value) : null;
          if (m) renders.byRow.set(Number(m[1]), (renders.byRow.get(Number(m[1])) ?? 0) + 1);
          return real.bind(value);
        },
      };
    },
  };
});

const ROWS = 24;
const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "a", type_name: "VARCHAR" },
  { name: "b", type_name: "VARCHAR" },
];
function mk(): QueryResult {
  return {
    columns,
    rows: Array.from({ length: ROWS }, (_, i) => [i, `r${i}c1`, `r${i}c2`]),
    rows_affected: ROWS,
    elapsed_ms: 1,
  };
}
const result = mk();

function dataCells(container: HTMLElement): HTMLElement[][] {
  return Array.from(container.querySelectorAll("tbody tr[role='row']")).map(
    (tr) => Array.from(tr.querySelectorAll("td[role='gridcell']")) as HTMLElement[],
  );
}
/** 直前の `reset()` 以降に描き直された行の添字 (昇順)。 */
function touchedRows(): number[] {
  return [...renders.byRow.entries()].filter(([, n]) => n > 0).map(([r]) => r).sort((a, b) => a - b);
}
const reset = () => renders.byRow.clear();

describe("結果グリッドの行単位の memo (#1341)", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
    reset();
  });

  it("アクティブセルを ↓ で動かすと、離れる行と入る行の 2 行だけが再レンダーされる", () => {
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    const cells = dataCells(container);
    // 計測が空振りしていないこと: マウント時は全行が 1 度は描かれる。
    expect(touchedRows()).toHaveLength(ROWS);
    fireEvent.focus(cells[5][1]);
    reset();
    fireEvent.keyDown(cells[5][1], { key: "ArrowDown" });
    expect(cells[6][1].classList.contains("is-active-cell")).toBe(true);
    expect(touchedRows()).toEqual([5, 6]);
    reset();
    fireEvent.keyDown(cells[6][1], { key: "ArrowUp" });
    expect(touchedRows()).toEqual([5, 6]);
  });

  it("同じ行の中の ← → では、その 1 行だけが再レンダーされる", () => {
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[3][1]);
    reset();
    fireEvent.keyDown(cells[3][1], { key: "ArrowRight" });
    expect(cells[3][2].classList.contains("is-active-cell")).toBe(true);
    expect(touchedRows()).toEqual([3]);
    reset();
    fireEvent.keyDown(cells[3][2], { key: "ArrowLeft" });
    expect(touchedRows()).toEqual([3]);
  });

  it("Shift+↓ の範囲選択では、範囲に入る行だけが再レンダーされる", () => {
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[2][1]);
    reset();
    fireEvent.keyDown(cells[2][1], { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cells[3][1], { key: "ArrowDown", shiftKey: true });
    expect(touchedRows()).toEqual([2, 3, 4]);
    expect(cells[4][1].classList.contains("is-selected-cell")).toBe(true);
    expect(cells[10][1].classList.contains("is-selected-cell")).toBe(false);
  });

  it("アクティブセルを動かしても、列ヘッダは描き直されない", () => {
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    const cells = dataCells(container);
    expect(renders.headerGrips).toBeGreaterThanOrEqual(columns.length);
    fireEvent.focus(cells[1][1]);
    renders.headerGrips = 0;
    fireEvent.keyDown(cells[1][1], { key: "ArrowDown" });
    fireEvent.keyDown(cells[2][1], { key: "ArrowRight" });
    expect(renders.headerGrips).toBe(0);
  });

  describe("セル編集", () => {
    const tableColumns: TableColumnInfo[] = columns.map((c, i) => ({
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

    it("編集を始める・打つ・確定する間、再レンダーされるのは編集した行だけ", async () => {
      const user = userEvent.setup();
      const onSetCellEdit = vi.fn();
      const { container } = renderWithProviders(
        <ResultGrid
          result={result}
          editable
          tableColumns={tableColumns}
          onSetCellEdit={onSetCellEdit}
        />,
      );
      const cell = dataCells(container)[7][1];
      reset();
      await user.dblClick(cell);
      const input = within(cell).getByRole("textbox");
      expect(touchedRows()).toEqual([7]);
      await user.type(input, "x");
      expect(touchedRows()).toEqual([7]);
      reset();
      await user.keyboard("{Enter}");
      expect(onSetCellEdit).toHaveBeenCalledTimes(1);
      // Enter で確定すると編集が閉じて次の行へ移る (編集した行と移動先の行)。
      expect(touchedRows()).toEqual([7, 8]);
    });
  });
});

describe("行の中身が変わったときの再描画 (#1341)", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
    reset();
  });

  it("行数が同じで途中の行だけが変わった更新 (自動リフレッシュの差分適用) でも、新しい値が表示される", () => {
    // `applyRefreshPatch` と同じく、変わらない行は同じ配列を使い回し、変わった行だけを新しい配列にする。
    const before = mk();
    const { container, rerender } = renderWithProviders(<ResultGrid result={before} />);
    expect(dataCells(container)[10][1].textContent).toContain("r10c1");
    const rows = before.rows.slice();
    rows[10] = [10, "r10c1-updated", "r10c2"];
    reset();
    rerender(<ResultGrid result={{ ...before, rows }} />);
    expect(dataCells(container)[10][1].textContent).toContain("r10c1-updated");
    // 変わった行だけが描き直され、ほかの行 (先頭・末尾を含む) は描き直されない。
    expect(touchedRows()).toEqual([10]);
  });

  it("末尾に行を追記しても、既存の行は描き直されない", () => {
    const before = mk();
    const { container, rerender } = renderWithProviders(<ResultGrid result={before} />);
    const rows = before.rows.concat([[ROWS, `r${ROWS}c1`, `r${ROWS}c2`]]);
    reset();
    rerender(<ResultGrid result={{ ...before, rows, rows_affected: rows.length }} />);
    expect(dataCells(container)).toHaveLength(ROWS + 1);
    expect(touchedRows()).toEqual([ROWS]);
  });
});
