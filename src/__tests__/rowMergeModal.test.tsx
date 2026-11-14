import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { RowMergePreview } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, previewRowMerge: vi.fn(), applyRowMerge: vi.fn() } };
});

import { RowMergeModal } from "../components/RowMergeModal";
import { distinctValueCount } from "../components/RowMergeMatrix";
import { api } from "../api/tauri";

const preview: RowMergePreview = {
  columns: [
    { name: "id", typeName: "int", locked: true, generated: false },
    { name: "phone", typeName: "text", locked: false, generated: false },
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
    // プレビューで見せた計画 (文と子ごとの件数) を添える。
    expect(vi.mocked(api.applyRowMerge).mock.calls[0][0].request.expected).toEqual({
      statements: preview.statements,
      childRows: [2],
    });
  });

  it("プレビュー後にデータが変わっていたら、プレビューを読み直して理由を示す", async () => {
    vi.mocked(api.applyRowMerge).mockResolvedValue({
      status: "changed",
      expectedRows: 2,
      actualRows: 3,
      statementsChanged: false,
    });
    const props = mount();
    await screen.findByTestId("row-merge-tree");
    expect(vi.mocked(api.previewRowMerge)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: t("rowMergeRun") }));
    await waitFor(() => expect(vi.mocked(api.previewRowMerge)).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/データが変わりました|data changed/)).toBeInTheDocument();
    expect(props.onApplied).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
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

  it("食い違う列を強調し、同じ値の列は隠せる (#2322)", async () => {
    mount();
    await screen.findByTestId("row-merge-matrix");
    expect(screen.getByTestId("row-merge-row-phone")).toHaveAttribute("data-differs", "true");
    expect(screen.getByTestId("row-merge-badge-phone")).toBeInTheDocument();
    // 鍵付きの列 (id) は食い違っていても警告せず、鍵アイコンだけの中立表示。
    expect(screen.getByTestId("row-merge-locked-id")).toBeInTheDocument();
    expect(screen.getByTestId("row-merge-row-id")).toHaveAttribute("data-differs", "false");
    expect(screen.queryByTestId("row-merge-badge-id")).toBeNull();
    expect(screen.getByTestId("row-merge-diff-count")).toHaveTextContent(
      t("rowMergeDiffSummary", { diff: 1, total: 2 }),
    );
  });

  it("生成列はマージ後の行で古い値ではなく「再計算」と出す (#2322)", async () => {
    vi.mocked(api.previewRowMerge).mockResolvedValue({
      ...preview,
      columns: [...preview.columns, { name: "total", typeName: "int", locked: true, generated: true }],
      rows: [
        [1, null, 10],
        [2, "555", 20],
      ],
      picks: [0, 1, 0],
    });
    mount();
    await screen.findByTestId("row-merge-row-total");
    expect(screen.getByTestId("row-merge-recomputed-total")).toHaveTextContent(t("rowMergeRecomputed"));
    expect(screen.getByTestId("row-merge-result-total")).not.toHaveTextContent("10");
    expect(screen.queryByTestId("row-merge-recomputed-phone")).toBeNull();
  });

  it("同じ値の列を折りたためる (#2322)", async () => {
    vi.mocked(api.previewRowMerge).mockResolvedValue({
      ...preview,
      columns: [...preview.columns, { name: "country", typeName: "text", locked: false, generated: false }],
      rows: [
        [1, null, "JP"],
        [2, "555", "JP"],
      ],
      picks: [0, 1, 0],
    });
    mount();
    await screen.findByTestId("row-merge-row-country");
    expect(screen.getByTestId("row-merge-row-country")).toHaveAttribute("data-differs", "false");
    fireEvent.click(screen.getByTestId("row-merge-hide-same"));
    expect(screen.queryByTestId("row-merge-row-country")).toBeNull();
    expect(screen.queryByTestId("row-merge-row-id")).toBeNull();
    expect(screen.getByTestId("row-merge-row-phone")).toBeInTheDocument();
  });

  it("マージ後の行に選んだ値と採用元が出て、選び直すと更新される (#2322)", async () => {
    mount();
    const result = await screen.findByTestId("row-merge-result-phone");
    expect(result).toHaveTextContent("555");
    expect(screen.getByTestId("row-merge-source-phone")).toHaveTextContent("2");
    vi.mocked(api.previewRowMerge).mockResolvedValue({ ...preview, picks: [0, 0] });
    fireEvent.click(screen.getByTestId("row-merge-cell-phone-0"));
    await waitFor(() => expect(screen.getByTestId("row-merge-result-phone")).toHaveTextContent("NULL"));
  });

  it("残す行は keep、重複行は remove として見出しで区別される (#2322)", async () => {
    mount();
    await screen.findByTestId("row-merge-matrix");
    expect(screen.getByTestId("row-merge-head-0")).toHaveAttribute("data-role", "keep");
    expect(screen.getByTestId("row-merge-head-1")).toHaveAttribute("data-role", "remove");
  });

  it("distinctValueCount は NULL と文字列 NULL を区別し、全件同値なら 1 (#2322)", () => {
    expect(distinctValueCount([null, "NULL"])).toBe(2);
    expect(distinctValueCount(["a", "a", "a"])).toBe(1);
    expect(distinctValueCount([null, null])).toBe(1);
    expect(distinctValueCount([1, "1"])).toBe(1);
  });
});
