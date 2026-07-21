import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// `api.runQuery` をモックして、フックが「裏 COUNT を非ストリーミング経路で流す」
// 「対象外/推定不可では実行しない」ことを検証する。実 Tauri ランタイムは不要。
vi.mock("../api/tauri", () => ({ api: { runQuery: vi.fn() } }));

import { usePreflightImpact } from "../components/usePreflight";
import { api } from "../api/tauri";

const runQuery = api.runQuery as unknown as ReturnType<typeof vi.fn>;

function countResult(n: number) {
  return { columns: [{ name: "count", type_name: "INT" }], rows: [[n]], rows_affected: null };
}

describe("usePreflightImpact", () => {
  beforeEach(() => {
    runQuery.mockReset();
  });

  it("書き込み DML 以外は null を返し COUNT を流さない", () => {
    const { result } = renderHook(() =>
      usePreflightImpact({
        sql: "SELECT * FROM t",
        sessionId: "s1",
        database: null,
        enabled: true,
      }),
    );
    expect(result.current).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("推定不可の形状は即座に unestimable を返し COUNT を流さない", () => {
    const { result } = renderHook(() =>
      usePreflightImpact({
        sql: "UPDATE a JOIN b ON a.id = b.aid SET a.x = 1",
        sessionId: "s1",
        database: null,
        enabled: true,
      }),
    );
    expect(result.current?.status).toBe("unestimable");
    expect(result.current?.count).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("設定オフ (enabled=false) では null を返す", () => {
    const { result } = renderHook(() =>
      usePreflightImpact({
        sql: "DELETE FROM t WHERE id = 1",
        sessionId: "s1",
        database: null,
        enabled: false,
      }),
    );
    expect(result.current).toBeNull();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("単純な DELETE はデバウンス後に COUNT を裏実行し件数を返す", async () => {
    runQuery.mockResolvedValue(countResult(1240));
    const { result } = renderHook(() =>
      usePreflightImpact({
        sql: "DELETE FROM users WHERE age < 18",
        sessionId: "s1",
        database: "app",
        enabled: true,
      }),
    );
    // 同期段階では「計測中」。
    expect(result.current?.status).toBe("counting");

    await waitFor(() => expect(result.current?.status).toBe("ready"), { timeout: 3000 });
    expect(result.current?.count).toBe(1240);
    expect(result.current?.plan.allRows).toBe(false);
    // 非ストリーミング経路 (履歴を汚さない) で COUNT を流している。
    expect(runQuery).toHaveBeenCalledWith(
      "s1",
      "SELECT COUNT(*) FROM users WHERE age < 18",
      "app",
    );
  });
});
