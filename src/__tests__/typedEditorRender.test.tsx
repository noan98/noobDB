import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, within } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import { RowInsertModal } from "../components/RowInsertModal";
import { rowEditKey } from "../components/cellEdit";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale } from "../i18n";

// 型別インライン・エディタ (#1355) の描画・確定・取消。
const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "flag", type_name: "BOOLEAN" },
  { name: "d", type_name: "DATE" },
];
const tc = (name: string, data_type: string, key = ""): TableColumnInfo => ({
  name,
  data_type,
  nullable: true,
  key,
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
});
const tableColumns = [tc("id", "int", "PRI"), tc("flag", "boolean"), tc("d", "date")];
const result: QueryResult = {
  columns,
  rows: [[1, true, "2024-01-31"]],
  rows_affected: 0,
  elapsed_ms: 1,
};
const rowKey = rowEditKey([1, true, "2024-01-31"], [0], 0);

function setup() {
  const onSetCellEdit = vi.fn();
  const { container } = renderWithProviders(
    <ResultGrid result={result} editable tableColumns={tableColumns} onSetCellEdit={onSetCellEdit} />,
  );
  const cells = container.querySelectorAll<HTMLElement>("td.is-editable-cell");
  return { onSetCellEdit, flagCell: cells[0], dateCell: cells[1] };
}

describe("型別インライン・エディタ (グリッド)", () => {
  beforeEach(() => setLocale("en"));

  it("BOOLEAN 列は select で編集し Enter で確定する", async () => {
    const user = userEvent.setup();
    const { onSetCellEdit, flagCell } = setup();
    await user.dblClick(flagCell);
    const select = within(flagCell).getByRole("combobox");
    await user.selectOptions(select, "false");
    await user.keyboard("{Enter}");
    expect(onSetCellEdit).toHaveBeenCalledWith(rowKey, 1, "false");
  });

  it("DATE 列は input[type=date] で編集し Enter で確定する", async () => {
    const user = userEvent.setup();
    const { onSetCellEdit, dateCell } = setup();
    await user.dblClick(dateCell);
    const input = dateCell.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("date");
    expect(input.value).toBe("2024-01-31");
    fireEvent.change(input, { target: { value: "2024-02-01" } });
    await user.keyboard("{Enter}");
    expect(onSetCellEdit).toHaveBeenCalledWith(rowKey, 2, "2024-02-01");
  });

  it("Esc で取り消すと確定しない", async () => {
    const user = userEvent.setup();
    const { onSetCellEdit, dateCell } = setup();
    await user.dblClick(dateCell);
    fireEvent.change(dateCell.querySelector("input") as HTMLInputElement, {
      target: { value: "2024-02-01" },
    });
    await user.keyboard("{Escape}");
    expect(onSetCellEdit).not.toHaveBeenCalled();
  });
});

describe("型別インライン・エディタ (行追加)", () => {
  beforeEach(() => setLocale("en"));

  it("真偽値は select、日付系はテキスト入力 (NULL を打てる) のまま。未選択の列は省略される", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <RowInsertModal table="t" columns={columns} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const select = screen.getByRole("combobox", { name: "flag" });
    await user.selectOptions(select, "true");
    await user.type(screen.getAllByRole("textbox")[1], "null");
    fireEvent.keyDown(select, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith({ 1: "true", 2: "null" });
  });

  it("真偽値を既定値へ戻すと列が省略される", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <RowInsertModal table="t" columns={columns} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const select = screen.getByRole("combobox", { name: "flag" });
    await user.selectOptions(select, "true");
    await user.selectOptions(select, "");
    fireEvent.keyDown(select, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith({});
  });
});
