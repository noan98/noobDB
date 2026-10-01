import { describe, expect, it } from "vitest";
import type { Snippet } from "../api/tauri";
import {
  DEFAULT_LAUNCHER_POSITION,
  DEFAULT_QUICK_LAUNCHER_SECTION_LIMITS,
  buildQuickLauncherSections,
  clampLauncherPoint,
  computeLauncherPopoverPosition,
  exceedsDragThreshold,
  launcherPointToPosition,
  launcherPositionToPoint,
  nudgeLauncherPoint,
  parseLauncherPosition,
  sanitizeQuickLauncherSectionLimits,
  serializeLauncherPosition,
  singleLineSql,
} from "../quickLauncher";

const bounds = { left: 0, top: 40, width: 1000, height: 600 };
const size = { width: 40, height: 40 };

function snippet(id: string): Snippet {
  return { id, name: `s-${id}`, folder: null, tags: [], sql: `SELECT ${id}`, driver: null, scope: { kind: "any" } };
}

describe("sanitizeQuickLauncherSectionLimits", () => {
  it("欠け・型違いは既定 5、範囲外は 1〜20 にクランプ", () => {
    expect(sanitizeQuickLauncherSectionLimits(undefined)).toEqual(DEFAULT_QUICK_LAUNCHER_SECTION_LIMITS);
    expect(
      sanitizeQuickLauncherSectionLimits({ favoriteSnippets: 0, recentQueries: 99, favoriteTables: "3", recentTables: 7.6 }),
    ).toEqual({ favoriteSnippets: 1, recentQueries: 20, favoriteTables: 5, recentTables: 8 });
  });
});

describe("buildQuickLauncherSections", () => {
  const src = {
    snippets: [snippet("a"), snippet("b"), snippet("c")],
    snippetQuickAccess: { favorites: ["c", "gone", "a"], recent: [] },
    queryHistory: ["SELECT 1", "SELECT  1 ", "SELECT 2", "  ", "SELECT 3"],
    tableQuickAccess: {
      favorites: [
        { database: "d", table: "old" },
        { database: "d", table: "new" },
      ],
      recent: [{ database: "d", table: "r1" }],
    },
  };

  it("セクション順は スニペット → クエリ → テーブル (お気に入り → 最近)", () => {
    const s = buildQuickLauncherSections(src, DEFAULT_QUICK_LAUNCHER_SECTION_LIMITS);
    expect(s.map((x) => x.id)).toEqual(["favoriteSnippets", "recentQueries", "favoriteTables", "recentTables"]);
  });

  it("削除済みスニペットを捨て、クエリの重複 (空白差) と空を除く", () => {
    const s = buildQuickLauncherSections(src, DEFAULT_QUICK_LAUNCHER_SECTION_LIMITS);
    expect(s[0].items.map((i) => (i.kind === "snippet" ? i.snippet.id : ""))).toEqual(["c", "a"]);
    expect(s[1].items.map((i) => (i.kind === "query" ? i.sql : ""))).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    expect(s[2].items.map((i) => (i.kind === "table" ? i.ref.table : ""))).toEqual(["new", "old"]);
  });

  it("表示件数で切り、溢れたら hasMore", () => {
    const s = buildQuickLauncherSections(src, { ...DEFAULT_QUICK_LAUNCHER_SECTION_LIMITS, recentQueries: 2 });
    expect(s[1].items).toHaveLength(2);
    expect(s[1].hasMore).toBe(true);
    expect(s[0].hasMore).toBe(false);
  });
});

describe("ボタン位置", () => {
  it("初期位置は右下", () => {
    expect(launcherPositionToPoint(DEFAULT_LAUNCHER_POSITION, bounds, size)).toEqual({ left: 960, top: 600 });
  });

  it("点 → 位置 → 点 で往復でき、最寄りの隅を選ぶ", () => {
    for (const p of [
      { left: 100, top: 100 },
      { left: 800, top: 120 },
      { left: 50, top: 500 },
      { left: 900, top: 550 },
    ]) {
      const pos = launcherPointToPosition(p, bounds, size);
      const back = launcherPositionToPoint(pos, bounds, size);
      expect(back.left).toBeCloseTo(p.left);
      expect(back.top).toBeCloseTo(p.top);
    }
    expect(launcherPointToPosition({ left: 100, top: 100 }, bounds, size).corner).toBe("top-left");
    expect(launcherPointToPosition({ left: 900, top: 550 }, bounds, size).corner).toBe("bottom-right");
  });

  it("ウィンドウが縮んでも割合を保って可視範囲に収まる", () => {
    const pos = launcherPointToPosition({ left: 900, top: 550 }, bounds, size);
    const small = { left: 0, top: 40, width: 400, height: 300 };
    const p = launcherPositionToPoint(pos, small, size);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left).toBeLessThanOrEqual(360);
    expect(p.top).toBeGreaterThanOrEqual(40);
    expect(p.top).toBeLessThanOrEqual(300);
  });

  it("可視範囲外の点はクランプする (NaN も補正)", () => {
    expect(clampLauncherPoint({ left: -50, top: 9999 }, bounds, size)).toEqual({ left: 0, top: 600 });
    expect(clampLauncherPoint({ left: Number.NaN, top: 50 }, bounds, size)).toEqual({ left: 960, top: 50 });
  });

  it("ボタンより狭い範囲でも負の位置にしない", () => {
    expect(launcherPositionToPoint(DEFAULT_LAUNCHER_POSITION, { left: 0, top: 0, width: 20, height: 20 }, size)).toEqual({
      left: 0,
      top: 0,
    });
  });

  it("ドラッグ判定のしきい値", () => {
    expect(exceedsDragThreshold(2, 2)).toBe(false);
    expect(exceedsDragThreshold(3, 3)).toBe(true);
  });

  it("矢印キーで微調整、他のキーは null", () => {
    expect(nudgeLauncherPoint({ left: 10, top: 10 }, "ArrowLeft", false)).toEqual({ left: 2, top: 10 });
    expect(nudgeLauncherPoint({ left: 10, top: 10 }, "ArrowDown", true)).toEqual({ left: 10, top: 50 });
    expect(nudgeLauncherPoint({ left: 10, top: 10 }, "Enter", false)).toBeNull();
  });

  it("永続化フォーマット: 壊れていれば初期位置、割合は 0〜1 にクランプ", () => {
    const pos = { corner: "top-left" as const, rx: 0.25, ry: 0.5 };
    expect(parseLauncherPosition(serializeLauncherPosition(pos))).toEqual(pos);
    expect(parseLauncherPosition(null)).toEqual(DEFAULT_LAUNCHER_POSITION);
    expect(parseLauncherPosition("{oops")).toEqual(DEFAULT_LAUNCHER_POSITION);
    expect(parseLauncherPosition('{"corner":"middle","rx":0,"ry":0}')).toEqual(DEFAULT_LAUNCHER_POSITION);
    expect(parseLauncherPosition('{"corner":"top-right","rx":2,"ry":-1}')).toEqual({
      corner: "top-right",
      rx: 1,
      ry: 0,
    });
  });
});

describe("computeLauncherPopoverPosition", () => {
  const viewport = { width: 1000, height: 700 };
  const pop = { width: 300, height: 400 };

  it("右下のボタンでは上・左へ開く", () => {
    const p = computeLauncherPopoverPosition({ left: 940, top: 640, width: 40, height: 40 }, pop, viewport);
    expect(p).toEqual({ left: 680, top: 232, above: true, alignEnd: true });
  });

  it("左上のボタンでは下・右へ開く", () => {
    const p = computeLauncherPopoverPosition({ left: 20, top: 20, width: 40, height: 40 }, pop, viewport);
    expect(p).toEqual({ left: 20, top: 68, above: false, alignEnd: false });
  });

  it("はみ出す分はビューポート内へクランプする", () => {
    const p = computeLauncherPopoverPosition({ left: 20, top: 300, width: 40, height: 40 }, { width: 300, height: 600 }, viewport);
    expect(p.top).toBe(92);
  });
});

describe("singleLineSql", () => {
  it("改行を畳み、長ければ省略する", () => {
    expect(singleLineSql("SELECT\n  1")).toBe("SELECT 1");
    expect(singleLineSql("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
