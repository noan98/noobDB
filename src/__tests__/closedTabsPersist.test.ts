// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ClosedTab,
  loadPersistedClosedTabs,
  MAX_PERSISTED_CLOSED_SQL_CHARS,
  normalizePersistedClosedTabs,
  restoreClosedTabs,
  savePersistedClosedTabs,
  toPersistedClosedTabs,
} from "../closedTabs";

function tab(over: Partial<ClosedTab> = {}): ClosedTab {
  return { id: "c1", scope: "s1", kind: "query", title: "Q", sql: "SELECT 1", closedAt: 10, ...over };
}

describe("closed tab persistence (#1631)", () => {
  beforeEach(() => localStorage.clear());

  it("スコープと id を落として縮める", () => {
    const [p] = toPersistedClosedTabs([tab({ titleManual: true, selection: { anchor: 1, head: 2 } })]);
    expect(p).toEqual({
      kind: "query",
      title: "Q",
      sql: "SELECT 1",
      closedAt: 10,
      titleManual: true,
      selection: { anchor: 1, head: 2 },
    });
  });

  it("巨大な SQL は捨て、上限件数で切る", () => {
    const big = tab({ sql: "x".repeat(MAX_PERSISTED_CLOSED_SQL_CHARS + 1) });
    expect(toPersistedClosedTabs([big, tab()])).toHaveLength(1);
    expect(toPersistedClosedTabs([tab(), tab(), tab()], 2)).toHaveLength(2);
  });

  it("壊れたエントリは正規化で捨てる", () => {
    const out = normalizePersistedClosedTabs([
      { kind: "query", title: "ok", sql: "s", closedAt: 1 },
      { kind: "bogus", title: "x", sql: "s" },
      { kind: "table", title: "t", sql: "" },
      { kind: "table", title: "t", sql: "", database: "d", table: "t" },
      null,
      "str",
    ]);
    expect(out.map((o) => o.title)).toEqual(["ok", "t"]);
    expect(normalizePersistedClosedTabs({})).toEqual([]);
  });

  it("保存して読み戻せ、空にすると消える", () => {
    savePersistedClosedTabs("p1", toPersistedClosedTabs([tab()]));
    expect(loadPersistedClosedTabs("p1")).toHaveLength(1);
    expect(loadPersistedClosedTabs("p2")).toEqual([]);
    savePersistedClosedTabs("p1", []);
    expect(localStorage.length).toBe(0);
  });

  it("壊れた JSON は空として扱う", () => {
    localStorage.setItem("noobdb.closedTabs.v1.p1", "{not json");
    expect(loadPersistedClosedTabs("p1")).toEqual([]);
  });

  it("読み戻しで現在のスコープと新しい id を付ける", () => {
    let n = 0;
    const restored = restoreClosedTabs(toPersistedClosedTabs([tab(), tab()]), "s9", () => `r${++n}`);
    expect(restored.map((r) => [r.id, r.scope])).toEqual([
      ["r1", "s9"],
      ["r2", "s9"],
    ]);
  });
});
