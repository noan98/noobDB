import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import type { AlterTableContext } from "../api/tauri";

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
  return {
    ...actual,
    api: {
      ...actual.api,
      alterTableContext: vi.fn().mockResolvedValue(ctx),
      listTables: vi.fn().mockResolvedValue(["users"]),
      getObjectDefinition: vi.fn().mockResolvedValue('CREATE TABLE "users" (id INTEGER PRIMARY KEY);\n'),
      describeTable: vi.fn().mockResolvedValue([{ name: "id", extra: "" }]),
      runLookupQuery: vi.fn(),
      tableRowEstimate: vi.fn().mockResolvedValue(null),
    },
  };
});

import { t } from "../i18n";
import { AlterTableModal } from "../components/AlterTableModal";
import { CreateTableModal } from "../components/CreateTableModal";
import { RenameTableDialog } from "../components/RenameTableDialog";
import { TableCloneModal } from "../components/TableCloneModal";
import { waitFor } from "./testUtils";

// 長すぎる識別子はモーダルの確定を止める (#2384)。PostgreSQL は黙って切り詰めるため特に重要。
function renderRename(driver: string) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <RenameTableDialog
      driver={driver}
      table="users"
      existingTables={[]}
      buildSql={(n) => `ALTER TABLE users RENAME TO ${n};`}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  );
  return onConfirm;
}

describe("識別子の長さ検査 (#2384)", () => {
  it("PostgreSQL: 日本語 22 文字 (66 バイト) は確定できずエラーを出す", () => {
    const onConfirm = renderRename("postgres");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "あ".repeat(22) } });
    expect(screen.getByTestId("ident-too-long")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("PostgreSQL: 21 文字 (63 バイト) は確定できる", () => {
    const onConfirm = renderRename("postgres");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "あ".repeat(21) } });
    expect(screen.queryByTestId("ident-too-long")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("あ".repeat(21));
  });

  it("SQLite: 長い名前も確定できる", () => {
    const onConfirm = renderRename("sqlite");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a".repeat(200) } });
    expect(screen.queryByTestId("ident-too-long")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalled();
  });

  it("CreateTableModal: 列名が長いとエラーを出し、実行を無効にする", async () => {
    renderWithProviders(
      <CreateTableModal
        driver="postgres"
        database={null}
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(t("createTableName")), { target: { value: "ok" } });
    fireEvent.change(screen.getByLabelText(`${t("createTableColName")} (1)`), {
      target: { value: "x".repeat(64) },
    });
    expect(screen.getByTestId("ident-too-long")).toBeTruthy();
    expect(screen.getByRole("button", { name: t("createTableRun") })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`${t("createTableColName")} (1)`), {
      target: { value: "x".repeat(63) },
    });
    expect(screen.queryByTestId("ident-too-long")).toBeNull();
    expect(screen.getByRole("button", { name: t("createTableRun") })).toBeEnabled();
  });

  it("AlterTableModal: 追加列の名前が長いとエラーを出し、実行を無効にする", async () => {
    renderWithProviders(
      <AlterTableModal
        sessionId="s1"
        driver="postgres"
        database="db"
        table="t"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    fireEvent.change(screen.getByLabelText(`${t("createTableColName")} (1)`), {
      target: { value: "あ".repeat(22) },
    });
    expect(screen.getByTestId("ident-too-long")).toBeTruthy();
    expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeDisabled();
  });

  it("TableCloneModal: 複製先の名前が長いと確定できない", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <TableCloneModal
        sessionId="s1"
        driver="postgres"
        database="main"
        sourceTable="users"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    const input = await screen.findByLabelText(/users/);
    await waitFor(() => expect(input).toHaveValue("users_copy"));
    fireEvent.change(input, { target: { value: "あ".repeat(22) } });
    expect(screen.getByTestId("ident-too-long")).toBeTruthy();
    expect(screen.getByRole("button", { name: t("cloneTableConfirm") })).toBeDisabled();
  });
});
