import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../api/tauri", () => ({ api: { runQuery: vi.fn() } }));

import { api } from "../api/tauri";
import { useScanPreflight } from "../components/useScanPreflight";

const runQuery = api.runQuery as unknown as ReturnType<typeof vi.fn>;

const mysqlExplain = {
  columns: [{ name: "EXPLAIN", type_name: "" }],
  rows: [
    [
      JSON.stringify({
        query_block: { table: { table_name: "big", access_type: "ALL", rows_examined_per_scan: 19177 } },
      }),
    ],
  ],
  rows_affected: null,
};

function run(sql: string | null, over: Partial<{ enabled: boolean; driver: string }> = {}) {
  return renderHook(() =>
    useScanPreflight({
      sql,
      sessionId: "s1",
      database: "db",
      enabled: over.enabled ?? true,
      driver: over.driver ?? "mysql",
    }),
  );
}

describe("useScanPreflight", () => {
  beforeEach(() => runQuery.mockReset());

  it("無効 (opt-in オフ) のときは何も流さず null", () => {
    const { result } = run("SELECT * FROM t", { enabled: false });
    expect(result.current).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("SELECT 以外は null で EXPLAIN を流さない", () => {
    const { result } = run("UPDATE t SET a = 1");
    expect(result.current).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("UNION は即座に unestimable で EXPLAIN を流さない", () => {
    const { result } = run("SELECT a FROM x UNION SELECT a FROM y");
    expect(result.current?.status).toBe("unestimable");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("単純な SELECT は EXPLAIN を非ストリーミング経路で流し ready になる", async () => {
    runQuery.mockResolvedValue(mysqlExplain);
    const { result } = run("SELECT * FROM big WHERE v = 'x'");
    expect(result.current?.status).toBe("estimating");
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(runQuery).toHaveBeenCalledWith("s1", "EXPLAIN FORMAT=JSON SELECT * FROM big WHERE v = 'x'", "db");
    expect(result.current?.summary?.fullScan).toBe(true);
    expect(result.current?.summary?.scanRows).toBe(19177);
  });

  it("EXPLAIN が失敗したらバッジを出さない (null)", async () => {
    runQuery.mockRejectedValueOnce(new Error("syntax"));
    const { result } = run("SELECT * FROM nope");
    expect(result.current?.status).toBe("estimating");
    await waitFor(() => expect(runQuery).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBeNull());
  });
});
