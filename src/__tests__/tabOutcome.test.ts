import { describe, expect, it } from "vitest";
import { clearSeenOutcomes, outcomeFromKind, shouldMarkUnseenOutcome } from "../tabOutcome";

describe("tabOutcome (#2353)", () => {
  it("通知の種別を印へ写す (timeout は error)", () => {
    expect(outcomeFromKind("done")).toBe("done");
    expect(outcomeFromKind("error")).toBe("error");
    expect(outcomeFromKind("timeout")).toBe("error");
    expect(outcomeFromKind("cancelled")).toBe("cancelled");
  });

  it("非アクティブなタブでだけ印を立てる", () => {
    expect(shouldMarkUnseenOutcome({ tabId: "a", visibleTabIds: ["b"] })).toBe(true);
    expect(shouldMarkUnseenOutcome({ tabId: "a", visibleTabIds: ["a"] })).toBe(false);
    // 分割ペインのどちらかで見えていれば立てない
    expect(shouldMarkUnseenOutcome({ tabId: "a", visibleTabIds: ["b", "a"] })).toBe(false);
    expect(shouldMarkUnseenOutcome({ tabId: "a", visibleTabIds: [] })).toBe(true);
  });

  it("自動リフレッシュと接続断では立てない", () => {
    expect(shouldMarkUnseenOutcome({ tabId: "a", visibleTabIds: [], autoRefresh: true })).toBe(false);
    expect(shouldMarkUnseenOutcome({ tabId: "a", visibleTabIds: [], connectionLost: true })).toBe(false);
  });

  it("表示中になったタブの印を消し、変更が無ければ同じ参照を返す", () => {
    const tabs = [
      { id: "a", unseenOutcome: "done" as const },
      { id: "b", unseenOutcome: "error" as const },
      { id: "c" },
    ];
    const next = clearSeenOutcomes(tabs, ["a"]);
    expect(next[0].unseenOutcome).toBeUndefined();
    expect(next[1].unseenOutcome).toBe("error");
    expect(next[2]).toBe(tabs[2]);
    expect(clearSeenOutcomes(tabs, ["c"])).toBe(tabs);
  });
});
