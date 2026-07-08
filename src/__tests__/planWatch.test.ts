import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_PLAN_WATCH,
  MAX_GENERATIONS,
  isWatched,
  loadPlanWatch,
  normalizePlanWatch,
  pruneMissingWatches,
  recordGeneration,
  removeWatch,
  savePlanWatch,
  toggleWatch,
  watchedIds,
  type PlanGeneration,
  type PlanWatchState,
} from "../planWatch";

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

describe("toggleWatch / isWatched / removeWatch", () => {
  it("registers and unregisters a snippet", () => {
    let state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    expect(isWatched(state, "s1")).toBe(true);
    expect(watchedIds(state)).toEqual(["s1"]);
    state = toggleWatch(state, "s1");
    expect(isWatched(state, "s1")).toBe(false);
    expect(watchedIds(state)).toEqual([]);
  });

  it("unwatching drops the stored generations", () => {
    let state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    state = recordGeneration(state, "s1", gen("fp1")).state;
    state = removeWatch(state, "s1");
    state = toggleWatch(state, "s1");
    expect(state.watches["s1"]).toEqual([]);
  });

  it("removeWatch is a no-op for unwatched ids", () => {
    expect(removeWatch(EMPTY_PLAN_WATCH, "nope")).toBe(EMPTY_PLAN_WATCH);
  });
});

describe("recordGeneration", () => {
  it("does nothing for an unwatched snippet", () => {
    const res = recordGeneration(EMPTY_PLAN_WATCH, "s1", gen("fp1"));
    expect(res.added).toBe(false);
    expect(res.state).toBe(EMPTY_PLAN_WATCH);
  });

  it("adds the first generation with a null prev", () => {
    const state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    const res = recordGeneration(state, "s1", gen("fp1"));
    expect(res.added).toBe(true);
    expect(res.prev).toBeNull();
    expect(res.state.watches["s1"]).toHaveLength(1);
  });

  it("skips a generation with an identical fingerprint (dedupe)", () => {
    let state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    state = recordGeneration(state, "s1", gen("fp1", "first")).state;
    const res = recordGeneration(state, "s1", gen("fp1", "second"));
    expect(res.added).toBe(false);
    expect(res.state.watches["s1"]).toHaveLength(1);
    expect(res.state.watches["s1"][0].id).toBe("first");
  });

  it("prepends a changed plan and reports the previous generation", () => {
    let state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    state = recordGeneration(state, "s1", gen("fp1")).state;
    const res = recordGeneration(state, "s1", gen("fp2"));
    expect(res.added).toBe(true);
    expect(res.prev?.fingerprint).toBe("fp1");
    expect(res.state.watches["s1"].map((g) => g.fingerprint)).toEqual(["fp2", "fp1"]);
  });

  it("rotates out old generations beyond MAX_GENERATIONS", () => {
    let state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    for (let i = 0; i < MAX_GENERATIONS + 5; i++) {
      state = recordGeneration(state, "s1", gen(`fp${i}`)).state;
    }
    const gens = state.watches["s1"];
    expect(gens).toHaveLength(MAX_GENERATIONS);
    // 最新が先頭、最古 (fp0〜fp4) はローテーションで消えている。
    expect(gens[0].fingerprint).toBe(`fp${MAX_GENERATIONS + 4}`);
    expect(gens.some((g) => g.fingerprint === "fp0")).toBe(false);
  });
});

describe("normalizePlanWatch", () => {
  it("collapses garbage input to the empty state", () => {
    expect(normalizePlanWatch(null)).toEqual(EMPTY_PLAN_WATCH);
    expect(normalizePlanWatch("junk")).toEqual(EMPTY_PLAN_WATCH);
    expect(normalizePlanWatch({ watches: 42 })).toEqual(EMPTY_PLAN_WATCH);
  });

  it("drops invalid generations and keeps valid ones", () => {
    const state = normalizePlanWatch({
      watches: {
        s1: [gen("fp1"), { id: "broken" }, "junk"],
        s2: "not-an-array",
      },
    });
    expect(state.watches["s1"]).toHaveLength(1);
    expect("s2" in state.watches).toBe(false);
  });

  it("clamps generation lists to MAX_GENERATIONS", () => {
    const many = Array.from({ length: MAX_GENERATIONS + 10 }, (_, i) => gen(`fp${i}`));
    const state = normalizePlanWatch({ watches: { s1: many } });
    expect(state.watches["s1"]).toHaveLength(MAX_GENERATIONS);
  });
});

describe("pruneMissingWatches", () => {
  it("removes watches for deleted snippets and keeps the rest", () => {
    let state: PlanWatchState = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    state = toggleWatch(state, "s2");
    const pruned = pruneMissingWatches(state, ["s2"]);
    expect(watchedIds(pruned)).toEqual(["s2"]);
  });

  it("returns the same state when nothing is missing", () => {
    const state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    expect(pruneMissingWatches(state, ["s1", "s2"])).toBe(state);
  });
});

describe("load/save round-trip (localStorage)", () => {
  beforeEach(() => localStorage.clear());

  it("persists per profile and survives a reload", () => {
    let state = toggleWatch(EMPTY_PLAN_WATCH, "s1");
    state = recordGeneration(state, "s1", gen("fp1")).state;
    savePlanWatch("profileA", state);
    expect(loadPlanWatch("profileA")).toEqual(state);
    expect(loadPlanWatch("profileB")).toEqual(EMPTY_PLAN_WATCH);
  });

  it("removes the storage key when the last watch is removed", () => {
    savePlanWatch("profileA", toggleWatch(EMPTY_PLAN_WATCH, "s1"));
    savePlanWatch("profileA", EMPTY_PLAN_WATCH);
    expect(localStorage.getItem("noobdb.planwatch.profileA")).toBeNull();
  });

  it("tolerates corrupted JSON", () => {
    localStorage.setItem("noobdb.planwatch.profileA", "{broken");
    expect(loadPlanWatch("profileA")).toEqual(EMPTY_PLAN_WATCH);
  });
});
