import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext, ColumnDependencyReport } from "../api/tauri";

/** DROP COLUMN の依存オブジェクト警告 (#1758)。 */
const deps = vi.fn<() => Promise<ColumnDependencyReport>>();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const col = (name: string, key = "") => ({
    name,
    data_type: "int",
    nullable: true,
    key,
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });
  const ctx: AlterTableContext = {
    columns: [col("id", "PRI"), col("price")],
    table_comment: "",
    foreign_keys: [],
    checks: [],
    table_names: ["t"],
    warnings: [],
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      alterTableContext: vi.fn().mockResolvedValue(ctx),
      columnDependencies: (...a: unknown[]) => (deps as (...x: unknown[]) => unknown)(...a),
    },
  };
});

import { AlterTableModal } from "../components/AlterTableModal";

function renderModal() {
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver="mysql"
      database="db"
      table="t"
      readOnly={false}
      onRun={() => {}}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AlterTableModal DROP COLUMN の依存警告 (#1758)", () => {
  it("DROP した列に依存があれば種別つきで一覧し、DROP しなければ何も出さない", async () => {
    deps.mockResolvedValue({
      dependencies: [
        { column: "price", kind: "view", name: "v_orders", detail: null, confidence: "direct" },
        { column: "price", kind: "index", name: "idx_price", detail: "price, qty", confidence: "direct" },
        { column: "price", kind: "trigger", name: "trg", detail: null, confidence: "possible" },
      ],
      warnings: [],
    });
    renderModal();
    const dropButtons = await screen.findAllByRole(
      "button",
      { name: t("alterTableDrop") },
      { timeout: 3000 },
    );
    expect(screen.queryByTestId("drop-column-deps")).toBeNull();
    expect(deps).not.toHaveBeenCalled();
    fireEvent.click(dropButtons[1]);
    const box = await screen.findByTestId("drop-column-deps", undefined, { timeout: 3000 });
    expect(box.textContent).toContain("v_orders");
    expect(box.textContent).toContain("idx_price");
    expect(box.textContent).toContain(t("dropColumnDepView"));
    expect(box.textContent).toContain(t("dropColumnDepPossible"));
    expect(deps).toHaveBeenCalledWith("s1", "db", "t", ["price"]);
  });

  it("依存が無ければ警告を出さない", async () => {
    deps.mockResolvedValue({ dependencies: [], warnings: [] });
    renderModal();
    const dropButtons = await screen.findAllByRole(
      "button",
      { name: t("alterTableDrop") },
      { timeout: 3000 },
    );
    fireEvent.click(dropButtons[1]);
    await waitFor(() => expect(deps).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByTestId("drop-column-deps-loading")).toBeNull());
    expect(screen.queryByTestId("drop-column-deps")).toBeNull();
  });

  it("DROP を解除すると警告が消える", async () => {
    deps.mockResolvedValue({
      dependencies: [{ column: "price", kind: "view", name: "v", detail: null, confidence: "direct" }],
      warnings: [],
    });
    renderModal();
    const dropButtons = await screen.findAllByRole(
      "button",
      { name: t("alterTableDrop") },
      { timeout: 3000 },
    );
    fireEvent.click(dropButtons[1]);
    await screen.findByTestId("drop-column-deps", undefined, { timeout: 3000 });
    fireEvent.click(await screen.findByRole("button", { name: t("alterTableKeep") }));
    await waitFor(() => expect(screen.queryByTestId("drop-column-deps")).toBeNull());
  });

  it("warnings だけのときは不完全タイトルを出す", async () => {
    deps.mockResolvedValue({ dependencies: [], warnings: ["definitions"] });
    renderModal();
    const dropButtons = await screen.findAllByRole(
      "button",
      { name: t("alterTableDrop") },
      { timeout: 3000 },
    );
    fireEvent.click(dropButtons[1]);
    const box = await screen.findByTestId("drop-column-deps", undefined, { timeout: 3000 });
    expect(box.textContent).toContain(t("dropColumnDepsIncompleteTitle"));
    expect(box.textContent).toContain(t("dropColumnWarnDefinitions"));
  });

  it("取得に失敗したらエラー帯を出す", async () => {
    deps.mockRejectedValue("boom");
    renderModal();
    const dropButtons = await screen.findAllByRole(
      "button",
      { name: t("alterTableDrop") },
      { timeout: 3000 },
    );
    fireEvent.click(dropButtons[1]);
    const box = await screen.findByTestId("drop-column-deps-error", undefined, { timeout: 3000 });
    expect(box.textContent).toContain("boom");
  });
});
