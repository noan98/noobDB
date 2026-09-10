import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "./testUtils";
import { TableDiffRow } from "../components/SchemaCompareView";
import { t } from "../i18n";
import type { ColumnDiff, DiffStatus, TableColumnInfo, TableDiff } from "../api/tauri";

/**
 * テーブル差分行のアコーディオン化 (#1008)。ネイティブ `<details>` を
 * `variants.collapse` ベースの `<button aria-expanded>` へ置き換えたことで、
 * 「開閉可能な行だけボタンになる」「初期状態 (`different` は展開済み)」
 * 「クリック/キーボードの両方で開閉できる」「展開でカラム行が現れる」ことを
 * 固定する。色は `diffStatusColors.test.ts` が別途カバーする。
 */

function makeColumnInfo(name: string, dataType = "int"): TableColumnInfo {
  return {
    name,
    data_type: dataType,
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  };
}

function makeColumnDiff(name: string, status: DiffStatus): ColumnDiff {
  const info = makeColumnInfo(name);
  return {
    name,
    status,
    source: status === "target_only" ? null : info,
    target: status === "source_only" ? null : info,
    changed_fields: status === "different" ? ["data_type"] : [],
  };
}

function makeTableDiff(
  name: string,
  status: DiffStatus,
  columns: ColumnDiff[] = [],
): TableDiff {
  return { name, status, columns };
}

describe("TableDiffRow アコーディオン (#1008)", () => {
  it("カラム差分を持つテーブルは、既定で折りたたまれた開閉可能な行になる", () => {
    const table = makeTableDiff("users", "source_only", [
      makeColumnDiff("id", "source_only"),
      makeColumnDiff("name", "source_only"),
    ]);
    renderWithProviders(<TableDiffRow table={table} t={t} />);

    const toggle = screen.getByRole("button", { name: /users/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("id")).not.toBeInTheDocument();
  });

  it("差分ありのテーブルは初期状態で展開済み", () => {
    const table = makeTableDiff("orders", "different", [
      makeColumnDiff("total", "different"),
    ]);
    renderWithProviders(<TableDiffRow table={table} t={t} />);

    const toggle = screen.getByRole("button", { name: /orders/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("total")).toBeInTheDocument();
  });

  it("クリックで展開/折りたたみを切り替え、カラム行が出入りする", async () => {
    const user = userEvent.setup();
    const table = makeTableDiff("products", "target_only", [
      makeColumnDiff("sku", "target_only"),
    ]);
    renderWithProviders(<TableDiffRow table={table} t={t} />);

    const toggle = screen.getByRole("button", { name: /products/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("sku")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("キーボード (Enter) だけで展開できる — ネイティブ button semantics を保つ", async () => {
    const user = userEvent.setup();
    const table = makeTableDiff("invoices", "source_only", [
      makeColumnDiff("amount", "source_only"),
    ]);
    renderWithProviders(<TableDiffRow table={table} t={t} />);

    const toggle = screen.getByRole("button", { name: /invoices/ });
    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("amount")).toBeInTheDocument();
  });

  it("カラム差分を持たないテーブルはトグル無しの静的な行として描画される", () => {
    const table = makeTableDiff("empty_table", "same", []);
    const { container } = renderWithProviders(<TableDiffRow table={table} t={t} />);

    expect(within(container).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("empty_table")).toBeInTheDocument();
  });
});
