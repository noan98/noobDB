import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, listTables: vi.fn(), getObjectDefinition: vi.fn() },
  };
});

import { api } from "../api/tauri";
import { TableCloneModal } from "../components/TableCloneModal";

const listTables = api.listTables as ReturnType<typeof vi.fn>;
const getDef = api.getObjectDefinition as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  listTables.mockResolvedValue(["users", "orders"]);
  getDef.mockResolvedValue('CREATE TABLE "users" (id INTEGER PRIMARY KEY);\n');
});

const mount = (onConfirm = vi.fn(), onClose = vi.fn()) =>
  renderWithProviders(
    <TableCloneModal sessionId="s1" driver="sqlite" database="main" sourceTable="users" onConfirm={onConfirm} onClose={onClose} />,
  );

describe("TableCloneModal (#1398)", () => {
  it("既定名 <元>_copy で DDL をプレビューし、確定で文の列を渡す", async () => {
    const onConfirm = vi.fn();
    mount(onConfirm);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/users/)).toHaveValue("users_copy"));
    await waitFor(() => expect(screen.getByText(/CREATE TABLE "users_copy"/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: t("cloneTableConfirm") }));
    expect(onConfirm).toHaveBeenCalledWith("users_copy", ['CREATE TABLE "users_copy" (id INTEGER PRIMARY KEY)']);
  });

  it("既存名と衝突すると警告して確定できない", async () => {
    const onConfirm = vi.fn();
    mount(onConfirm);
    const input = await screen.findByLabelText(/users/);
    await waitFor(() => expect(input).toHaveValue("users_copy"));
    fireEvent.change(input, { target: { value: "ORDERS" } });
    expect(screen.getByText(t("cloneTableNameExists", { table: "ORDERS" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("cloneTableConfirm") })).toBeDisabled();
  });

  it("閉じる操作で onClose", async () => {
    const onClose = vi.fn();
    mount(vi.fn(), onClose);
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: t("cloneTableClose") })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
