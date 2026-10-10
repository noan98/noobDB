import { describe, expect, it } from "vitest";
import {
  MAX_CLOSED_TABS,
  closedTabItemId,
  closedTabsForScope,
  dropClosedTabsForScope,
  isClosedTabItemId,
  REOPEN_CLOSED_TAB_COMMAND_ID,
  pushClosedTab,
  snapshotClosedTab,
  takeClosedTab,
  type ClosedTab,
} from "../closedTabs";

function entry(over: Partial<ClosedTab> & { id: string }): ClosedTab {
  return { scope: "s1", kind: "query", title: "Query", sql: "SELECT 1", closedAt: 0, ...over };
}

describe("snapshotClosedTab", () => {
  const meta = { id: "c1", scope: "s1", closedAt: 100 };

  it("クエリタブは最新本文・接続先・選択範囲を保持する", () => {
    const s = snapshotClosedTab(
      { kind: "query", title: "q", database: "db", selection: { anchor: 1, head: 2 } },
      "SELECT 2",
      meta,
      { anchor: 3, head: 4 },
    );
    expect(s).toMatchObject({ kind: "query", sql: "SELECT 2", database: "db", selection: { anchor: 3, head: 4 } });
  });

  it("手動命名フラグを保持し、自動名では付けない (#1390)", () => {
    expect(snapshotClosedTab({ kind: "query", title: "q", titleManual: true }, "SELECT 1", meta)?.titleManual).toBe(true);
    expect(snapshotClosedTab({ kind: "query", title: "q", titleManual: false }, "SELECT 1", meta)).not.toHaveProperty("titleManual");
  });

  it("本文が空白だけのクエリ / explain タブは残さない", () => {
    expect(snapshotClosedTab({ kind: "query", title: "q" }, "  \n", meta)).toBeNull();
    expect(snapshotClosedTab({ kind: "explain", title: "e" }, "", meta)).toBeNull();
  });

  it("table タブは本文が空でも database/table があれば残し、無ければ捨てる", () => {
    expect(snapshotClosedTab({ kind: "table", title: "users", database: "d", table: "users" }, "", meta)).not.toBeNull();
    expect(snapshotClosedTab({ kind: "table", title: "users" }, "SELECT 1", meta)).toBeNull();
  });
});

describe("pushClosedTab", () => {
  it("新しい順に積む", () => {
    const list = pushClosedTab([entry({ id: "a", sql: "A" })], entry({ id: "b", sql: "B" }));
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("同じ内容は古い方を除いて最新へ寄せる", () => {
    const list = pushClosedTab(
      [entry({ id: "a", sql: "A" }), entry({ id: "x", sql: "X" })],
      entry({ id: "a2", sql: "A" }),
    );
    expect(list.map((e) => e.id)).toEqual(["a2", "x"]);
  });

  it("スコープごとに上限を超えた古い分を捨てる (他スコープは巻き込まない)", () => {
    let list: ClosedTab[] = [entry({ id: "other", scope: "s2", sql: "O" })];
    for (let i = 0; i < MAX_CLOSED_TABS + 5; i++) list = pushClosedTab(list, entry({ id: `t${i}`, sql: `S${i}` }));
    expect(closedTabsForScope(list, "s1")).toHaveLength(MAX_CLOSED_TABS);
    expect(closedTabsForScope(list, "s1")[0].id).toBe(`t${MAX_CLOSED_TABS + 4}`);
    expect(closedTabsForScope(list, "s2")).toHaveLength(1);
  });

  it("入力を破壊しない", () => {
    const base = [entry({ id: "a", sql: "A" })];
    pushClosedTab(base, entry({ id: "b", sql: "B" }));
    expect(base).toHaveLength(1);
  });
});

describe("takeClosedTab", () => {
  const list = [entry({ id: "n", scope: "s2", sql: "N" }), entry({ id: "a", sql: "A" }), entry({ id: "b", sql: "B" })];

  it("id 省略時はスコープ内の最新を取り出す", () => {
    const { entry: e, rest } = takeClosedTab(list, "s1");
    expect(e?.id).toBe("a");
    expect(rest.map((x) => x.id)).toEqual(["n", "b"]);
  });

  it("id 指定でその 1 件を取り出し、別スコープの id は取れない", () => {
    expect(takeClosedTab(list, "s1", "b").entry?.id).toBe("b");
    expect(takeClosedTab(list, "s1", "n").entry).toBeNull();
  });

  it("空・該当なしなら entry は null で一覧は変わらない", () => {
    expect(takeClosedTab([], "s1")).toEqual({ entry: null, rest: [] });
    expect(takeClosedTab(list, "zz").rest).toHaveLength(3);
  });
});

describe("dropClosedTabsForScope", () => {
  it("指定スコープだけを捨て、他スコープと入力は保つ", () => {
    const list = [entry({ id: "a" }), entry({ id: "b", scope: "s2" }), entry({ id: "c" })];
    expect(dropClosedTabsForScope(list, "s1").map((e) => e.id)).toEqual(["b"]);
    expect(dropClosedTabsForScope(list, "zz")).toHaveLength(3);
    expect(list).toHaveLength(3);
  });
});

describe("パレット項目 id", () => {
  it("個別項目の id だけが一時 id として判定され、固定 id は含まれない", () => {
    expect(isClosedTabItemId(closedTabItemId("closed-1"))).toBe(true);
    expect(isClosedTabItemId(REOPEN_CLOSED_TAB_COMMAND_ID)).toBe(false);
  });
});
