import { describe, expect, it, vi } from "vitest";
import {
  buildDriftDetail,
  canDiff,
  formatTableChangeFragment,
  legacySchemaDriftKey,
  MAX_LEGACY_GENERATIONS,
  migrateLegacySchemaDrift,
  normalizeLegacySchemaDrift,
} from "../schemaDrift";

// 世代の保存・ローテーション・フィンガープリント・インデックス差分・サマリ整形の
// 元ロジック (fnv1a / captureGeneration / recordSnapshotGeneration / diffIndexes /
// summarizeDrift) は Rust の `schema_drift` モジュールへ移した (#1260)。同等の検証は
// `src-tauri/src/schema_drift/{mod,store}.rs` のユニットテストが持つ。ここには
// フロントに残った整形ロジックと、旧 localStorage 世代の移行だけを置く。

function legacyGen(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "drift_x",
    capturedAt: "2026-07-08T00:00:00.000Z",
    driver: "mysql",
    database: "app",
    fingerprint: "abcd1234",
    tableCount: 1,
    omitted: false,
    payload: { driver: "mysql", database: "app", tables: [] },
    ...extra,
  };
}

class MemoryStorage {
  private map = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  has(k: string): boolean {
    return this.map.has(k);
  }
}

describe("canDiff", () => {
  it("is false only for generations whose payload was omitted", () => {
    const base = {
      id: "1",
      capturedAt: "t",
      driver: "mysql" as const,
      database: "app",
      fingerprint: "f",
      tableCount: 1,
    };
    expect(canDiff({ ...base, omitted: false })).toBe(true);
    expect(canDiff({ ...base, omitted: true })).toBe(false);
  });
});

describe("normalizeLegacySchemaDrift", () => {
  it("returns an empty list for garbage input", () => {
    expect(normalizeLegacySchemaDrift(null)).toEqual([]);
    expect(normalizeLegacySchemaDrift("x")).toEqual([]);
    expect(normalizeLegacySchemaDrift({})).toEqual([]);
    expect(normalizeLegacySchemaDrift({ generations: "nope" })).toEqual([]);
  });

  it("drops invalid generations and clamps to the legacy limit", () => {
    const many = Array.from({ length: MAX_LEGACY_GENERATIONS + 5 }, () => legacyGen());
    const out = normalizeLegacySchemaDrift({ generations: [{ bogus: true }, ...many] });
    expect(out).toHaveLength(MAX_LEGACY_GENERATIONS);
  });

  it("accepts an omitted generation (payload null)", () => {
    const out = normalizeLegacySchemaDrift({
      generations: [legacyGen({ payload: null, omitted: true })],
    });
    expect(out).toHaveLength(1);
  });
});

describe("migrateLegacySchemaDrift", () => {
  const key = legacySchemaDriftKey("p1");

  it("does nothing (and never calls the IPC) when there is no legacy key", async () => {
    const importLegacy = vi.fn().mockResolvedValue(0);
    await migrateLegacySchemaDrift("p1", importLegacy, new MemoryStorage());
    expect(importLegacy).not.toHaveBeenCalled();
  });

  it("imports the normalized generations (newest first) and removes the key", async () => {
    const storage = new MemoryStorage({
      [key]: JSON.stringify({ generations: [legacyGen({ id: "new" }), legacyGen({ id: "old" }), { bogus: 1 }] }),
    });
    const importLegacy = vi.fn().mockResolvedValue(2);
    await migrateLegacySchemaDrift("p1", importLegacy, storage);
    expect(importLegacy).toHaveBeenCalledTimes(1);
    const [profileId, gens] = importLegacy.mock.calls[0] as [string, { id: string }[]];
    expect(profileId).toBe("p1");
    expect(gens.map((g) => g.id)).toEqual(["new", "old"]);
    expect(storage.has(key)).toBe(false);
  });

  it("keeps the key when the import fails so it is retried next time", async () => {
    const storage = new MemoryStorage({ [key]: JSON.stringify({ generations: [legacyGen()] }) });
    const importLegacy = vi.fn().mockRejectedValue(new Error("ipc down"));
    await migrateLegacySchemaDrift("p1", importLegacy, storage);
    expect(storage.has(key)).toBe(true);
  });

  it("discards corrupted JSON without calling the IPC", async () => {
    const storage = new MemoryStorage({ [key]: "{not json" });
    const importLegacy = vi.fn();
    await migrateLegacySchemaDrift("p1", importLegacy, storage);
    expect(importLegacy).not.toHaveBeenCalled();
    expect(storage.has(key)).toBe(false);
  });

  it("removes the key without importing when nothing valid remains", async () => {
    const storage = new MemoryStorage({ [key]: JSON.stringify({ generations: [{ bogus: 1 }] }) });
    const importLegacy = vi.fn();
    await migrateLegacySchemaDrift("p1", importLegacy, storage);
    expect(importLegacy).not.toHaveBeenCalled();
    expect(storage.has(key)).toBe(false);
  });
});

describe("formatTableChangeFragment / buildDriftDetail", () => {
  it("formats a whole-table addition/removal with a leading sign", () => {
    expect(
      formatTableChangeFragment({
        table: "orders",
        tableStatus: "added",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      }),
    ).toBe("+orders");
    expect(
      formatTableChangeFragment({
        table: "orders",
        tableStatus: "removed",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      }),
    ).toBe("-orders");
  });

  it("formats column and index change counts", () => {
    expect(
      formatTableChangeFragment({
        table: "orders",
        tableStatus: "changed",
        columnsAdded: 2,
        columnsRemoved: 0,
        columnsChanged: 1,
        indexesAdded: 1,
        indexesRemoved: 0,
        indexesChanged: 0,
      }),
    ).toBe("orders(+2,~1,idx+1)");
  });

  it("joins up to maxTables fragments and appends an ellipsis when truncated", () => {
    const summary = {
      tables: ["a", "b", "c", "d"].map((table) => ({
        table,
        tableStatus: "added" as const,
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded: 0,
        indexesRemoved: 0,
        indexesChanged: 0,
      })),
    };
    expect(buildDriftDetail(summary, 2)).toBe("+a, +b, …");
    expect(buildDriftDetail(summary, 10)).toBe("+a, +b, +c, +d");
  });

  it("returns an empty string for an empty summary", () => {
    expect(buildDriftDetail({ tables: [] })).toBe("");
  });
});
