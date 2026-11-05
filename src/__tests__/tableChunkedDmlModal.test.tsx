import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      runLookupQuery: vi.fn(),
      runChunkedDmlBatch: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { TableChunkedDmlModal } from "../components/TableChunkedDmlModal";

const lookup = api.runLookupQuery as ReturnType<typeof vi.fn>;
const batch = api.runChunkedDmlBatch as ReturnType<typeof vi.fn>;

const result = (rows_affected: number) => ({ columns: [], rows: [], rows_affected, elapsed_ms: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockResolvedValue({ columns: [], rows: [[2500]], rows_affected: 0, elapsed_ms: 1 });
});

const mount = (props: { readOnly?: boolean; confirm?: boolean } = {}) =>
  renderWithProviders(
    <TableChunkedDmlModal
      sessionId="s1"
      driver="sqlite"
      database="main"
      table="logs"
      readOnly={props.readOnly ?? false}
      onConfirmStart={vi.fn().mockResolvedValue(props.confirm ?? true)}
      onClose={vi.fn()}
    />,
  );

const fill = (where: string) => {
  fireEvent.change(screen.getByLabelText(t("chunkedDmlWhere")), { target: { value: where } });
  fireEvent.change(screen.getByLabelText(t("chunkedDmlBatchSize")), { target: { value: "1000" } });
};

describe("TableChunkedDmlModal (#2020)", () => {
  it("WHERE が空だと実行できず、入力するとバッチ SQL をプレビューする", () => {
    mount();
    expect(screen.getByRole("button", { name: t("chunkedDmlRun") })).toBeDisabled();
    fill("id < 100");
    expect(screen.getByText(/DELETE FROM "logs" WHERE rowid IN/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("chunkedDmlRun") })).toBeEnabled();
  });

  it("コメントで括弧を食わせる条件は理由つきで拒否する", () => {
    mount();
    fill("id < 100 --");
    expect(screen.getByText(t("chunkedDmlErr_comment"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("chunkedDmlRun") })).toBeDisabled();
  });

  it("0 行になるまでバッチを繰り返し、進捗と完了を出す", async () => {
    batch
      .mockResolvedValueOnce(result(1000))
      .mockResolvedValueOnce(result(1000))
      .mockResolvedValueOnce(result(500))
      .mockResolvedValueOnce(result(0));
    mount();
    fill("id < 100");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlDone", { batches: 4, rows: 2500 }))).toBeInTheDocument(),
    );
    expect(batch).toHaveBeenCalledTimes(4);
    expect(batch).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "logs",
        operation: { kind: "delete" },
        whereClause: "id < 100",
        batchSize: 1000,
      }),
    );
  });

  it("確認で断ると何も実行しない", async () => {
    mount({ confirm: false });
    fill("id < 100");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lookup).not.toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining('COUNT(*) FROM "logs" WHERE (id < 100)') }),
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("中断すると次のバッチを撃たずに止まる", async () => {
    let release: (v: unknown) => void = () => {};
    batch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    mount();
    fill("id < 100");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    const stop = await screen.findByRole("button", { name: t("chunkedDmlStop") });
    fireEvent.click(stop);
    release(result(1000));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlCancelled", { batches: 1, rows: 1000 }))).toBeInTheDocument(),
    );
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("UPDATE が同じ行に当たり続けても最大バッチ数で止まる", async () => {
    lookup.mockResolvedValue({ columns: [], rows: [[10]], rows_affected: 0, elapsed_ms: 1 });
    batch.mockResolvedValue(result(10));
    mount();
    fireEvent.click(screen.getByText(t("chunkedDmlOpUpdate")));
    fireEvent.change(screen.getByLabelText(t("chunkedDmlSet")), { target: { value: "n = n + 1" } });
    fill("n >= 0");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    // 10 行 / 1000 = 1 バッチ想定 → 上限は 1*2+3 = 5
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlLimitReached", { limit: 5, rows: 50 }))).toBeInTheDocument(),
    );
    expect(batch).toHaveBeenCalledTimes(5);
  });

  it("read_only 接続では実行を無効化する", () => {
    mount({ readOnly: true });
    fill("id < 100");
    expect(screen.getByText(t("chunkedDmlReadOnly"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("chunkedDmlRun") })).toBeDisabled();
  });
});
