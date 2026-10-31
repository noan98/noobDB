import { describe, it, expect, vi, beforeEach } from "vitest";
import { chooseListboxOption, renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * 実行結果を新規テーブルへ保存 (CREATE TABLE ... AS SELECT、#821)。マウント時に
 * `api.listTables` を呼んで既存テーブル名を取得するので、実 Tauri なしでレンダリング
 * できるようモックする。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTables: vi.fn(),
      describeTable: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { SaveAsTableModal } from "../components/SaveAsTableModal";

const listTables = api.listTables as ReturnType<typeof vi.fn>;
const describeTable = api.describeTable as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  listTables.mockResolvedValue(["users", "orders"]);
});

describe("SaveAsTableModal render smoke (#821)", () => {
  it("mounts as a dialog, shows the title, and fetches existing table names", async () => {
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("saveAsTableTitle"))).toBeInTheDocument();
    await waitFor(() => expect(listTables).toHaveBeenCalledWith("s1", "shop"));
  });

  it("invokes onClose when the close control is activated", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: t("saveAsTableClose") })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("SaveAsTableModal name validation (#821)", () => {
  it("disables the confirm button until a name is entered", async () => {
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: t("saveAsTableConfirm") })).toBeDisabled();
  });

  it("warns and disables confirm when the typed name collides with an existing table (case-insensitive)", async () => {
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsTableNamePlaceholder")), {
      target: { value: "Users" },
    });
    expect(await screen.findByText(t("saveAsTableNameExists", { table: "Users" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("saveAsTableConfirm") })).toBeDisabled();
  });

  it("previews the generated CREATE TABLE ... AS SQL and confirms a non-colliding name", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsTableNamePlaceholder")), {
      target: { value: "top_users" },
    });
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toBe(
        "CREATE TABLE `shop`.`top_users` AS\nSELECT * FROM users;",
      ),
    );
    const confirmButton = screen.getByRole("button", { name: t("saveAsTableConfirm") });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith("top_users");
  });
});

describe("SaveAsTableModal append mode (#1623)", () => {
  const col = (name: string, nullable = true) => ({
    name,
    data_type: "int",
    nullable,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });

  it("switches to append on a name collision, maps by name and confirms INSERT ... SELECT", async () => {
    describeTable.mockResolvedValue([col("id"), col("total")]);
    const onConfirm = vi.fn();
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT id, total FROM orders"
        resultColumns={["id", "total"]}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsTableNamePlaceholder")), {
      target: { value: "Orders" },
    });
    expect(await screen.findByText(t("saveAsTableAppendNotice", { table: "orders" }))).toBeInTheDocument();
    await waitFor(() => expect(describeTable).toHaveBeenCalledWith("s1", "shop", "orders"));
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toContain("INSERT INTO `shop`.`orders`"),
    );
    const confirm = screen.getByRole("button", { name: t("saveAsTableAppendConfirm") });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(
      "orders",
      "INSERT INTO `shop`.`orders` (`id`, `total`)\nSELECT `id`, `total`\nFROM (\nSELECT id, total FROM orders\n) AS _src;",
    );
  });

  it("blocks confirm when two result columns target the same column", async () => {
    describeTable.mockResolvedValue([col("id"), col("total")]);
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT id, total FROM orders"
        resultColumns={["id", "total"]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsTableNamePlaceholder")), {
      target: { value: "orders" },
    });
    const sel = await screen.findByLabelText(t("saveAsTableAppendTargetAria", { column: "total" }));
    chooseListboxOption(sel, "id");
    expect(
      await screen.findByText(t("saveAsTableAppendDuplicateTarget", { column: "id" })),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("saveAsTableAppendConfirm") })).toBeDisabled();
  });

  it("does not offer append on a read-only connection and keeps the name collision block", async () => {
    renderWithProviders(
      <SaveAsTableModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT id FROM orders"
        resultColumns={["id"]}
        readOnly
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listTables).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsTableNamePlaceholder")), {
      target: { value: "orders" },
    });
    expect(await screen.findByText(t("saveAsTableNameExists", { table: "orders" }))).toBeInTheDocument();
    expect(describeTable).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: t("saveAsTableAppendConfirm") })).not.toBeInTheDocument();
  });
});
