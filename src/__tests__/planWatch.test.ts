import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PLAN_WATCH,
  isWatched,
  legacyPlanWatchKey,
  MAX_LEGACY_GENERATIONS,
  migrateLegacyPlanWatch,
  normalizeLegacyPlanWatch,
  planWatchStateFromEntries,
  PLAN_WATCH_LIVE_FIELDS,
  watchedIds,
  type PlanGeneration,
} from "../planWatch";

// 世代の記録 (dedupe / ローテーション) とウォッチの登録・解除の元ロジック
// (recordGeneration / toggleWatch / removeWatch / pruneMissingWatches) は Rust の
// `plan_watch::store` へ移した (#1260)。同等の検証は `src-tauri/src/plan_watch/store.rs`
// のユニットテストが持つ。ここにはフロントに残った状態ヘルパと旧 localStorage ウォッチの
// 移行だけを置く。

function gen(fingerprint: string, id = `g-${fingerprint}`): PlanGeneration {
  return {
    id,
    capturedAt: "2026-07-08T00:00:00.000Z",
    driver: "mysql",
    payloadKind: "json",
    payload: `{"plan":"${fingerprint}"}`,
    fingerprint,
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

describe("planWatchStateFromEntries / isWatched / watchedIds", () => {
  it("keeps registration order and treats an entry without generations as watched", () => {
    const state = planWatchStateFromEntries([
      { snippetId: "b", generations: [] },
      { snippetId: "a", generations: [gen("x")] },
    ]);
    expect(watchedIds(state)).toEqual(["b", "a"]);
    expect(isWatched(state, "b")).toBe(true);
    expect(isWatched(state, "c")).toBe(false);
    expect(state.watches.a).toHaveLength(1);
  });

  it("the empty state watches nothing", () => {
    expect(watchedIds(EMPTY_PLAN_WATCH)).toEqual([]);
  });
});

describe("PLAN_WATCH_LIVE_FIELDS", () => {
  const field = PLAN_WATCH_LIVE_FIELDS[0];
  it("flags a newer head generation even when the count is capped", () => {
    const a = { id: "s", generations: [gen("1"), gen("0")] };
    const b = { id: "s", generations: [gen("2"), gen("1")] };
    expect(field.changed(a, b)).toBe(true);
    expect(field.changed(a, a)).toBe(false);
  });
});

describe("normalizeLegacyPlanWatch", () => {
  it("collapses garbage input to an empty list", () => {
    expect(normalizeLegacyPlanWatch(null)).toEqual([]);
    expect(normalizeLegacyPlanWatch("x")).toEqual([]);
    expect(normalizeLegacyPlanWatch({})).toEqual([]);
    expect(normalizeLegacyPlanWatch({ watches: 3 })).toEqual([]);
  });

  it("drops invalid generations, keeps watch registrations, preserves order", () => {
    const out = normalizeLegacyPlanWatch({
      watches: {
        s1: [gen("a"), { id: "bad" }, gen("b")],
        s2: [],
        s3: "not-an-array",
      },
    });
    expect(out.map((e) => e.snippetId)).toEqual(["s1", "s2"]);
    expect(out[0].generations.map((g) => g.fingerprint)).toEqual(["a", "b"]);
    expect(out[1].generations).toEqual([]);
  });

  it("clamps generation lists to the legacy limit", () => {
    const many = Array.from({ length: MAX_LEGACY_GENERATIONS + 4 }, (_, i) => gen(`f${i}`));
    const out = normalizeLegacyPlanWatch({ watches: { s1: many } });
    expect(out[0].generations).toHaveLength(MAX_LEGACY_GENERATIONS);
  });
});

describe("migrateLegacyPlanWatch", () => {
  const key = legacyPlanWatchKey("p1");

  it("does nothing (and never calls the IPC) when there is no legacy key", async () => {
    const importLegacy = vi.fn().mockResolvedValue(0);
    await migrateLegacyPlanWatch("p1", importLegacy, new MemoryStorage());
    expect(importLegacy).not.toHaveBeenCalled();
  });

  it("imports the normalized watches and removes the key", async () => {
    const storage = new MemoryStorage({
      [key]: JSON.stringify({ watches: { s1: [gen("a")], s2: [] } }),
    });
    const importLegacy = vi.fn().mockResolvedValue(2);
    await migrateLegacyPlanWatch("p1", importLegacy, storage);
    expect(importLegacy).toHaveBeenCalledTimes(1);
    const [profileId, watches] = importLegacy.mock.calls[0] as [string, { snippetId: string }[]];
    expect(profileId).toBe("p1");
    expect(watches.map((w) => w.snippetId)).toEqual(["s1", "s2"]);
    expect(storage.has(key)).toBe(false);
  });

  it("keeps the key when the import fails so it is retried next time", async () => {
    const storage = new MemoryStorage({ [key]: JSON.stringify({ watches: { s1: [gen("a")] } }) });
    const importLegacy = vi.fn().mockRejectedValue(new Error("ipc down"));
    await migrateLegacyPlanWatch("p1", importLegacy, storage);
    expect(storage.has(key)).toBe(true);
  });

  it("discards corrupted JSON without calling the IPC", async () => {
    const storage = new MemoryStorage({ [key]: "{nope" });
    const importLegacy = vi.fn();
    await migrateLegacyPlanWatch("p1", importLegacy, storage);
    expect(importLegacy).not.toHaveBeenCalled();
    expect(storage.has(key)).toBe(false);
  });
});
