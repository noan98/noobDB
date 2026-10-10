import { describe, expect, it } from "vitest";
import { closeGuard, hasPendingChanges, isTabDirty, tabsWithPendingChanges, type DirtyTabLike } from "../tabDirty";

const base = (over: Partial<DirtyTabLike> = {}): DirtyTabLike => ({
  kind: "table",
  lastExecutedSql: "SELECT 1",
  pendingEdits: {},
  ...over,
});

describe("hasPendingChanges", () => {
  it("何も無ければ false", () => {
    expect(hasPendingChanges(base())).toBe(false);
    expect(hasPendingChanges({ pendingEdits: {}, pendingDeletes: [], pendingInserts: [] })).toBe(false);
  });

  it("セル編集 / 削除予定 / 追加予定のどれでも true", () => {
    expect(hasPendingChanges(base({ pendingEdits: { "0": { 1: "x" } } }))).toBe(true);
    expect(hasPendingChanges(base({ pendingDeletes: ["0"] }))).toBe(true);
    expect(hasPendingChanges(base({ pendingInserts: [{ 0: "a" }] }))).toBe(true);
  });

  it("セルが空の行エントリだけなら false (編集は残っていない)", () => {
    expect(hasPendingChanges(base({ pendingEdits: { "0": {} } }))).toBe(false);
  });
});

describe("isTabDirty", () => {
  it("query タブは SQL 乖離で dirty", () => {
    expect(isTabDirty(base({ kind: "query" }), "SELECT 2")).toBe(true);
    expect(isTabDirty(base({ kind: "query" }), "SELECT 1")).toBe(false);
  });

  it("table タブは SQL が違っても未確定編集が無ければ dirty でない", () => {
    expect(isTabDirty(base({ kind: "table" }), "other")).toBe(false);
  });

  it("table タブでも未確定編集があれば dirty", () => {
    expect(isTabDirty(base({ pendingEdits: { "3": { 0: "v" } } }), "SELECT 1")).toBe(true);
  });

  it("query タブで SQL 一致でも未確定編集があれば dirty", () => {
    expect(isTabDirty(base({ kind: "query", pendingDeletes: ["1"] }), "SELECT 1")).toBe(true);
  });
});

describe("tabsWithPendingChanges", () => {
  it("SQL 乖離だけのタブは含めず、未確定編集のタブだけ返す", () => {
    const a = { id: "a", ...base({ kind: "query" }) };
    const b = { id: "b", ...base({ pendingEdits: { "0": { 0: "1" } } }) };
    const c = { id: "c", ...base({ pendingInserts: [{}] }) };
    expect(tabsWithPendingChanges([a, b, c]).map((x) => x.id)).toEqual(["b", "c"]);
  });
});

describe("closeGuard", () => {
  const mk = (id: string, over: Partial<DirtyTabLike> & { applyingEdits?: boolean } = {}) => ({ id, ...base(over) });

  it("未確定編集が無ければ ok", () => {
    expect(closeGuard([mk("a"), mk("b")], ["a", "b"])).toEqual({ kind: "ok" });
  });

  it("対象外のタブの未確定編集は無視する", () => {
    expect(closeGuard([mk("a"), mk("b", { pendingDeletes: ["1"] })], ["a"])).toEqual({ kind: "ok" });
  });

  it("対象に未確定編集があれば confirm とその一覧", () => {
    const b = mk("b", { pendingEdits: { "0": { 0: "x" } } });
    expect(closeGuard([mk("a"), b], ["a", "b"])).toEqual({ kind: "confirm", pending: [b] });
  });

  it("Apply 中のタブが含まれれば applying (確認より優先)", () => {
    const b = mk("b", { pendingEdits: { "0": { 0: "x" } }, applyingEdits: true });
    expect(closeGuard([b], ["b"])).toEqual({ kind: "applying" });
  });

  it("存在しない ID は無視する", () => {
    expect(closeGuard([mk("a")], ["zzz"])).toEqual({ kind: "ok" });
  });
});
