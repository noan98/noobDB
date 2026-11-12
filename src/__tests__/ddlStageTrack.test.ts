import { describe, expect, it } from "vitest";
import { failedTrackState, stageLock, stageStatuses } from "../components/ddlStageTrackModel";
import type { DdlStep } from "../components/onlineDdl";
import type { DdlRunReport } from "../components/onlineDdlRunner";

const mk = (phase: DdlStep["phase"], transactional = true): DdlStep => ({
  phase,
  subject: "x",
  statements: [],
  transactional,
  lockTimeout: transactional,
  group: 0,
});

describe("stageStatuses (#2263)", () => {
  it("計画はすべて未実行", () => {
    expect(stageStatuses(3, { kind: "plan" })).toEqual(["pending", "pending", "pending"]);
  });
  it("実行中は done 個が完了、次が実行中、残りは未実行", () => {
    expect(stageStatuses(3, { kind: "running", done: 0 })).toEqual(["running", "pending", "pending"]);
    expect(stageStatuses(3, { kind: "running", done: 2 })).toEqual(["done", "done", "running"]);
    expect(stageStatuses(3, { kind: "running", done: 3 })).toEqual(["done", "done", "done"]);
  });
  it("失敗は手前が完了、後ろは未実行のまま", () => {
    expect(stageStatuses(3, { kind: "failed", failedIndex: 0 })).toEqual(["failed", "pending", "pending"]);
    expect(stageStatuses(3, { kind: "failed", failedIndex: 2 })).toEqual(["done", "done", "failed"]);
  });
});

describe("stageLock / failedTrackState (#2263)", () => {
  it("ロック強度を 4 種類に分ける", () => {
    expect(stageLock(mk("addNotValid"))).toBe("shortExclusive");
    expect(stageLock(mk("setNotNull"))).toBe("shortExclusive");
    expect(stageLock(mk("alter"))).toBe("exclusive");
    expect(stageLock(mk("validate"))).toBe("concurrent");
    expect(stageLock(mk("createIndexConcurrently", false))).toBe("outsideTx");
  });
  it("成功したレポートからは失敗状態を作らない", () => {
    const base = { totalSteps: 2, completedSteps: 2, failedStep: null, failedIndex: null } as DdlRunReport;
    expect(failedTrackState({ ...base, ok: true })).toBeNull();
    expect(failedTrackState({ ...base, ok: false, failedIndex: 1 })).toEqual({
      kind: "failed",
      failedIndex: 1,
    });
  });
});
