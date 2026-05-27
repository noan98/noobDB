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

  it("returns an empty workspace for unknown shapes", () => {
    expect(normalizePersistedWorkspace(null).panes).toHaveLength(0);
    expect(normalizePersistedWorkspace(42).panes).toHaveLength(0);
    expect(normalizePersistedWorkspace({ foo: "bar" }).panes).toHaveLength(0);
    expect(normalizePersistedWorkspace([]).panes).toHaveLength(0);
  });
});
