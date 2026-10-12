import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "./testUtils";
import type { QueryResult } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, runLookupQuery: vi.fn() } };
});

import { api } from "../api/tauri";
import { COUNT_PREVIEW_DEBOUNCE_MS, parseCountCell, useCountPreviews } from "../useCountPreviews";

function result(cell: unknown): QueryResult {
  return { columns: [], rows: [[cell]], rows_affected: 0, elapsed_ms: 1, server_messages: [] } as unknown as QueryResult;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.runLookupQuery).mockReset();
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
    vi.mocked(api.runLookupQuery).mockResolvedValue(result(4));
    const items = [{ id: "a", sql: "SELECT COUNT(*) FROM t" }];
    const { result: hook } = renderHook(() => useCountPreviews("s1", "db", items));
    expect(hook.current.a).toEqual({ status: "loading" });
    expect(api.runLookupQuery).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(api.runLookupQuery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.runLookupQuery).mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      sql: "SELECT COUNT(*) FROM t",
      database: "db",
    });
    expect(hook.current.a).toEqual({ status: "ok", count: 4 });
  });

  it("入力が変わり続けている間は発行せず、最後の SQL だけを発行する", async () => {
    vi.mocked(api.runLookupQuery).mockResolvedValue(result(0));
    const { rerender } = renderHook(
      ({ sql }: { sql: string }) => useCountPreviews("s1", null, [{ id: "a", sql }]),
      { initialProps: { sql: "SELECT COUNT(*) FROM t WHERE a" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS - 100);
    });
    rerender({ sql: "SELECT COUNT(*) FROM t WHERE ab" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS - 100);
    });
    expect(api.runLookupQuery).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(api.runLookupQuery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.runLookupQuery).mock.calls[0][0].sql).toBe("SELECT COUNT(*) FROM t WHERE ab");
  });

  it("失敗は error 状態になり、enabled=false や空なら何も発行しない", async () => {
    vi.mocked(api.runLookupQuery).mockRejectedValue(new Error("boom"));
    const items = [{ id: "a", sql: "SELECT COUNT(*) FROM t" }];
    const { result: hook } = renderHook(() => useCountPreviews("s1", null, items));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(hook.current.a.status).toBe("error");

    vi.mocked(api.runLookupQuery).mockClear();
    renderHook(() => useCountPreviews("s1", null, items, false));
    renderHook(() => useCountPreviews("s1", null, []));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(api.runLookupQuery).not.toHaveBeenCalled();
  });
});
