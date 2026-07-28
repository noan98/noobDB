import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
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
    },
  };
});

import { api } from "../api/tauri";
import { SaveAsTableModal } from "../components/SaveAsTableModal";

const listTables = api.listTables as ReturnType<typeof vi.fn>;

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
