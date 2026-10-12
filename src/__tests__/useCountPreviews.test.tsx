import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "./testUtils";
import type { QueryResult } from "../api/tauri";

import { COUNT_PREVIEW_DEBOUNCE_MS, parseCountCell, useCountPreviews } from "../useCountPreviews";

const run = vi.fn<(sql: string) => Promise<QueryResult>>();
function result(cell: unknown): QueryResult {
  return { columns: [], rows: [[cell]], rows_affected: 0, elapsed_ms: 1, server_messages: [] } as unknown as QueryResult;
}

beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parseCountCell", () => {
  it("数値・数字文字列を数え、それ以外は null", () => {
    expect(parseCountCell(3)).toBe(3);
    expect(parseCountCell("12")).toBe(12);
    expect(parseCountCell(null)).toBeNull();
    expect(parseCountCell("abc")).toBeNull();
  });
});

describe("useCountPreviews (#1536)", () => {
  it("デバウンスの後に 1 回だけ読み取り専用の件数クエリを発行する", async () => {
    run.mockResolvedValue(result(4));
    const items = [{ id: "a", sql: "SELECT COUNT(*) FROM t" }];
    const { result: hook } = renderHook(() => useCountPreviews(run, items));
    expect(hook.current.a).toEqual({ status: "loading" });
    expect(run).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("SELECT COUNT(*) FROM t");
    expect(hook.current.a).toEqual({ status: "ok", count: 4 });
  });

  it("入力が変わり続けている間は発行せず、最後の SQL だけを発行する", async () => {
    run.mockResolvedValue(result(0));
    const { rerender } = renderHook(
      ({ sql }: { sql: string }) => useCountPreviews(run, [{ id: "a", sql }]),
      { initialProps: { sql: "SELECT COUNT(*) FROM t WHERE a" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS - 100);
    });
    rerender({ sql: "SELECT COUNT(*) FROM t WHERE ab" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS - 100);
    });
    expect(run).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("SELECT COUNT(*) FROM t WHERE ab");
  });

  it("失敗は error 状態になり、enabled=false・run なし・空なら何も発行しない", async () => {
    run.mockRejectedValue(new Error("boom"));
    const items = [{ id: "a", sql: "SELECT COUNT(*) FROM t" }];
    const { result: hook } = renderHook(() => useCountPreviews(run, items));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(hook.current.a.status).toBe("error");

    run.mockClear();
    renderHook(() => useCountPreviews(run, items, false));
    renderHook(() => useCountPreviews(run, []));
    renderHook(() => useCountPreviews(null, items));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(run).not.toHaveBeenCalled();
  });
});
