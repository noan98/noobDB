import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, listTables: vi.fn(), getObjectDefinition: vi.fn(), describeTable: vi.fn(), runLookupQuery: vi.fn() },
  };
});

import { api } from "../api/tauri";
import { TableCloneModal } from "../components/TableCloneModal";

const listTables = api.listTables as ReturnType<typeof vi.fn>;
const describeTable = api.describeTable as ReturnType<typeof vi.fn>;
const lookup = api.runLookupQuery as ReturnType<typeof vi.fn>;
const getDef = api.getObjectDefinition as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  listTables.mockResolvedValue(["users", "orders"]);
  describeTable.mockResolvedValue([{ name: "id", extra: "" }]);
  getDef.mockResolvedValue('CREATE TABLE "users" (id INTEGER PRIMARY KEY);\n');
});

const mount = (onConfirm = vi.fn(), onClose = vi.fn(), driver: "sqlite" | "mysql" | "postgres" = "sqlite") =>
  renderWithProviders(
    <TableCloneModal sessionId="s1" driver={driver} database="main" sourceTable="users" onConfirm={onConfirm} onClose={onClose} />,
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

  it("ビューなど CREATE TABLE でない定義では ErrorNote を出し確定できない", async () => {
    getDef.mockResolvedValue("CREATE VIEW users AS SELECT 1;\n");
    mount();
    expect(await screen.findByText(t("cloneTableNotTable"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("cloneTableConfirm") })).toBeDisabled();
  });

  it("MySQL の生成列は INSERT ... SELECT の明示列リストから除かれる", async () => {
    getDef.mockResolvedValue("CREATE TABLE `users` (id int);\n");
    describeTable.mockResolvedValue([
      { name: "id", extra: "auto_increment" },
      { name: "g", extra: "VIRTUAL GENERATED" },
    ]);
    const onConfirm = vi.fn();
    mount(onConfirm, vi.fn(), "mysql");
    await waitFor(() => expect(describeTable).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(screen.getByRole("button", { name: t("cloneTableConfirm") })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: t("cloneTableConfirm") }));
    const stmts = onConfirm.mock.calls[0][1] as string[];
    expect(stmts.at(-1)).toBe("INSERT INTO `main`.`users_copy` (`id`) SELECT `id` FROM `main`.`users`");
  });

  it("PostgreSQL は LIKE INCLUDING ALL を使い、serial があれば共有シーケンスの注意を出す", async () => {
    getDef.mockResolvedValue(
      `CREATE TABLE "main"."users" ("id" integer NOT NULL DEFAULT nextval('users_id_seq'::regclass), PRIMARY KEY ("id"));\n`,
    );
    lookup.mockResolvedValue({ columns: [], rows: [], rows_affected: 0, elapsed_ms: 0 });
    mount(vi.fn(), vi.fn(), "postgres");
    expect(await screen.findByText(t("cloneTableSharedSequence"))).toBeInTheDocument();
    expect(screen.getByText(/LIKE "main"\."users" INCLUDING ALL/)).toBeInTheDocument();
  });
});
