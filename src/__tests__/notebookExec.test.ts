import { beforeEach, describe, expect, it, vi } from "vitest";

const runQueryStream = vi.fn();
vi.mock("../api/tauri", () => ({
  api: { runQueryStream: (...a: unknown[]) => runQueryStream(...a), cancelStream: vi.fn() },
  listenQueryStream: vi.fn().mockResolvedValue(() => {}),
}));

import {
  NotebookRunError,
  runNotebookStatements,
  runStatementCollect,
  type NotebookRunIo,
  type NotebookRunOutput,
} from "../notebookExec";

function out(over: Partial<NotebookRunOutput> = {}): NotebookRunOutput {
  return {
    columns: [],
    rows: [],
    totalRows: 0,
    rowsAffected: 0,
    hasColumns: true,
    elapsedMs: 5,
    serverMessages: undefined,
    readOnly: false,
    schemaMayChange: false,
    appliedAutoLimit: null,
    ...over,
  };
}

function makeIo(over: Partial<NotebookRunIo> = {}): NotebookRunIo {
  return {
    gate: vi.fn().mockResolvedValue(true),
    isTransaction: () => false,
    runInTransaction: vi.fn().mockResolvedValue(out()),
    runStream: vi.fn().mockResolvedValue(out()),
    onStatementDone: vi.fn(),
    onStatementError: vi.fn(),
    ...over,
  };
}

describe("runNotebookStatements (#2380)", () => {
  it("ゲートを取りやめたら何も実行せず null", async () => {
    const io = makeIo({ gate: vi.fn().mockResolvedValue(false) });
    const r = await runNotebookStatements(
      "DELETE FROM t",
      ["DELETE FROM t"],
      { onStart: vi.fn(), isCancelled: () => false },
      io,
    );
    expect(r).toBeNull();
    expect(io.runStream).not.toHaveBeenCalled();
  });

  it("複数文の間で中止を見て、続きを実行しない", async () => {
    let cancelled = false;
    const io = makeIo({
      runStream: vi.fn().mockImplementation(async () => {
        cancelled = true;
        return out();
      }),
    });
    await expect(
      runNotebookStatements("a;b", ["a", "b"], { onStart: vi.fn(), isCancelled: () => cancelled }, io),
    ).rejects.toMatchObject({ cancelled: true });
    expect(io.runStream).toHaveBeenCalledTimes(1);
    expect(io.onStatementError).not.toHaveBeenCalled();
  });

  it("トランザクション中は runInTransaction を使う", async () => {
    const io = makeIo({ isTransaction: () => true });
    await runNotebookStatements("a", ["a"], { onStart: vi.fn(), isCancelled: () => false }, io);
    expect(io.runInTransaction).toHaveBeenCalledTimes(1);
    expect(io.runStream).not.toHaveBeenCalled();
  });

  it("経過時間は合算し、結果セットを返した最後の文の結果を返す", async () => {
    const io = makeIo({
      runStream: vi
        .fn()
        .mockResolvedValueOnce(out({ totalRows: 3, elapsedMs: 10 }))
        .mockResolvedValueOnce(out({ hasColumns: false, rowsAffected: 1, elapsedMs: 4 })),
    });
    const r = await runNotebookStatements(
      "a;b",
      ["a", "b"],
      { onStart: vi.fn(), isCancelled: () => false },
      io,
    );
    expect(r?.totalRows).toBe(3);
    expect(r?.elapsedMs).toBe(14);
  });

  it("失敗は onStatementError に通して再送出する", async () => {
    const io = makeIo({
      runStream: vi.fn().mockRejectedValue(new NotebookRunError("boom", false, false, false)),
    });
    await expect(
      runNotebookStatements("a", ["a"], { onStart: vi.fn(), isCancelled: () => false }, io),
    ).rejects.toThrow("boom");
    expect(io.onStatementError).toHaveBeenCalledTimes(1);
  });
});

describe("runStatementCollect (#2380)", () => {
  beforeEach(() => {
    runQueryStream.mockReset();
    runQueryStream.mockResolvedValue(undefined);
  });

  it("フライトレコーダ用の capture と database をそのまま run_query_stream へ渡す", async () => {
    void runStatementCollect({
      sessionId: "s1",
      database: "public",
      sql: "UPDATE t SET a = 1",
      rowCap: 200,
      initialBatch: 100,
      chunkSize: 500,
      autoLimit: null,
      queryTimeoutSecs: null,
      capture: true,
      captureRowCap: 1000,
      captureRetentionDays: 7,
    }).catch(() => {});
    await vi.waitFor(() => expect(runQueryStream).toHaveBeenCalled());
    expect(runQueryStream.mock.calls[0][0]).toMatchObject({
      capture: true,
      database: "public",
      forceReadOnly: false,
    });
  });
});
