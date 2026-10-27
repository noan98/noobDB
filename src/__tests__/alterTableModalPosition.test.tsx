import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext } from "../api/tauri";

/** AlterTableModal の新規列の位置指定 (#1625): MySQL だけ選べ、他は理由つきで無効。 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const ctx: AlterTableContext = {
    columns: [
      {
        name: "id",
        data_type: "int",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ],
    table_comment: "",
    foreign_keys: [],
    checks: [],
    generated: [],
    table_names: ["t"],
    warnings: [],
  };
  return { ...actual, api: { ...actual.api, alterTableContext: vi.fn().mockResolvedValue(ctx) } };
});

import { AlterTableModal } from "../components/AlterTableModal";

function renderModal(driver: "mysql" | "postgres") {
  const onSend = vi.fn();
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver={driver}
      database="db"
      table="t"
      readOnly={false}
      onRun={() => {}}
      onSendToEditor={onSend}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AlterTableModal 新規列の位置 (#1625)", () => {
  it("MySQL では「先頭」「指定列の後」を選べて SQL に反映される", async () => {
    renderModal("mysql");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    fireEvent.change(screen.getByLabelText(`${t("createTableColName")} (1)`), { target: { value: "age" } });
    const select = screen.getByLabelText(t("alterTablePositionAria", { n: 1 }));
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: "after:id" } });
    await waitFor(() => expect(screen.getByText(/ADD COLUMN `age`.*AFTER `id`/)).toBeInTheDocument());
    fireEvent.change(select, { target: { value: "first" } });
    await waitFor(() => expect(screen.getByText(/ADD COLUMN `age`.*FIRST/)).toBeInTheDocument());
  });

  it("PostgreSQL では位置の選択が無効になる", async () => {
    renderModal("postgres");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    expect(screen.getByLabelText(t("alterTablePositionAria", { n: 1 }))).toBeDisabled();
  });
});
