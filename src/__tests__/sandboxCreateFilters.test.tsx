import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { SandboxCreateModal } from "../components/SandboxCreateModal";
import { t } from "../i18n";
import { api } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTables: vi.fn().mockResolvedValue(["orders", "users"]),
      foreignKeys: vi.fn().mockResolvedValue([]),
      createSandbox: vi.fn(),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listTables).mockResolvedValue(["orders", "users"]);
  vi.mocked(api.foreignKeys).mockResolvedValue([]);
});

describe("SandboxCreateModal の抽出条件 (#1625)", () => {
  it("選んだ表ごとに条件を入力でき、表名と条件の組で create_sandbox に渡す", async () => {
    vi.mocked(api.createSandbox).mockRejectedValue(new Error("stop"));
    renderWithProviders(
      <SandboxCreateModal
        sessionId="s1"
        database="app"
        defaultName="sb"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    fireEvent.click(await screen.findByLabelText("orders"));
    fireEvent.click(screen.getByLabelText("users"));
    fireEvent.change(screen.getByLabelText(t("sandboxCreateFilterLabel", { table: "orders" })), {
      target: { value: "  created_at >= '2026-01-01'  " },
    });
    fireEvent.click(screen.getByRole("button", { name: t("sandboxCreateSubmit") }));
    await waitFor(() => expect(api.createSandbox).toHaveBeenCalled());
    const params = vi.mocked(api.createSandbox).mock.calls[0][0];
    expect(params.tables).toHaveLength(2);
    expect(params.tables).toContainEqual({ name: "orders", filter: "  created_at >= '2026-01-01'  " });
    // 条件を入れなかった表は filter なし。
    expect(params.tables).toContainEqual({ name: "users", filter: null });
  });

  it("表を選ぶまで抽出条件の欄は出ない", async () => {
    renderWithProviders(
      <SandboxCreateModal
        sessionId="s1"
        database="app"
        defaultName="sb"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    await screen.findByLabelText("orders");
    expect(screen.queryByText(t("sandboxCreateFilters"))).toBeNull();
  });
});
