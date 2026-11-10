import { describe, expect, it } from "vitest";
import {
  groupProgress,
  isMasteryFeatureId,
  MASTERY_FEATURE_IDS,
  MASTERY_GROUPS,
  overallProgress,
  recommendNext,
  sanitizeTried,
  withTried,
} from "../mastery";

describe("習熟マップの純ロジック (#2216)", () => {
  it("対象は 30 項目で ID は重複しない", () => {
    expect(MASTERY_FEATURE_IDS).toHaveLength(30);
    expect(new Set(MASTERY_FEATURE_IDS).size).toBe(30);
  });

  it("sanitizeTried は未知の ID・重複・非配列を捨て、目次順に整える", () => {
    expect(sanitizeTried(undefined)).toEqual([]);
    expect(sanitizeTried("helpRunTitle")).toEqual([]);
    expect(sanitizeTried(["helpExplainTitle", "nope", 1, "helpRunTitle", "helpRunTitle"])).toEqual([
      "helpRunTitle",
      "helpExplainTitle",
    ]);
  });

  it("withTried は追加し、既出・未知なら同じ参照を返す", () => {
    const base: readonly string[] = ["helpRunTitle"];
    expect(withTried(base, "helpExplainTitle")).toEqual(["helpRunTitle", "helpExplainTitle"]);
    expect(withTried(base, "helpRunTitle")).toBe(base);
    expect(withTried(base, "unknown")).toBe(base);
  });

  it("groupProgress / overallProgress は試した数と総数を数える", () => {
    const tried = ["helpRunTitle", "helpExplainTitle", "helpAiPolicyTitle", "bogus"];
    const g = groupProgress(tried);
    expect(g).toHaveLength(MASTERY_GROUPS.length);
    expect(g[0]).toEqual({ group: "helpGroupQuery", done: 2, total: 8 });
    expect(g.find((x) => x.group === "helpSectionAi")).toEqual({
      group: "helpSectionAi",
      done: 1,
      total: 3,
    });
    expect(overallProgress(tried)).toEqual({ done: 3, total: 30 });
    expect(overallProgress([])).toEqual({ done: 0, total: 30 });
    expect(overallProgress(MASTERY_FEATURE_IDS)).toEqual({ done: 30, total: 30 });
  });

  it("recommendNext は関連の強い未体験を優先し、最大 2 件", () => {
    expect(recommendNext("helpRunTitle", [])).toEqual(["helpDryRunTitle", "helpExplainTitle"]);
  });

  it("recommendNext は体験済みと自分自身を除き、同じグループで補う", () => {
    const out = recommendNext("helpRunTitle", ["helpDryRunTitle"]);
    expect(out).toEqual(["helpExplainTitle", "helpFormatTitle"]);
    expect(out).not.toContain("helpRunTitle");
  });

  it("recommendNext は全部試し済み・未知 ID・件数 0 で空を返す", () => {
    expect(recommendNext("helpRunTitle", MASTERY_FEATURE_IDS)).toEqual([]);
    expect(recommendNext("bogus", [])).toEqual([]);
    expect(recommendNext("helpRunTitle", [], 0)).toEqual([]);
  });

  it("関連表のすべての項目で、おすすめは自分以外の実在 ID になる", () => {
    for (const id of MASTERY_FEATURE_IDS) {
      const out = recommendNext(id, []);
      expect(out.length).toBeGreaterThan(0);
      for (const r of out) {
        expect(r).not.toBe(id);
        expect(isMasteryFeatureId(r)).toBe(true);
      }
    }
  });
});
