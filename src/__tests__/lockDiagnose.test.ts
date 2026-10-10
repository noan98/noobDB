import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../api/tauri";
import {
  buildLockDiagnosePrompt,
  buildLockDiagnoseSystem,
  LOCK_DIAGNOSE_FORMAT,
  LOCK_DIAGNOSE_MAX_PROCESSES,
  lockDiagnoseTableRefs,
  parseLockDiagnoseResponse,
  selectLockDiagnoseTargets,
  toLockDiagnoseProcess,
  type LockDiagnoseInput,
} from "../ai/lockDiagnose";

function proc(id: number, over: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id,
    user: "app",
    host: "10.0.0.9:5555",
    database: "shop",
    command: "Query",
    state: null,
    time_secs: 0,
    query_summary: null,
    query_truncated: false,
    is_self: false,
    blocked_by: [],
    ...over,
  };
}

describe("selectLockDiagnoseTargets (#1478)", () => {
  const chain = [
    proc(1, { time_secs: 90, query_summary: "UPDATE orders SET a = 1" }),
    proc(2, { blocked_by: [1], query_summary: "UPDATE orders SET b = 2" }),
    proc(3, { blocked_by: [2], query_summary: "SELECT * FROM orders FOR UPDATE" }),
    proc(9, { time_secs: 600, query_summary: "SELECT sleepy()" }),
  ];

  it("選択中があればそれを優先し、待機関係でつながるプロセスも含める", () => {
    const t = selectLockDiagnoseTargets(chain, new Set([2]));
    expect(t?.scope).toBe("selection");
    expect(t?.processes.map((p) => p.id).sort()).toEqual([1, 2, 3]);
    expect(t?.processes[0].id).toBe(2);
  });

  it("選択が無ければ待機チェーン全体 (根が先頭、無関係なプロセスは除く)", () => {
    const t = selectLockDiagnoseTargets(chain, new Set());
    expect(t?.scope).toBe("chain");
    expect(t?.processes[0].id).toBe(1);
    expect(t?.processes.map((p) => p.id).sort()).toEqual([1, 2, 3]);
  });

  it("待機が無ければ長時間実行クエリ (自アプリ・待機中でない Sleep・短時間は除く)", () => {
    const list = [
      proc(1, { time_secs: 30, query_summary: "SELECT slow" }),
      proc(2, { time_secs: 300, query_summary: "SELECT slower" }),
      proc(3, { time_secs: 999, command: "Sleep", query_summary: "SELECT idle" }),
      proc(4, { time_secs: 999, is_self: true, query_summary: "SELECT self" }),
      proc(5, { time_secs: 1, query_summary: "SELECT quick" }),
    ];
    const t = selectLockDiagnoseTargets(list, new Set());
    expect(t?.scope).toBe("longRunning");
    expect(t?.processes.map((p) => p.id)).toEqual([2, 1]);
  });

  it("対象が無ければ null", () => {
    expect(selectLockDiagnoseTargets([proc(1)], new Set())).toBeNull();
    expect(selectLockDiagnoseTargets([], new Set())).toBeNull();
  });

  it("上限を超えた分は切り捨てて件数を返す", () => {
    const list = [proc(1, { time_secs: 1 })];
    for (let i = 2; i < 30; i++) list.push(proc(i, { blocked_by: [1] }));
    const t = selectLockDiagnoseTargets(list, new Set());
    expect(t?.processes).toHaveLength(LOCK_DIAGNOSE_MAX_PROCESSES);
    expect(t?.omitted).toBe(29 - LOCK_DIAGNOSE_MAX_PROCESSES);
  });
});

describe("buildLockDiagnosePrompt (#1478)", () => {
  const procs = [
    toLockDiagnoseProcess(proc(1, { time_secs: 90 }), "UPDATE orders SET note = 'top-secret' WHERE id = 42"),
    toLockDiagnoseProcess(
      proc(2, { blocked_by: [1, 77], time_secs: 5, state: "Waiting for row lock" }),
      "SELECT * FROM orders WHERE id = 42 FOR UPDATE",
    ),
  ];
  const base: LockDiagnoseInput = {
    driver: "mysql",
    scope: "chain",
    processes: procs,
    omitted: 0,
    tables: [
      {
        name: "orders",
        estimatedRows: 12000,
        columns: [
          { name: "id", data_type: "int", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
        ],
      },
    ],
    maskLiterals: true,
    locale: "ja",
  };

  it("maskLiterals=true ではクエリ本文のリテラルを送らない", () => {
    const p = buildLockDiagnosePrompt(base);
    expect(p).not.toContain("top-secret");
    expect(p).toContain("string literals and comments are blanked");
    expect(p).toContain("UPDATE orders SET note =");
  });

  it("maskLiterals=false では本文をそのまま送る", () => {
    const p = buildLockDiagnosePrompt({ ...base, maskLiterals: false });
    expect(p).toContain("top-secret");
    expect(p).not.toContain("blanked");
  });

  it("待機関係・実行時間・スキーマを含み、接続元ホストは含めない", () => {
    const p = buildLockDiagnosePrompt(base);
    expect(p).toContain("#2 waits for #1");
    expect(p).toContain("#2 waits for #77 (not in this list)");
    expect(p).toContain("running=90s");
    expect(p).toContain("state=Waiting for row lock");
    expect(p).toContain("orders (estimated rows: 12000)");
    expect(p).toContain("id int (key=PRI, not null)");
    expect(p).not.toContain("10.0.0.9");
  });

  it("本文が無いプロセスは (none) と書く", () => {
    const p = buildLockDiagnosePrompt({
      ...base,
      processes: [toLockDiagnoseProcess(proc(5), null)],
    });
    expect(p).toContain("SQL: (none)");
    expect(p).toContain("- none reported");
  });

  it("システムプロンプトは KILL を実行しない旨と言語を含む", () => {
    expect(buildLockDiagnoseSystem("ja")).toContain("Japanese");
    expect(buildLockDiagnoseSystem("en")).toContain("English");
    expect(buildLockDiagnoseSystem("en")).toContain("cannot kill anything");
  });
});

describe("lockDiagnoseTableRefs / parse (#1478)", () => {
  it("修飾の無いテーブルはプロセスの DB で引き、重複を除く", () => {
    const a = toLockDiagnoseProcess(proc(1, { database: "shop" }), "UPDATE orders SET a = 1");
    const b = toLockDiagnoseProcess(
      proc(2, { database: "shop" }),
      "SELECT * FROM orders o JOIN other.items i ON i.oid = o.id",
    );
    expect(lockDiagnoseTableRefs([a, b], "mysql")).toEqual([
      { database: "shop", table: "orders" },
      { database: "other", table: "items" },
    ]);
  });

  it("応答を構造化 JSON として読み、壊れていれば生の本文を返す", () => {
    const ok = parseLockDiagnoseResponse(
      JSON.stringify({
        summary: "s",
        waits: [{ session_id: 2, waiting_for: [1], detail: "d" }],
        stop_candidates: [{ session_id: 1, impact: "low", reason: "r" }],
        prevention: ["p"],
      }),
    );
    expect(ok.ok).toBe(true);
    const bad = parseLockDiagnoseResponse("not json");
    expect(bad).toEqual({ ok: false, raw: "not json" });
    expect(LOCK_DIAGNOSE_FORMAT.schema.required).toContain("stop_candidates");
  });
});
