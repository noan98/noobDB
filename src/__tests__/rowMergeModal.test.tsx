import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { RowMergePreview } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, previewRowMerge: vi.fn(), applyRowMerge: vi.fn() } };
});

import { RowMergeModal } from "../components/RowMergeModal";
import { api } from "../api/tauri";

const preview: RowMergePreview = {
  columns: [
    { name: "id", typeName: "int", locked: true },
    { name: "phone", typeName: "text", locked: false },
  ],
  rows: [
    [1, null],
    [2, "555"],
  ],
  picks: [0, 1],
  keyColumns: ["id"],
  children: [
    {
      schema: null,
      table: "orders",
      constraint: "fk",
      columns: ["customer_id"],
      parentColumns: ["id"],
      onDelete: "CASCADE",
      rows: 2,
      skipped: 0,
      deleted: 0,
      selfReference: false,
    },
  ],
  conflicts: [],
  statements: [
    "UPDATE orders SET customer_id = 1 WHERE customer_id = 2",
    "DELETE FROM customers WHERE id = 2",
  ],
  blockers: [],
  warnings: [],
  fkEnforced: null,
  repointedRows: 2,
  deletedRows: 1,
  undoDecline: null,
};

function mount(over: Partial<React.ComponentProps<typeof RowMergeModal>> = {}) {
  const props = {
    sessionId: "s",
    driver: "postgres",
    database: "public",
    table: "customers",
    target: { keyColumns: ["id"], keys: [[1], [2]] },
    readOnly: false,
    capture: null,
    onConfirm: vi.fn().mockResolvedValue(true),
    onApplied: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  renderWithProviders(<RowMergeModal {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(api.previewRowMerge).mockReset().mockResolvedValue(preview);
  vi.mocked(api.applyRowMerge).mockReset();
});

describe("RowMergeModal (#2303)", () => {
  it("子テーブルの付け替えを影響ツリーで示し、SQL を出す", async () => {
    mount();
    expect(await screen.findByTestId("row-merge-child-orders")).toHaveTextContent("orders.customer_id");
    expect(screen.getByTestId("row-merge-tree")).toBeInTheDocument();
    expect(document.body.textContent).toContain("DELETE FROM customers");
  });

  it("確認を通ったら実行し、完了を通知して閉じる", async () => {
    vi.mocked(api.applyRowMerge).mockResolvedValue({
      status: "applied",
      repointedRows: 2,
      deletedRows: 1,
      capture: { recorded: 0, declined: 0, batchId: null },
    });
    const props = mount();
    await screen.findByTestId("row-merge-tree");
    fireEvent.click(screen.getByRole("button", { name: t("rowMergeRun") }));
    await waitFor(() => expect(props.onApplied).toHaveBeenCalled());
    expect(props.onConfirm).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
    // 列の採用元は提案値 (phone = 重複行) をそのまま送る。
    expect(vi.mocked(api.applyRowMerge).mock.calls[0][0].request.picks).toEqual([
      { column: "phone", fromRow: 1 },
    ]);
  });

  it("確認で断ったら実行しない。衝突などの blockers があれば実行を無効にする", async () => {
    const props = mount({ onConfirm: vi.fn().mockResolvedValue(false) });
    await screen.findByTestId("row-merge-tree");
    fireEvent.click(screen.getByRole("button", { name: t("rowMergeRun") }));
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalled());
    expect(api.applyRowMerge).not.toHaveBeenCalled();
  });

  it("blockers があると実行ボタンが無効で理由を示す", async () => {
    vi.mocked(api.previewRowMerge).mockResolvedValue({
      ...preview,
      blockers: [{ kind: "uniqueConflict", table: "coupon_uses", index: "PRIMARY", groups: 1 }],
    });
    mount();
    expect(await screen.findByTestId("row-merge-blockers")).toHaveTextContent("coupon_uses");
    expect(screen.getByRole("button", { name: t("rowMergeRun") })).toBeDisabled();
  });
});
