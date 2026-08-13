import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * 現在のクエリをビューとして保存 / 既存ビュー定義を編集して置換 (#851)。マウント時に
 * `api.listSchemaObjects` を呼んで既存ビュー名を取得するので、実 Tauri なしで
 * レンダリングできるようモックする。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSchemaObjects: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { SaveAsViewModal } from "../components/SaveAsViewModal";

const listSchemaObjects = api.listSchemaObjects as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  listSchemaObjects.mockResolvedValue([
    { kind: "view", name: "active_users", id: null },
    { kind: "table", name: "users", id: null },
    { kind: "procedure", name: "recalc", id: null },
  ]);
});

describe("SaveAsViewModal render smoke (#851)", () => {
  it("mounts as a dialog, shows the title, and fetches existing schema objects", async () => {
    renderWithProviders(
      <SaveAsViewModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("saveAsViewTitle"))).toBeInTheDocument();
    await waitFor(() => expect(listSchemaObjects).toHaveBeenCalledWith("s1", "shop"));
  });

  it("invokes onClose when the close control is activated", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <SaveAsViewModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(listSchemaObjects).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: t("saveAsViewClose") })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("SaveAsViewModal name validation and collision (#851)", () => {
  it("disables the confirm button until a name is entered", async () => {
    renderWithProviders(
      <SaveAsViewModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listSchemaObjects).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: t("saveAsViewConfirm") })).toBeDisabled();
  });

  it("previews a plain CREATE VIEW and confirms a non-colliding name (not blocked, unlike tables)", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <SaveAsViewModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listSchemaObjects).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsViewNamePlaceholder")), {
      target: { value: "top_users" },
    });
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toBe(
        "CREATE VIEW `shop`.`top_users` AS\nSELECT * FROM users;",
      ),
    );
    const confirmButton = screen.getByRole("button", { name: t("saveAsViewConfirm") });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith("top_users", false);
  });

  it("switches to a CREATE OR REPLACE VIEW preview and passes replace=true when the name collides (case-insensitive)", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <SaveAsViewModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listSchemaObjects).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("saveAsViewNamePlaceholder")), {
      target: { value: "Active_Users" },
    });
    expect(
      await screen.findByText(t("saveAsViewNameReplaceNote", { view: "Active_Users" })),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toBe(
        "CREATE OR REPLACE VIEW `shop`.`Active_Users` AS\nSELECT * FROM users;",
      ),
    );
    const confirmButton = screen.getByRole("button", { name: t("saveAsViewReplaceConfirm") });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith("Active_Users", true);
  });

  it("pre-fills the name field from initialName (opened via 'edit view definition')", async () => {
    renderWithProviders(
      <SaveAsViewModal
        sessionId="s1"
        driver="mysql"
        database="shop"
        sourceSql="SELECT * FROM users"
        initialName="active_users"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listSchemaObjects).toHaveBeenCalled());
    expect(screen.getByPlaceholderText(t("saveAsViewNamePlaceholder"))).toHaveValue("active_users");
    expect(
      await screen.findByText(t("saveAsViewNameReplaceNote", { view: "active_users" })),
    ).toBeInTheDocument();
  });
});
