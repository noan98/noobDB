import { describe, it, expect, vi } from "vitest";
import { buildIndexExecutionPlan, buildAlterExecutionPlan } from "../components/onlineDdl";
import { runDdlPlan, type DdlRunnerApi } from "../components/onlineDdlRunner";
import { buildAlterPlan } from "../components/alterTable";

function mockApi(over: Partial<DdlRunnerApi> = {}): DdlRunnerApi {
  const ok = { columns: [], rows: [], rows_affected: 0, elapsed_ms: 0 } as never;
  return {
    runQuery: vi.fn().mockResolvedValue(ok),
    runQueryTransaction: vi.fn().mockResolvedValue(ok),
    runLookupQuery: vi.fn().mockResolvedValue(ok),
    ...over,
  };
}

const fkForm = {
  database: "shop",
  table: "orders",
  baseline: [],
  existing: [],
  added: [],
  indexes: [{ name: "idx_o", columns: ["total"], unique: false }],
  addedForeignKeys: [
    { name: "fk_u", columns: ["user_id"], refTable: "users", refColumns: ["id"], onDelete: "", onUpdate: "" },
  ],
} as never;

describe("runDdlPlan", () => {
  it("段階ごとに別のトランザクション、CONCURRENTLY はトランザクション外の単独実行", async () => {
    const api = mockApi();
    const plan = buildAlterExecutionPlan("postgres", buildAlterPlan("postgres", fkForm).statements, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 5,
    });
    const progress: number[] = [];
    const r = await runDdlPlan(api, "s1", plan, (d) => progress.push(d));
    expect(r.ok).toBe(true);
    expect(api.runQueryTransaction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.runQueryTransaction).mock.calls[0][1][0]).toBe("SET LOCAL lock_timeout = '5s';");
    expect(api.runQuery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.runQuery).mock.calls[0][1]).toContain("CONCURRENTLY");
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  it("VALIDATE が失敗したら、どこまで適用済みかと後始末を返し、以降は実行しない", async () => {
    const api = mockApi({
      runQueryTransaction: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("insert or update violates foreign key constraint")),
    });
    const plan = buildAlterExecutionPlan("postgres", buildAlterPlan("postgres", fkForm).statements, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 0,
    });
    const r = await runDdlPlan(api, "s1", plan);
    expect(r.ok).toBe(false);
    expect(r.completedSteps).toBe(1);
    expect(r.failedIndex).toBe(1);
    expect(r.lockTimeout).toBe(false);
    expect(r.cleanupSql).toContain('DROP CONSTRAINT "fk_u"');
    expect(api.runQuery).not.toHaveBeenCalled();
  });

  it("ロック待ちのタイムアウトを判別する", async () => {
    const api = mockApi({
      runQueryTransaction: vi.fn().mockRejectedValue(new Error("canceling statement due to lock timeout")),
    });
    const plan = buildAlterExecutionPlan("postgres", buildAlterPlan("postgres", fkForm).statements, {
      database: "shop",
      staged: false,
      lockTimeoutSecs: 3,
    });
    const r = await runDdlPlan(api, "s1", plan);
    expect(r.lockTimeout).toBe(true);
    expect(r.completedSteps).toBe(0);
  });

  it("CONCURRENTLY の失敗後は INVALID なインデックスの有無を確認する", async () => {
    const plan = buildIndexExecutionPlan("postgres", 'CREATE UNIQUE INDEX CONCURRENTLY "i" ON "t" ("a");', {
      database: "public",
      indexName: "i",
      kind: "create",
      concurrently: true,
      lockTimeoutSecs: 5,
    });
    const left = mockApi({
      runQuery: vi.fn().mockRejectedValue(new Error("could not create unique index")),
      runLookupQuery: vi.fn().mockResolvedValue({ columns: [], rows: [[1]] }),
    });
    const r1 = await runDdlPlan(left, "s1", plan);
    expect(r1.invalidIndexLeft).toBe(true);
    expect(r1.cleanupSql).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."i";');
    const gone = mockApi({
      runQuery: vi.fn().mockRejectedValue(new Error("cancel")),
      runLookupQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    });
    const r2 = await runDdlPlan(gone, "s1", plan);
    expect(r2.invalidIndexLeft).toBe(false);
    expect(r2.cleanupSql).toBe("");
    const unknown = mockApi({
      runQuery: vi.fn().mockRejectedValue(new Error("x")),
      runLookupQuery: vi.fn().mockRejectedValue(new Error("no")),
    });
    const ru = await runDdlPlan(unknown, "s1", plan);
    expect(ru.invalidIndexLeft).toBeNull();
    // 確認できなかったときは、有効な既存インデックスを落としかねない DROP を案内しない。
    expect(ru.cleanupSql).toBe("");
  });
});
