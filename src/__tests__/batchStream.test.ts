import { beforeEach, describe, expect, it, vi } from "vitest";

// エディタのバッチ実行 (`run_sql_batch`, #1256) の IPC ラッパー。Tauri の Channel /
// invoke をモックして、(1) `listenBatchStream` が作った Channel を `onEvent` として
// invoke へ渡す、(2) Channel に届いた `kind` ごとのメッセージをハンドラへ振り分ける、
// (3) listen 前の呼び出しは早期に落とす、を確認する。
const { FakeChannel } = vi.hoisted(() => ({
  FakeChannel: class {
    onmessage: (msg: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: FakeChannel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { api, listenBatchStream } from "../api/tauri";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

const params = {
  sessionId: "s1",
  streamId: "strm1",
  database: "appdb",
  sql: "SELECT 1; SELECT 2",
  stopOnError: true,
  previewRows: 200,
};

describe("api.runSqlBatch / listenBatchStream", () => {
  it("listenBatchStream より前に呼ぶと早期に例外を投げる", () => {
    expect(() => api.runSqlBatch({ ...params, streamId: "never-listened" })).toThrow(
      /listenBatchStream/,
    );
  });

  it("listen した Channel を onEvent として run_sql_batch へ渡す", async () => {
    await listenBatchStream("strm1", {});
    await api.runSqlBatch(params);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("run_sql_batch");
    expect(args).toMatchObject({
      sessionId: "s1",
      streamId: "strm1",
      database: "appdb",
      sql: "SELECT 1; SELECT 2",
      stopOnError: true,
      previewRows: 200,
    });
    expect(args.onEvent).toBeInstanceOf(FakeChannel);
  });

  it("kind ごとにハンドラへ振り分け、未知の kind は無視する", async () => {
    const handlers = {
      onStarted: vi.fn(),
      onResults: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onCancelled: vi.fn(),
    };
    await listenBatchStream("strm2", handlers);
    await api.runSqlBatch({ ...params, streamId: "strm2" });
    const channel = (mockInvoke.mock.calls[0][1] as { onEvent: InstanceType<typeof FakeChannel> }).onEvent;

    channel.onmessage({ kind: "started", total: 3 });
    channel.onmessage({
      kind: "results",
      results: [{ sql: "SELECT 1", status: "ok", columns: [{ name: "a", type_name: "INT" }], rows: [[1]] }],
    });
    channel.onmessage({ kind: "done", ok: 1, errors: 0, skipped: 0, elapsedMs: 4 });
    channel.onmessage({ kind: "error", error: "boom", connectionLost: true });
    channel.onmessage({ kind: "cancelled", deliveredStatements: 2 });
    channel.onmessage({ kind: "from-the-future" });

    expect(handlers.onStarted).toHaveBeenCalledWith({ kind: "started", total: 3 });
    expect(handlers.onResults).toHaveBeenCalledTimes(1);
    expect(handlers.onResults.mock.calls[0][0].results[0].sql).toBe("SELECT 1");
    expect(handlers.onDone).toHaveBeenCalledWith({ kind: "done", ok: 1, errors: 0, skipped: 0, elapsedMs: 4 });
    expect(handlers.onError).toHaveBeenCalledWith({ kind: "error", error: "boom", connectionLost: true });
    expect(handlers.onCancelled).toHaveBeenCalledWith({ kind: "cancelled", deliveredStatements: 2 });
  });

  it("detach 後に届いたメッセージはハンドラへ届かない", async () => {
    const onDone = vi.fn();
    const detach = await listenBatchStream("strm3", { onDone });
    await api.runSqlBatch({ ...params, streamId: "strm3" });
    const channel = (mockInvoke.mock.calls[0][1] as { onEvent: InstanceType<typeof FakeChannel> }).onEvent;
    detach();
    channel.onmessage({ kind: "done", ok: 0, errors: 0, skipped: 0, elapsedMs: 0 });
    expect(onDone).not.toHaveBeenCalled();
    // detach でレジストリからも消えるので、再度 listen せずには呼べない。
    expect(() => api.runSqlBatch({ ...params, streamId: "strm3" })).toThrow();
  });
});

describe("api.getHistorySql / listHistorySql (#1256)", () => {
  it("get_history_sql は id を渡して全文を返す", async () => {
    mockInvoke.mockResolvedValueOnce("SELECT *\n  FROM t");
    await expect(api.getHistorySql(9)).resolves.toBe("SELECT *\n  FROM t");
    expect(mockInvoke).toHaveBeenCalledWith("get_history_sql", { id: 9 });
  });

  it("list_history_sql は profileId / limit を渡して SQL の配列を返す", async () => {
    mockInvoke.mockResolvedValueOnce(["SELECT 2", "SELECT 1"]);
    await expect(api.listHistorySql({ profileId: "p1", limit: 100 })).resolves.toEqual([
      "SELECT 2",
      "SELECT 1",
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("list_history_sql", { profileId: "p1", limit: 100 });
  });
});
