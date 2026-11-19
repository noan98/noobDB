import { beforeEach, describe, expect, it, vi } from "vitest";

type Handlers = {
  onColumns?: (m: unknown) => void;
  onRows?: (m: unknown) => void;
  onDone?: (m: unknown) => void;
  onError?: (m: unknown) => void;
};
const handlersById = new Map<string, Handlers>();
const runQueryStream = vi.fn();
const cancelStream = vi.fn();
vi.mock("../api/tauri", () => ({
  api: {
    runQueryStream: (...a: unknown[]) => runQueryStream(...a),
    cancelStream: (...a: unknown[]) => cancelStream(...a),
  },
  listenQueryStream: vi.fn(async (id: string, h: Handlers) => {
    handlersById.set(id, h);
    return () => {};
  }),
}));

import { FK_PEEK_TIMEOUT_SECS, runPeekQuery } from "../fkPeekRun";

const flush = () => new Promise((r) => setTimeout(r, 0));
const doneMsg = { rowsAffected: 0, elapsedMs: 1, serverMessages: undefined };

beforeEach(() => {
  handlersById.clear();
  runQueryStream.mockReset().mockResolvedValue(undefined);
  cancelStream.mockReset().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
});

describe("runPeekQuery (#2444)", () => {
  it("短いタイムアウト・読み取り専用・履歴なしで流し、行を QueryResult にまとめる", async () => {
    const p = runPeekQuery({ sessionId: "s", database: "d", sql: "SELECT 1" });
    await flush();
    const arg = runQueryStream.mock.calls[0][0];
    expect(arg.queryTimeoutSecs).toBe(FK_PEEK_TIMEOUT_SECS);
    expect(arg.queryTimeoutSecs).toBeGreaterThan(0);
    expect(arg.autoRefresh).toBe(true);
    const h = handlersById.get(arg.streamId);
    h?.onColumns?.({ columns: [{ name: "a" }] });
    h?.onRows?.({ rows: [[1]] });
    h?.onDone?.(doneMsg);
    const r = await p;
    expect(r.columns).toEqual([{ name: "a" }]);
    expect(r.rows).toEqual([[1]]);
  });

  it("signal の abort でサーバ側の取得を cancelStream で止める", async () => {
    const ac = new AbortController();
    const p = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 1", signal: ac.signal });
    const settled = p.catch((e) => e);
    await flush();
    const id = runQueryStream.mock.calls[0][0].streamId;
    ac.abort();
    expect(String(await settled)).toContain("cancelled");
    expect(cancelStream).toHaveBeenCalledWith(id);
  });

  it("同時に走る取得は 1 本まで: 新しい取得は前を中止してから始まる", async () => {
    let active = 0;
    let maxActive = 0;
    runQueryStream.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    });
    // 前の取得は cancel されたらサーバ側で止まった扱いにする。
    cancelStream.mockImplementation(async () => {
      active -= 1;
      return { cancelled: true, deliveredRows: 0 };
    });
    const first = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 1" }).catch((e) => e);
    await flush();
    const second = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 2" });
    await flush();
    expect(String(await first)).toContain("cancelled");
    expect(runQueryStream).toHaveBeenCalledTimes(2);
    expect(cancelStream).toHaveBeenCalledTimes(1);
    const id2 = runQueryStream.mock.calls[1][0].streamId;
    handlersById.get(id2)?.onDone?.(doneMsg);
    await second;
    expect(maxActive).toBe(1);
  });

  it("実行前に abort 済みなら何も流さない", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 1", signal: ac.signal }),
    ).rejects.toThrow("cancelled");
    expect(runQueryStream).not.toHaveBeenCalled();
  });

  it("タイムアウト等のエラーは reject する", async () => {
    const p = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 1" }).catch((e) => e);
    await flush();
    const id = runQueryStream.mock.calls[0][0].streamId;
    handlersById.get(id)?.onError?.({ error: "timed out", timedOut: true });
    expect((await p).message).toBe("timed out");
  });

  it("signal で先に中止した直後に次を呼んでも、cancelStream が解決するまで runQueryStream は呼ばれない", async () => {
    let release: () => void = () => {};
    cancelStream.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ cancelled: true, deliveredRows: 0 });
        }),
    );
    const ac = new AbortController();
    const first = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 1", signal: ac.signal }).catch(
      (e) => e,
    );
    await flush();
    ac.abort(); // カードのクリーンアップ
    const second = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 2" });
    await flush();
    expect(runQueryStream).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(runQueryStream).toHaveBeenCalledTimes(2);
    handlersById.get(runQueryStream.mock.calls[1][0].streamId)?.onDone?.(doneMsg);
    await second;
    expect((await first) instanceof Error).toBe(true);
  });

  it("3 本が重なっても同時に走るのは 1 本まで", async () => {
    let active = 0;
    let maxActive = 0;
    runQueryStream.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    });
    cancelStream.mockImplementation(async () => {
      await flush();
      active = Math.max(0, active - 1);
      return { cancelled: true, deliveredRows: 0 };
    });
    const a = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 1" }).catch((e) => e);
    await flush();
    const b = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 2" }).catch((e) => e);
    const c = runPeekQuery({ sessionId: "s", database: null, sql: "SELECT 3" });
    for (let i = 0; i < 10; i++) await flush();
    // 生き残るのは最後の 1 本だけ。
    const last = runQueryStream.mock.calls.at(-1)?.[0].streamId;
    expect(last).toBeDefined();
    handlersById.get(last)?.onDone?.(doneMsg);
    await c;
    expect(String(await a)).toContain("cancelled");
    expect(String(await b)).toContain("cancelled");
    expect(maxActive).toBe(1);
  });
});
