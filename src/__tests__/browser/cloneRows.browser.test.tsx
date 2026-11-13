// 行を子レコードごと複製するモーダル (#2304)。実 Chromium で、方針が足りない間は実行できず、
// 方針を足して取り直したプレビューが ready になると実行でき、完了後に対応表が出ることを固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { renderInBrowser } from "./render";
import { installTauriMock, invocationsOf, onCommand } from "./tauriMock";
import { CloneRowsModal } from "../../components/CloneRowsModal";
import { t } from "../../i18n";

afterEach(async () => {
  await cleanup();
});

const table = (over: Record<string, unknown>) => ({
  table: "orders",
  rows: 1,
  rootRows: 1,
  childRows: 0,
  columns: [
    { name: "id", key: true },
    { name: "order_no", key: false },
  ],
  keyColumns: [{ name: "id", status: "auto" }],
  needsPolicy: false,
  conflicts: [{ index: "uq_no", columns: ["order_no"], rows: 1 }],
  ...over,
});
const preview = (ready: boolean, conflicts: unknown[]) => ({
  tables: [
    table({ conflicts }),
    table({ table: "order_items", rows: 2, rootRows: 0, childRows: 2, conflicts: [] }),
  ],
  totalRows: 3,
  cycles: [],
  warnings: [],
  ready,
});

beforeEach(() => {
  installTauriMock();
  onCommand("preview_clone_rows", (args) => {
    const rules = (args as { rules: unknown[] }).rules;
    return rules.length === 0
      ? preview(false, [{ index: "uq_no", columns: ["order_no"], rows: 1 }])
      : preview(true, []);
  });
  onCommand("clone_rows", () => ({
    tables: [
      { table: "orders", rows: 1, keyColumns: ["id"], mappings: [{ oldKey: [1], newKey: [3], root: true }] },
      {
        table: "order_items",
        rows: 2,
        keyColumns: ["id"],
        mappings: [{ oldKey: [1], newKey: [6], root: false }],
      },
    ],
    totalRows: 3,
    rootTable: "orders",
    rootKeyColumns: ["id"],
    rootNewKeys: [[3]],
    recorded: 2,
    declined: 0,
    batchId: "b1",
    warnings: [],
  }));
});

function render() {
  return renderInBrowser(
    <CloneRowsModal
      sessionId="s1"
      database="app"
      table="orders"
      whereClause="id IN (1)"
      rootLimit={1}
      profile={null}
      onOpenTable={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("CloneRowsModal", () => {
  it("blocks on a unique conflict, runs after an override, and shows the key mapping", async () => {
    const screen = await render();
    await expect.element(screen.getByTestId("clone-preview")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          t("cloneRowsBlockConflict", { table: "orders", index: "uq_no", columns: "order_no", rows: 1 }),
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: t("cloneRowsExecute") })).toBeDisabled();

    await screen.getByRole("combobox", { name: t("cloneRowsRuleColumn") }).click();
    await screen.getByRole("option", { name: "order_no" }).click();
    await screen.getByLabelText(t("cloneRowsRuleValue")).fill("{old} || '-copy'");
    await screen.getByRole("button", { name: t("cloneRowsRuleAdd") }).click();
    await expect.element(screen.getByTestId("clone-rule")).toBeVisible();
    // 方針を変えたら取り直すまで実行できない。
    await expect.element(screen.getByRole("button", { name: t("cloneRowsExecute") })).toBeDisabled();
    await screen.getByRole("button", { name: t("cloneRowsPreviewButton") }).click();
    await vi.waitFor(() => expect(invocationsOf("preview_clone_rows").length).toBe(2));
    await expect.element(screen.getByRole("button", { name: t("cloneRowsExecute") })).toBeEnabled();

    await screen.getByRole("button", { name: t("cloneRowsExecute") }).click();
    await expect.element(screen.getByTestId("clone-outcome")).toBeVisible();
    await expect.element(screen.getByText("1 → 3 *")).toBeVisible();
    expect(invocationsOf("clone_rows").length).toBe(1);
  });
});
