import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { QueryResult, TableColumnInfo } from "../api/tauri";
import { useValuePicker } from "../components/useValuePicker";

const COLUMNS: TableColumnInfo[] = [
  {
    name: "user_id",
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: "users",
    referenced_column: "id",
  },
];

function result(values: string[]): QueryResult {
  return {
    columns: [{ name: "id", type_name: "INT" }],
    rows: values.map((v) => [v]),
    elapsed_ms: 1,
  } as never;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useValuePicker の FK 検索デバウンス (#1594)", () => {
  it("検索語を打ってすぐ元の語に戻したら、待機中のタイマーは取り消され再取得されない", async () => {
    const lookup = vi.fn().mockResolvedValue(result(["1", "2"]));
    const { result: hook } = renderHook(() =>
      useValuePicker({ driver: "mysql", database: "app", table: "orders", columns: COLUMNS, lookup }),
    );
    // 初回 (検索語なし) は即時取得。
    await act(async () => hook.current.request("user_id", ""));
    const afterFirst = lookup.mock.calls.filter(([sql]) => String(sql).includes("users")).length;

    act(() => hook.current.request("user_id", "x"));
    act(() => hook.current.request("user_id", ""));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const afterAll = lookup.mock.calls.filter(([sql]) => String(sql).includes("users")).length;
    expect(afterAll).toBe(afterFirst);
  });
});
