import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { RowInsertModal } from "../components/RowInsertModal";
import type { TableColumnInfo } from "../api/tauri";
import { t } from "../i18n";

// 行追加モーダルの既定値 / 自動採番 / 関数値の入力支援 (#1357)。
// 空欄は INSERT から省かれ、チップで選んだ関数だけが式として確定することを固定する。

const columns = [
  { name: "id", type_name: "INT" },
  { name: "created_at", type_name: "DATETIME" },
  { name: "note", type_name: "VARCHAR" },
];

const tableColumns: TableColumnInfo[] = [
  {
    name: "id",
    data_type: "int",
    nullable: false,
    key: "PRI",
    default: null,
    extra: "auto_increment",
    referenced_table: null,
    referenced_column: null,
  },
  {
    name: "created_at",
    data_type: "datetime",
    nullable: false,
    key: "",
    default: "CURRENT_TIMESTAMP",
    extra: "",
    referenced_table: null,
    referenced_column: null,
  },
  {
    name: "note",
    data_type: "varchar(255)",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  },
];

function renderModal(onConfirm = vi.fn()) {
  renderWithProviders(
    <RowInsertModal
      table="events"
      columns={columns}
      driver="mysql"
      database="shop"
      tableColumns={tableColumns}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  );
  return onConfirm;
}

describe("RowInsertModal defaults and auto-increment (#1357)", () => {
  it("explains that an auto-increment column is assigned by the database when left empty", () => {
    renderModal();
    expect(screen.getByTestId("insert-default-hint-id")).toHaveTextContent(t("rowOpsInsertAutoHint"));
    expect(screen.getByPlaceholderText(t("rowOpsInsertAutoPlaceholder"))).toBeInTheDocument();
  });

  it("shows the DEFAULT expression of a column that has one", () => {
    renderModal();
    expect(screen.getByTestId("insert-default-hint-created_at")).toHaveTextContent(
      t("rowOpsInsertDefaultHint", { expr: "CURRENT_TIMESTAMP" }),
    );
    expect(
      screen.getByPlaceholderText(t("rowOpsInsertDefaultPlaceholder", { expr: "CURRENT_TIMESTAMP" })),
    ).toBeInTheDocument();
  });

  it("shows no hint for a column without default or auto-increment", () => {
    renderModal();
    expect(screen.queryByTestId("insert-affordance-note")).toBeNull();
  });

  it("omits an empty auto-increment column from the confirmed row", () => {
    const onConfirm = renderModal();
    const noteInput = screen.getAllByRole("textbox")[2];
    fireEvent.change(noteInput, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: t("rowOpsInsertAdd") }));
    expect(onConfirm).toHaveBeenCalledWith({ 2: "hello" });
  });

  it("inserts a function chip as an expression value", () => {
    const onConfirm = renderModal();
    const chip = screen.getByTestId("insert-fn-created_at-current_timestamp");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect((screen.getAllByRole("textbox")[1] as HTMLInputElement).value).toBe("CURRENT_TIMESTAMP");
    expect(screen.getByText(t("rowOpsInsertFnActive"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("rowOpsInsertAdd") }));
    expect(onConfirm).toHaveBeenCalledWith({
      1: { fn: "current_timestamp", sql: "CURRENT_TIMESTAMP" },
    });
  });

  it("turns a function value back into typed text once the field is edited", () => {
    const onConfirm = renderModal();
    fireEvent.click(screen.getByTestId("insert-fn-created_at-current_timestamp"));
    const input = screen.getAllByRole("textbox")[1];
    fireEvent.change(input, { target: { value: "NOW()" } });
    expect(screen.queryByText(t("rowOpsInsertFnActive"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("rowOpsInsertAdd") }));
    // 打った "NOW()" は式ではなく文字列として確定する (引用はリテラル化で行われる)。
    expect(onConfirm).toHaveBeenCalledWith({ 1: "NOW()" });
  });

  it("clears a function value when its chip is pressed again", () => {
    const onConfirm = renderModal();
    const chip = screen.getByTestId("insert-fn-created_at-current_timestamp");
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: t("rowOpsInsertAdd") }));
    expect(onConfirm).toHaveBeenCalledWith({});
  });
});
