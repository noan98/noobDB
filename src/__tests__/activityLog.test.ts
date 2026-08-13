import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMIT,
  __resetActivityLog,
  appendActivity,
  clearActivity,
  countBySeverity,
  countUnread,
  filterActivity,
  getActivityState,
  markActivityRead,
  pushActivity,
  relativeActivityTime,
  type ActivityEntry,
} from "../activityLog";

// アクティビティセンター (#912) の共有ストアと純ロジック。UI (ActivityCenter.tsx)
// は状態の読み出しと描画に徹するので、ローテーション・絞り込み・未読数・相対時刻の
// 挙動はここで固定する。

function entry(id: number, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return { id, severity: "info", message: `m${id}`, at: 1_000, ...over };
}

describe("appendActivity", () => {
  it("最新を先頭に足す (入力は変更しない)", () => {
    const list = [entry(1)];
    const next = appendActivity(list, entry(2));
    expect(next.map((e) => e.id)).toEqual([2, 1]);
    expect(list.map((e) => e.id)).toEqual([1]);
  });

  it("上限を超えたら古いものから捨てる", () => {
    let list: ActivityEntry[] = [];
    for (let i = 1; i <= 5; i++) list = appendActivity(list, entry(i), 3);
    expect(list.map((e) => e.id)).toEqual([5, 4, 3]);
  });

  it("上限が 0 以下なら何も保持しない", () => {
    expect(appendActivity([entry(1)], entry(2), 0)).toEqual([]);
    expect(appendActivity([entry(1)], entry(2), -1)).toEqual([]);
  });
});

describe("filterActivity / countBySeverity / countUnread", () => {
  const list = [
    entry(4, { severity: "error" }),
    entry(3, { severity: "warning" }),
    entry(2, { severity: "info" }),
    entry(1, { severity: "error" }),
  ];

  it("重大度で絞り込み、null なら全件返す", () => {
    expect(filterActivity(list, "error").map((e) => e.id)).toEqual([4, 1]);
    expect(filterActivity(list, "success")).toEqual([]);
    expect(filterActivity(list, null).map((e) => e.id)).toEqual([4, 3, 2, 1]);
  });

  it("重大度ごとの件数を数える (0 件の重大度も欠かさない)", () => {
    expect(countBySeverity(list)).toEqual({ error: 2, warning: 1, info: 1, success: 0 });
    expect(countBySeverity([])).toEqual({ error: 0, warning: 0, info: 0, success: 0 });
  });

  it("既読水位より新しい件数を未読とする", () => {
    expect(countUnread(list, 0)).toBe(4);
    expect(countUnread(list, 2)).toBe(2);
    expect(countUnread(list, 4)).toBe(0);
  });
});

describe("relativeActivityTime", () => {
  const now = 10_000_000;
  it("1 分未満は now", () => {
    expect(relativeActivityTime(now, now)).toEqual({ unit: "now" });
    expect(relativeActivityTime(now - 59_000, now)).toEqual({ unit: "now" });
  });

  it("分 → 時間 → 日へ丸める", () => {
    expect(relativeActivityTime(now - 60_000, now)).toEqual({ unit: "minutes", value: 1 });
    expect(relativeActivityTime(now - 59 * 60_000, now)).toEqual({ unit: "minutes", value: 59 });
    expect(relativeActivityTime(now - 60 * 60_000, now)).toEqual({ unit: "hours", value: 1 });
    expect(relativeActivityTime(now - 25 * 3_600_000, now)).toEqual({ unit: "days", value: 1 });
  });

  it("未来の時刻 (時計のずれ) は now に倒す", () => {
    expect(relativeActivityTime(now + 60_000, now)).toEqual({ unit: "now" });
  });
});

describe("ストア (push / 既読 / クリア)", () => {
  beforeEach(() => {
    __resetActivityLog();
  });

  it("push した順に最新が先頭へ来て、未読が増える", () => {
    pushActivity("info", "first");
    pushActivity("error", "second");
    const s = getActivityState();
    expect(s.entries.map((e) => e.message)).toEqual(["second", "first"]);
    expect(countUnread(s.entries, s.lastReadId)).toBe(2);
  });

  it("既読にすると未読が 0 になり、その後の push だけ未読になる", () => {
    pushActivity("info", "a");
    markActivityRead();
    expect(countUnread(getActivityState().entries, getActivityState().lastReadId)).toBe(0);
    pushActivity("info", "b");
    expect(countUnread(getActivityState().entries, getActivityState().lastReadId)).toBe(1);
  });

  it("クリアで空になり既読水位も戻る", () => {
    pushActivity("info", "a");
    markActivityRead();
    clearActivity();
    expect(getActivityState()).toEqual({ entries: [], lastReadId: 0 });
  });

  it("上限を超えても保持数は ACTIVITY_LIMIT に収まる", () => {
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) pushActivity("info", `m${i}`);
    const { entries } = getActivityState();
    expect(entries).toHaveLength(ACTIVITY_LIMIT);
    expect(entries[0].message).toBe(`m${ACTIVITY_LIMIT + 4}`);
  });
});
