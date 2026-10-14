import { describe, expect, it } from "vitest";
import {
  normalizePersistedWorkspace,
  resolveWorkspaceToSave,
  splitKeptFromSaved,
  type PersistedWorkspace,
} from "../tabPersistence";

describe("normalizePersistedWorkspace", () => {
  it("wraps a legacy bare tab array into a single pane", () => {
    const ws = normalizePersistedWorkspace([
      { kind: "query", title: "Q", sql: "SELECT 1" },
      { kind: "table", title: "users", database: "db", table: "users", sql: "" },
    ]);
    expect(ws.panes).toHaveLength(1);
    expect(ws.activePane).toBe(0);
    expect(ws.panes[0].activeIndex).toBe(0);
    expect(ws.panes[0].tabs).toHaveLength(2);
  });

  it("drops invalid tabs from a legacy array", () => {
    const ws = normalizePersistedWorkspace([
      { kind: "query", title: "Q", sql: "SELECT 1" },
      { kind: "bogus", title: 5 },
      "nope",
    ]);
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0].tabs).toHaveLength(1);
  });

  it("restores a two-pane workspace and clamps activePane", () => {
    const ws = normalizePersistedWorkspace({
      panes: [
        { tabs: [{ kind: "query", title: "A", sql: "SELECT 1" }], activeIndex: 0 },
        {
          tabs: [
            { kind: "query", title: "B", sql: "SELECT 2" },
            { kind: "query", title: "C", sql: "SELECT 3" },
          ],
          activeIndex: 1,
        },
      ],
      activePane: 9,
    });
    expect(ws.panes).toHaveLength(2);
    expect(ws.panes[1].activeIndex).toBe(1);
    expect(ws.activePane).toBe(1);
  });

  it("drops empty panes and resets an out-of-range activeIndex", () => {
    const ws = normalizePersistedWorkspace({
      panes: [
        { tabs: [], activeIndex: 0 },
        { tabs: [{ kind: "query", title: "B", sql: "SELECT 2" }], activeIndex: 7 },
      ],
      activePane: 1,
    });
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0].activeIndex).toBe(0);
    // activePane is clamped to the surviving pane count.
    expect(ws.activePane).toBe(0);
  });

  it("truncates a non-integer activeIndex before range-checking it", () => {
    // A corrupted/hand-edited localStorage value like `1.5` used to pass the
    // `>= 0 && < length` check as-is, and `builtTabs[1.5]` downstream would be
    // `undefined`, crashing the restore path. It should now truncate to a valid
    // integer index when the truncated value is still in range.
    const ws = normalizePersistedWorkspace({
      panes: [
        {
          tabs: [
            { kind: "query", title: "A", sql: "SELECT 1" },
            { kind: "query", title: "B", sql: "SELECT 2" },
          ],
          activeIndex: 1.5,
        },
      ],
      activePane: 0,
    });
    expect(ws.panes[0].activeIndex).toBe(1);
  });

  it("falls back to 0 when the truncated activeIndex is still out of range", () => {
    const ws = normalizePersistedWorkspace({
      panes: [
        {
          tabs: [{ kind: "query", title: "A", sql: "SELECT 1" }],
          activeIndex: 5.9,
        },
      ],
      activePane: 0,
    });
    expect(ws.panes[0].activeIndex).toBe(0);
  });

  // Reorder (#658) is persisted purely as tab array order, so a reordered
  // pane must round-trip through normalize in the same order it was saved.
  it("preserves tab order through normalize (reorder round-trip)", () => {
    const ws = normalizePersistedWorkspace({
      panes: [
        {
          tabs: [
            { kind: "query", title: "C", sql: "SELECT 3" },
            { kind: "query", title: "A", sql: "SELECT 1" },
            { kind: "query", title: "B", sql: "SELECT 2" },
          ],
          activeIndex: 0,
        },
      ],
      activePane: 0,
    });
    expect(ws.panes[0].tabs.map((tt) => tt.title)).toEqual(["C", "A", "B"]);
  });

  it("returns an empty workspace for unknown shapes", () => {
    expect(normalizePersistedWorkspace(null).panes).toHaveLength(0);
    expect(normalizePersistedWorkspace(42).panes).toHaveLength(0);
    expect(normalizePersistedWorkspace({ foo: "bar" }).panes).toHaveLength(0);
    expect(normalizePersistedWorkspace([]).panes).toHaveLength(0);
  });

  // Round-trip QueryBuilderSnapshot so tab re-open restores the inputs.
  it("keeps a valid builderSnapshot on a tab", () => {
    const snapshot = {
      kind: "SELECT",
      database: "db",
      table: "users",
      selectAll: false,
      selectColumns: ["id", "name"],
      whereConditions: [{ column: "id", operator: ">", value: "10" }],
      limit: "50",
      setPairs: [],
      insertPairs: [],
    };
    const ws = normalizePersistedWorkspace([
      { kind: "query", title: "Q", sql: "SELECT 1", builderSnapshot: snapshot },
    ]);
    expect(ws.panes[0].tabs[0].builderSnapshot).toEqual(snapshot);
  });

  it("drops a malformed builderSnapshot but keeps the tab", () => {
    const ws = normalizePersistedWorkspace([
      {
        kind: "query",
        title: "Q",
        sql: "SELECT 1",
        // Missing required fields → snapshot is silently discarded.
        builderSnapshot: { kind: "SELECT", database: "db" },
      },
    ]);
    expect(ws.panes[0].tabs).toHaveLength(1);
    expect(ws.panes[0].tabs[0].builderSnapshot).toBeUndefined();
  });

  // #ORDER BY 回帰テスト: orderBy フィールド追加前の永続化済みスナップショット
  // (フィールド自体が無い) を、追加後のコードでも壊さず復元できること。
  it("restores an older builderSnapshot with no orderBy field (backward compat)", () => {
    const snapshot = {
      kind: "SELECT",
      database: "db",
      table: "users",
      selectAll: true,
      selectColumns: [],
      whereConditions: [],
      limit: "100",
      setPairs: [],
      insertPairs: [],
    };
    const ws = normalizePersistedWorkspace([
      { kind: "query", title: "Q", sql: "SELECT 1", builderSnapshot: snapshot },
    ]);
    expect(ws.panes[0].tabs[0].builderSnapshot).toEqual(snapshot);
    expect(ws.panes[0].tabs[0].builderSnapshot?.orderBy).toBeUndefined();
  });

  it("keeps a valid builderSnapshot with orderBy terms", () => {
    const snapshot = {
      kind: "SELECT",
      database: "db",
      table: "users",
      selectAll: true,
      selectColumns: [],
      whereConditions: [],
      orderBy: [
        { column: "name", direction: "ASC" },
        { column: "created_at", direction: "DESC" },
      ],
      limit: "100",
      setPairs: [],
      insertPairs: [],
    };
    const ws = normalizePersistedWorkspace([
      { kind: "query", title: "Q", sql: "SELECT 1", builderSnapshot: snapshot },
    ]);
    expect(ws.panes[0].tabs[0].builderSnapshot).toEqual(snapshot);
  });

  it("drops a builderSnapshot whose orderBy has an invalid direction", () => {
    const ws = normalizePersistedWorkspace([
      {
        kind: "query",
        title: "Q",
        sql: "SELECT 1",
        builderSnapshot: {
          kind: "SELECT",
          database: "db",
          table: "users",
          selectAll: true,
          selectColumns: [],
          whereConditions: [],
          orderBy: [{ column: "name", direction: "SIDEWAYS" }],
          limit: "100",
          setPairs: [],
          insertPairs: [],
        },
      },
    ]);
    expect(ws.panes[0].tabs).toHaveLength(1);
    expect(ws.panes[0].tabs[0].builderSnapshot).toBeUndefined();
  });

  it("drops a builderSnapshot with an unknown kind", () => {
    const ws = normalizePersistedWorkspace([
      {
        kind: "query",
        title: "Q",
        sql: "SELECT 1",
        builderSnapshot: {
          kind: "MERGE",
          database: "db",
          table: "t",
          selectAll: true,
          selectColumns: [],
          whereConditions: [],
          limit: "",
          setPairs: [],
          insertPairs: [],
        },
      },
    ]);
    expect(ws.panes[0].tabs[0].builderSnapshot).toBeUndefined();
  });

  it("titleManual (#1390): true は引き継ぎ、旧データ(欠落)・不正な型は無しとして読む", () => {
    const ws = normalizePersistedWorkspace([
      { kind: "query", title: "月次", sql: "SELECT 1", titleManual: true },
      { kind: "query", title: "旧", sql: "SELECT 2" },
      { kind: "query", title: "false", sql: "SELECT 3", titleManual: false },
      { kind: "query", title: "不正", sql: "SELECT 4", titleManual: "yes" },
    ]);
    const tabs = ws.panes[0].tabs;
    expect(tabs).toHaveLength(4);
    expect(tabs[0].titleManual).toBe(true);
    expect(tabs[1].titleManual).toBeUndefined();
    expect(tabs[2].titleManual).toBeUndefined();
    expect(tabs[3].titleManual).toBeUndefined();
  });
});

describe("activePane の補正 (空ペイン除去)", () => {
  const pane = (title: string) => ({
    tabs: [{ kind: "query", title, sql: "SELECT 1" }],
    activeIndex: 0,
  });
  it("先頭の無効ペインを除いても元のアクティブペインを指し続ける", () => {
    const ws = normalizePersistedWorkspace({
      panes: [{ tabs: [{ kind: "bogus" }], activeIndex: 0 }, pane("A"), pane("B")],
      activePane: 1,
    });
    expect(ws.panes.map((p) => p.tabs[0].title)).toEqual(["A", "B"]);
    expect(ws.activePane).toBe(0);
  });
  it("アクティブだったペイン自体が除かれたら範囲内へ丸める", () => {
    const ws = normalizePersistedWorkspace({
      panes: [pane("A"), { tabs: [{ kind: "bogus" }], activeIndex: 0 }],
      activePane: 1,
    });
    expect(ws.activePane).toBe(0);
  });
});

describe("resolveWorkspaceToSave / splitKeptFromSaved (#1615)", () => {
  const tab = (title: string) => ({ kind: "query" as const, title, sql: title });
  const ws = (...panes: string[][]): PersistedWorkspace => ({
    panes: panes.map((titles) => ({ tabs: titles.map(tab), activeIndex: 0 })),
    activePane: 0,
  });
  const titles = (w: PersistedWorkspace) => w.panes.map((p) => p.tabs.map((t) => t.title));

  it("保持なしなら現在のワークスペースをそのまま保存する", () => {
    const cur = ws(["a"]);
    expect(resolveWorkspaceToSave(cur, undefined)).toBe(cur);
    expect(resolveWorkspaceToSave(ws(), undefined)).toEqual(ws());
  });

  it("保持中でタブが 0 件なら保持分をそのまま保存し直す", () => {
    const kept = ws(["k1"], ["k2"]);
    expect(resolveWorkspaceToSave(ws(), kept)).toEqual(kept);
  });

  it("保持分はペイン構造ごと後ろに足され、activePane は現在のまま・繰り返しても重複しない", () => {
    const kept = ws(["k1", "k2"], ["k3"]);
    const cur = { ...ws(["new"]), activePane: 0 };
    const merged = resolveWorkspaceToSave(cur, kept);
    // 画面は 2 ペインまでなので、超える分は最後のペインの末尾にタブとして足す
    expect(titles(merged)).toEqual([["new", "k1", "k2", "k3"]]);
    expect(merged.activePane).toBe(0);
    expect(resolveWorkspaceToSave(cur, kept)).toEqual(merged);
    // 2 ペインに収まるならペインのまま足す
    expect(titles(resolveWorkspaceToSave(ws(["new"]), ws(["k1"])))).toEqual([["new"], ["k1"]]);
  });

  it("2 ペインを超える合成でも splitKeptFromSaved でセッションのタブだけに戻る", () => {
    const kept = ws(["k1"], ["k2"]);
    const cur = ws(["a"], ["b"]);
    const saved = resolveWorkspaceToSave(cur, kept);
    expect(saved.panes.length).toBe(2);
    expect(titles(splitKeptFromSaved(saved, kept))).toEqual([["a"], ["b"]]);
    // 保持分だけ (2 ペイン) を保存し直した場合は空に戻る
    expect(splitKeptFromSaved(kept, kept).panes).toEqual([]);
  });

  it("splitKeptFromSaved は足された保持分だけを外す", () => {
    const kept = ws(["k1", "k2"], ["k3"]);
    const saved = resolveWorkspaceToSave(ws(["t1"]), kept);
    expect(titles(splitKeptFromSaved(saved, kept))).toEqual([["t1"]]);
    // 保持分だけ (セッションのタブなし) なら空
    expect(splitKeptFromSaved(kept, kept).panes).toEqual([]);
    // 末尾が保持分と一致しなければそのまま
    const other = ws(["x"]);
    expect(splitKeptFromSaved(other, kept)).toBe(other);
  });

  it("切替 → 戻る → 新しいタブ → 切断 で T1 と K が両方残る", () => {
    const K = ws(["k1", "k2"]);
    // A で T1 を開いて B へ切替: A は [T1, ...K] で保存される
    const afterSwitch = resolveWorkspaceToSave(ws(["T1"]), K);
    // A へ戻る: 保持分を外して T1 だけ復元
    const restored = splitKeptFromSaved(afterSwitch, K);
    expect(titles(restored)).toEqual([["T1"]]);
    // T2 を開いて切断 (画面は T1 + T2)
    const afterDisconnect = resolveWorkspaceToSave(ws(["T1", "T2"]), K);
    expect(titles(afterDisconnect)).toEqual([
      ["T1", "T2"],
      ["k1", "k2"],
    ]);
    // タブを全部閉じて切断すると K だけ残る
    expect(resolveWorkspaceToSave(ws(), K)).toEqual(K);
  });
});
