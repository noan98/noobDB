import { describe, expect, it } from "vitest";
import { normalizePersistedWorkspace } from "../tabPersistence";

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
});
