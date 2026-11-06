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
      describeTable: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { TableChunkedDmlModal } from "../components/TableChunkedDmlModal";

const lookup = api.runLookupQuery as ReturnType<typeof vi.fn>;
const batch = api.runChunkedDmlBatch as ReturnType<typeof vi.fn>;
const describe_ = api.describeTable as ReturnType<typeof vi.fn>;

const result = (rows_affected: number) => ({
  rows_affected,
  elapsed_ms: 1,
  recorded: false,
  capture_note: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  batch.mockReset();
  lookup.mockReset();
  describe_.mockReset();
  describe_.mockResolvedValue([{ name: "id" }]);
  lookup.mockResolvedValue({ columns: [], rows: [[2500]], rows_affected: 0, elapsed_ms: 1 });
});

const mount = (props: { readOnly?: boolean; confirm?: boolean; production?: boolean } = {}) =>
  renderWithProviders(
    <TableChunkedDmlModal
      sessionId="s1"
      driver="sqlite"
      database="main"
      table="logs"
      readOnly={props.readOnly ?? false}
      isProduction={props.production ?? false}
      capture={null}
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

  it("SQLite で rowid が実列に隠された表は _rowid_ でプレビューする", async () => {
    describe_.mockResolvedValue([{ name: "rowid" }, { name: "v" }]);
    mount();
    fill("v = 1");
    await waitFor(() =>
      expect(screen.getByText(/WHERE _rowid_ IN \(SELECT _rowid_ FROM/)).toBeInTheDocument(),
    );
  });

  it("コメントで括弧を食わせる条件は理由つきで拒否する", () => {
    mount();
    fill("id < 100 --");
    expect(screen.getByText(t("chunkedDmlErr_comment"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("chunkedDmlRun") })).toBeDisabled();
  });

  it("DELETE はバッチサイズ未満で終了し、完了と残り件数の警告を出す", async () => {
    batch
      .mockResolvedValueOnce(result(1000))
      .mockResolvedValueOnce(result(1000))
      .mockResolvedValueOnce(result(500))
      .mockResolvedValueOnce(result(0));
    mount();
    fill("id < 100");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlDone", { batches: 3, rows: 2500 }))).toBeInTheDocument(),
    );
    expect(batch).toHaveBeenCalledTimes(3);
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

  it("UPDATE の最初のバッチ後に件数が減っていなければ止める", async () => {
    lookup.mockResolvedValue({ columns: [], rows: [[10]], rows_affected: 0, elapsed_ms: 1 });
    batch.mockResolvedValue(result(10));
    mount();
    fireEvent.click(screen.getByText(t("chunkedDmlOpUpdate")));
    fireEvent.change(screen.getByLabelText(t("chunkedDmlSet")), { target: { value: "n = n + 1" } });
    fill("n >= 0");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlStalled", { rows: 10, affected: 10 }))).toBeInTheDocument(),
    );
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("件数が減り続けても最大バッチ数で止まる", async () => {
    lookup
      .mockResolvedValueOnce({ columns: [], rows: [[20]], rows_affected: 0, elapsed_ms: 1 })
      .mockResolvedValue({ columns: [], rows: [[10]], rows_affected: 0, elapsed_ms: 1 });
    batch.mockResolvedValue(result(10));
    mount();
    fireEvent.click(screen.getByText(t("chunkedDmlOpUpdate")));
    fireEvent.change(screen.getByLabelText(t("chunkedDmlSet")), { target: { value: "n = n + 1" } });
    fill("n >= 0");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlLimitReached", { limit: 5, rows: 50 }))).toBeInTheDocument(),
    );
    expect(batch).toHaveBeenCalledTimes(5);
  });

  it("本番では件数を自動で数えず、ボタンで数える", async () => {
    mount({ production: true });
    fill("id < 100");
    await new Promise((r) => setTimeout(r, 700));
    expect(lookup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlCountNow") }));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlRowsMatching", { rows: 2500 }))).toBeInTheDocument(),
    );
  });

  it("開始前の件数取得中は二重に開始できず、閉じたら確認も実行もしない", async () => {
    let resolveCount: () => void = () => {};
    lookup.mockImplementation(
      () =>
        new Promise((r) => {
          resolveCount = () => r({ columns: [], rows: [[10]], rows_affected: 0, elapsed_ms: 1 });
        }),
    );
    const confirm = vi.fn().mockResolvedValue(true);
    const { unmount } = renderWithProviders(
      <TableChunkedDmlModal
        sessionId="s1"
        driver="sqlite"
        database="main"
        table="logs"
        readOnly={false}
        isProduction={true}
        capture={null}
        onConfirmStart={confirm}
        onClose={vi.fn()}
      />,
    );
    fill("id < 100");
    const run = screen.getByRole("button", { name: t("chunkedDmlRun") });
    fireEvent.click(run);
    await waitFor(() => expect(run).toBeDisabled());
    fireEvent.click(run);
    expect(lookup).toHaveBeenCalledTimes(1);
    unmount();
    resolveCount();
    await new Promise((r) => setTimeout(r, 0));
    expect(confirm).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("進捗バー・StatTile・完了時の意味色と Callout を出す (#2092)", async () => {
    batch
      .mockResolvedValueOnce(result(1000))
      .mockResolvedValueOnce(result(500))
      .mockResolvedValueOnce(result(0));
    // 開始前は 1500 件、バッチ実行後の数え直しは 0 件。
    lookup.mockImplementation(async () => ({
      columns: [],
      rows: [[batch.mock.calls.length === 0 ? 1500 : 0]],
      rows_affected: 0,
      elapsed_ms: 1,
    }));
    mount();
    fill("id < 100");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlDone", { batches: 2, rows: 1500 }))).toBeInTheDocument(),
    );
    const stats = screen.getByTestId("chunked-dml-stats");
    for (const k of [
      "chunkedDmlStatBatches",
      "chunkedDmlStatRows",
      "chunkedDmlStatRemaining",
      "chunkedDmlStatElapsed",
    ] as const) {
      expect(stats).toHaveTextContent(t(k));
    }
    expect(screen.getByTestId("chunked-dml-progress")).toHaveTextContent(
      t("progressPercent", { percent: 100 }),
    );
    const fill_ = screen
      .getByTestId("chunked-dml-progress")
      .querySelector("[aria-hidden] > div") as HTMLElement;
    expect(fill_.style.background).toContain("--success-solid");
  });

  it("中断するとバーを警告色で止める (#2092)", async () => {
    let release: (v: unknown) => void = () => {};
    batch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    mount();
    fill("id < 100");
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    fireEvent.click(await screen.findByRole("button", { name: t("chunkedDmlStop") }));
    release(result(1000));
    await waitFor(() =>
      expect(screen.getByText(t("chunkedDmlCancelled", { batches: 1, rows: 1000 }))).toBeInTheDocument(),
    );
    const fill_ = screen
      .getByTestId("chunked-dml-progress")
      .querySelector("[aria-hidden] > div") as HTMLElement;
    expect(fill_.style.background).toContain("--warning-solid");
    expect(screen.getByTestId("chunked-dml-progress")).toHaveTextContent(
      t("progressPercent", { percent: 40 }),
    );
  });

  it("バッチ間のスロットル待機中は次のバッチまでの秒数を出す (#2092)", async () => {
    let release: () => void = () => {};
    batch
      .mockResolvedValueOnce(result(1000))
      .mockImplementationOnce(() => new Promise((r) => (release = () => r(result(0)))));
    mount();
    fill("id < 100");
    fireEvent.change(screen.getByLabelText(t("chunkedDmlWait")), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlRun") }));
    const waiting = await screen.findByTestId("chunked-dml-waiting");
    expect(waiting).toHaveTextContent(t("chunkedDmlWaiting", { secs: 3 }));
    await waitFor(
      () =>
        expect(screen.getByTestId("chunked-dml-waiting")).toHaveTextContent(
          t("chunkedDmlWaiting", { secs: 2 }),
        ),
      {
        timeout: 2000,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: t("chunkedDmlStop") }));
    await waitFor(() => expect(screen.queryByTestId("chunked-dml-waiting")).not.toBeInTheDocument());
    release();
  });

  it("read_only 接続では実行を無効化する", () => {
    mount({ readOnly: true });
    fill("id < 100");
    expect(screen.getByText(t("chunkedDmlReadOnly"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("chunkedDmlRun") })).toBeDisabled();
  });
});
