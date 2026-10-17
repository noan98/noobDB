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

  // 注: テストでは resolve 関数を外へ持ち出さず、呼び出しごとの遅延で決着させる
  // (外部 resolver を持つ Promise を残すと RTL の cleanup が止まる環境があるため)。
  const delayedExplain = (delays: number[]) => {
    let n = 0;
    runQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          const d = delays[n] ?? 10;
          n += 1;
          setTimeout(() => resolve(mysqlExplain), d);
        }),
    );
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("single-flight: 実行中は次を投げず、完了後に最新 SQL で 1 回だけ再実行し、古い結果は捨てる", async () => {
    delayedExplain([1000, 10]);
    const { result, rerender } = renderHook(
      ({ sql }) => useScanPreflight({ sql, sessionId: "s1", database: null, enabled: true, driver: "mysql" }),
      { initialProps: { sql: "SELECT * FROM a WHERE x = 1" } },
    );
    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
    // 1 本目が実行中 (約 1 秒) に編集が 2 回入る。
    rerender({ sql: "SELECT * FROM b WHERE x = 1" });
    await sleep(450);
    rerender({ sql: "SELECT * FROM c WHERE x = 1" });
    await sleep(450);
    expect(runQuery).toHaveBeenCalledTimes(1);
    // 1 本目が戻ると、古い SQL (a) の結果は捨てて、最新 (c) で 1 回だけ再実行する。
    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(runQuery.mock.calls[1][1]).toBe("EXPLAIN FORMAT=JSON SELECT * FROM c WHERE x = 1");
    expect(result.current?.sql).toBe("SELECT * FROM c WHERE x = 1");
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it("無効化 (トランザクション休止など) すると保留中の再実行は捨てる", async () => {
    delayedExplain([900]);
    const { result, rerender } = renderHook(
      ({ sql, enabled }) =>
        useScanPreflight({ sql, sessionId: "s1", database: null, enabled, driver: "mysql" }),
      { initialProps: { sql: "SELECT * FROM a WHERE x = 1", enabled: true } },
    );
    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
    rerender({ sql: "SELECT * FROM b WHERE x = 1", enabled: true });
    await sleep(450);
    rerender({ sql: "SELECT * FROM b WHERE x = 1", enabled: false });
    expect(result.current).toBeNull();
    await sleep(700);
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });
});
