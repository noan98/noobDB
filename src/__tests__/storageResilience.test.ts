import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_DISPLAY_COUNT,
  DEFAULT_SETTINGS,
  DEFAULT_THEME_PRESET,
  normalizeSettings,
} from "../settings";
import { loadPersistedWorkspace, type PersistedWorkspace } from "../tabPersistence";
import { EMPTY_QUICK_ACCESS, loadQuickAccess } from "../tableQuickAccess";
import { loadSchemaTree, normalizeSchemaTree, saveSchemaTree } from "../schemaTreeState";
import {
  normalizeCollapsedFolders,
  readCollapsedSnippetFolders,
  writeCollapsedSnippetFolders,
} from "../components/snippetFolders";
import {
  normalizeGridView,
  readStoredGridView,
  writeStoredGridView,
} from "../components/gridViewState";

const EMPTY_WORKSPACE: PersistedWorkspace = { panes: [], activePane: 0 };

// localStorage 永続化の後方互換性・破損耐性テスト (#566)。
//
// 設定 (`settings.ts`)・開きタブ (`tabPersistence.ts`)・クイックアクセス
// (`tableQuickAccess.ts`) は localStorage に状態を永続化する。スキーマ変更後の
// 旧データ・欠損キー・型不一致・壊れた JSON のいずれでも、ローダが**例外を投げず
// 安全な既定へフォールバック**することを 3 ストア横断で固定する。読み込み時の例外は
// 起動時クラッシュや状態消失に直結するため、ここが防御線になる。

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("normalizeSettings (設定の破損耐性)", () => {
  it("非オブジェクト入力はすべて既定へ落ちる", () => {
    for (const bad of [null, undefined, 42, "settings", true, [1, 2, 3]]) {
      expect(normalizeSettings(bad)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("空オブジェクト (全キー欠損) は既定一式になる", () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("型不一致のフィールドは既定へフォールバックする (例外を投げない)", () => {
    const result = normalizeSettings({
      defaultDisplayCount: "not-a-number",
      accentColor: 123,
      themePreset: "totally-bogus-preset",
      density: {},
      autoLimitEnabled: "yes",
      resultsInNewTab: 1,
      syntaxColors: "broken",
      previewHighlight: [],
      shortcutOverrides: "nope",
    });
    expect(result.defaultDisplayCount).toBe(DEFAULT_DISPLAY_COUNT);
    expect(result.accentColor).toBe(DEFAULT_ACCENT_COLOR);
    expect(result.themePreset).toBe(DEFAULT_THEME_PRESET);
    expect(result.density).toBe(DEFAULT_SETTINGS.density);
    expect(result.autoLimitEnabled).toBe(DEFAULT_SETTINGS.autoLimitEnabled);
    expect(result.resultsInNewTab).toBe(false);
    expect(result.syntaxColors).toEqual(DEFAULT_SETTINGS.syntaxColors);
    expect(result.previewHighlight).toEqual(DEFAULT_SETTINGS.previewHighlight);
  });

  it("範囲外の数値はクランプされる (静かな異常値を残さない)", () => {
    const huge = normalizeSettings({ defaultDisplayCount: 10_000_000 });
    expect(huge.defaultDisplayCount).toBe(100_000); // MAX_BATCH
    const negative = normalizeSettings({ defaultDisplayCount: -5 });
    expect(negative.defaultDisplayCount).toBe(1); // MIN_BATCH
  });

  it("妥当なフィールドは保持し、不正なフィールドだけ既定へ落とす (部分破損)", () => {
    const result = normalizeSettings({
      resultsInNewTab: true,
      accentColor: "#ff8800",
      themePreset: "nope",
    });
    expect(result.resultsInNewTab).toBe(true);
    expect(result.accentColor).toBe("#ff8800");
    expect(result.themePreset).toBe(DEFAULT_THEME_PRESET);
  });

  it("不正な 16 進カラーは既定パレットへ落ちる", () => {
    const result = normalizeSettings({
      syntaxColors: { light: { keyword: "red", string: "#00ff00" } },
    });
    // 不正な "red" は既定、妥当な "#00ff00" は採用される。
    expect(result.syntaxColors.light.keyword).toBe(DEFAULT_SETTINGS.syntaxColors.light.keyword);
    expect(result.syntaxColors.light.string).toBe("#00ff00");
  });
});

describe("settings ローダ (壊れた JSON 耐性)", () => {
  it("壊れた JSON 文字列でも store が既定で起動しクラッシュしない", async () => {
    localStorage.setItem("noobdb.settings", "{not valid json,,,");
    vi.resetModules();
    const mod = await import("../settings");
    expect(() => mod.getSettings()).not.toThrow();
    expect(mod.getSettings()).toEqual(mod.DEFAULT_SETTINGS);
  });

  it("JSON 配列 (非オブジェクト) でも既定で起動する", async () => {
    localStorage.setItem("noobdb.settings", JSON.stringify([1, 2, 3]));
    vi.resetModules();
    const mod = await import("../settings");
    expect(mod.getSettings()).toEqual(mod.DEFAULT_SETTINGS);
  });
});

describe("loadPersistedWorkspace (タブ永続化の破損耐性)", () => {
  const KEY = "noobdb.tabs.profile-1";

  it("壊れた JSON は空ワークスペースへフォールバックする (例外なし)", () => {
    localStorage.setItem(KEY, "{broken json");
    let ws!: ReturnType<typeof loadPersistedWorkspace>;
    expect(() => {
      ws = loadPersistedWorkspace("profile-1");
    }).not.toThrow();
    expect(ws).toEqual(EMPTY_WORKSPACE);
  });

  it("未知の形 (オブジェクトだが panes なし) は空ワークスペース", () => {
    localStorage.setItem(KEY, JSON.stringify({ foo: "bar" }));
    expect(loadPersistedWorkspace("profile-1")).toEqual(EMPTY_WORKSPACE);
  });

  it("旧形式 (タブのフラット配列) を 1 ペインとして復元する", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ kind: "query", title: "Q1", sql: "SELECT 1" }]),
    );
    const ws = loadPersistedWorkspace("profile-1");
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0].tabs).toHaveLength(1);
    expect(ws.panes[0].tabs[0].sql).toBe("SELECT 1");
  });

  it("不正なタブ (型不一致) を取り除き、有効なタブだけ残す", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { kind: "bogus", title: "X", sql: "SELECT 1" },
        { kind: "query", title: 42, sql: "SELECT 2" },
        { kind: "query", title: "ok", sql: "SELECT 3" },
      ]),
    );
    const ws = loadPersistedWorkspace("profile-1");
    expect(ws.panes[0].tabs.map((t) => t.sql)).toEqual(["SELECT 3"]);
  });

  it("キーが無いプロファイルは空ワークスペース", () => {
    expect(loadPersistedWorkspace("never-saved")).toEqual(EMPTY_WORKSPACE);
  });
});

describe("loadQuickAccess (クイックアクセスの破損耐性)", () => {
  const KEY = "noobdb.quickaccess.profile-1";

  it("壊れた JSON は空状態へフォールバックする (例外なし)", () => {
    localStorage.setItem(KEY, "}{not json");
    let state!: ReturnType<typeof loadQuickAccess>;
    expect(() => {
      state = loadQuickAccess("profile-1");
    }).not.toThrow();
    expect(state).toEqual(EMPTY_QUICK_ACCESS);
  });

  it("型不一致のエントリを捨てて妥当な参照だけ残す", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        favorites: [{ database: "db", table: "t1" }, { database: 1, table: "t2" }, "junk"],
        recent: "not-an-array",
      }),
    );
    const state = loadQuickAccess("profile-1");
    expect(state.favorites).toEqual([{ database: "db", table: "t1" }]);
    expect(state.recent).toEqual([]);
  });

  it("非オブジェクト JSON は空状態", () => {
    localStorage.setItem(KEY, JSON.stringify(123));
    expect(loadQuickAccess("profile-1")).toEqual(EMPTY_QUICK_ACCESS);
  });

  it("キーが無いプロファイルは空状態", () => {
    expect(loadQuickAccess("never-saved")).toEqual(EMPTY_QUICK_ACCESS);
  });
});

describe("normalizeGridView (グリッドのソート・列フィルタ #677 の破損耐性)", () => {
  it("非オブジェクト入力はすべて空へ落ちる", () => {
    for (const bad of [null, undefined, 42, "x", true, [1, 2, 3]]) {
      expect(normalizeGridView(bad)).toEqual({});
    }
  });

  it("妥当なソートと列フィルタは保持する", () => {
    const parsed = {
      sorting: [{ id: "1", desc: true }],
      filters: [{ id: "0", value: { op: "contains", value: "x", value2: "", nullMode: "any" } }],
    };
    expect(normalizeGridView(parsed)).toEqual(parsed);
  });

  it("未知の演算子・型不一致のフィルタ/ソートを捨てる", () => {
    const parsed = {
      sorting: [{ id: "1", desc: "yes" }, { id: 2, desc: true }, { id: "3", desc: false }],
      filters: [
        { id: "0", value: { op: "bogus", value: "x", value2: "", nullMode: "any" } },
        { id: "1", value: { op: "eq", value: "5", value2: "", nullMode: "wrong" } },
        { id: "2", value: { op: "gt", value: "3", value2: "", nullMode: "only" } },
      ],
    };
    const out = normalizeGridView(parsed);
    expect(out.sorting).toEqual([{ id: "3", desc: false }]);
    expect(out.filters).toEqual([
      { id: "2", value: { op: "gt", value: "3", value2: "", nullMode: "only" } },
    ]);
  });

  it("空の配列になったフィールドは省く", () => {
    expect(normalizeGridView({ sorting: [], filters: [] })).toEqual({});
  });

  it("readStoredGridView は壊れた JSON でも例外を投げず空を返す", () => {
    const KEY = "noobdb.gridview.v1::db::t::[\"a\"]";
    localStorage.setItem(KEY, "{broken");
    let out!: ReturnType<typeof readStoredGridView>;
    expect(() => {
      out = readStoredGridView(KEY);
    }).not.toThrow();
    expect(out).toEqual({});
  });

  it("書き込み→読み戻しのラウンドトリップ (実質デフォルトはキー削除)", () => {
    const KEY = "noobdb.gridview.v1::db::t::[\"a\"]";
    writeStoredGridView(KEY, { sorting: [{ id: "0", desc: true }] });
    expect(readStoredGridView(KEY)).toEqual({ sorting: [{ id: "0", desc: true }] });
    writeStoredGridView(KEY, {});
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("normalizeSchemaTree (スキーマツリー展開 #677 の破損耐性)", () => {
  it("非オブジェクト入力は空ツリーへ落ちる", () => {
    for (const bad of [null, undefined, 42, "x", true]) {
      expect(normalizeSchemaTree(bad)).toEqual({ dbs: {}, tables: {} });
    }
  });

  it("開いている DB / テーブルキー配列を Record へ変換し、非文字列は捨てる", () => {
    const out = normalizeSchemaTree({ dbs: ["db1", 2, "db2"], tables: ["db1::t1", null] });
    expect(out).toEqual({ dbs: { db1: true, db2: true }, tables: { "db1::t1": true } });
  });

  it("loadSchemaTree は壊れた JSON でも例外を投げず空を返す", () => {
    localStorage.setItem("noobdb.schematree.p1", "}{nope");
    let out!: ReturnType<typeof loadSchemaTree>;
    expect(() => {
      out = loadSchemaTree("p1");
    }).not.toThrow();
    expect(out).toEqual({ dbs: {}, tables: {} });
  });

  it("save→load のラウンドトリップ (閉じたキーは省く)", () => {
    saveSchemaTree("p1", { dbs: { db1: true, db2: false }, tables: { "db1::t1": true } });
    expect(loadSchemaTree("p1")).toEqual({ dbs: { db1: true }, tables: { "db1::t1": true } });
  });

  it("すべて閉じている状態はエントリを削除する", () => {
    saveSchemaTree("p1", { dbs: { db1: true }, tables: {} });
    expect(localStorage.getItem("noobdb.schematree.p1")).not.toBeNull();
    saveSchemaTree("p1", { dbs: { db1: false }, tables: {} });
    expect(localStorage.getItem("noobdb.schematree.p1")).toBeNull();
  });

  it("キーが無いプロファイルは空ツリー", () => {
    expect(loadSchemaTree("never")).toEqual({ dbs: {}, tables: {} });
  });
});

describe("normalizeCollapsedFolders (スニペットフォルダ開閉 #677 の破損耐性)", () => {
  it("非配列入力は空へ落ちる", () => {
    for (const bad of [null, undefined, 42, "x", {}]) {
      expect(normalizeCollapsedFolders(bad)).toEqual({});
    }
  });

  it("閉じているフォルダキー配列を { key: false } へ変換し、非文字列は捨てる", () => {
    expect(normalizeCollapsedFolders(["a", 1, "b", null])).toEqual({ a: false, b: false });
  });

  it("read は壊れた JSON でも例外を投げず空を返す", () => {
    localStorage.setItem("noobdb.snippetlist.collapsedFolders", "{broken");
    let out!: ReturnType<typeof readCollapsedSnippetFolders>;
    expect(() => {
      out = readCollapsedSnippetFolders();
    }).not.toThrow();
    expect(out).toEqual({});
  });

  it("write→read のラウンドトリップ (開いているフォルダは保存しない)", () => {
    writeCollapsedSnippetFolders({ a: false, b: true, c: false });
    expect(readCollapsedSnippetFolders()).toEqual({ a: false, c: false });
    writeCollapsedSnippetFolders({ a: true, b: true });
    expect(localStorage.getItem("noobdb.snippetlist.collapsedFolders")).toBeNull();
  });
});

describe("PersistedTab の忠実度フィールド (#678) の後方互換・破損耐性", () => {
  const KEY = "noobdb.tabs.profile-1";

  it("selection / gridScrollTop / pageSize を持つタブを復元する", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          kind: "table",
          title: "T",
          database: "db",
          table: "t",
          sql: "SELECT * FROM t",
          selection: { anchor: 3, head: 7 },
          gridScrollTop: 120,
          pageSize: 500,
        },
      ]),
    );
    const tab = loadPersistedWorkspace("profile-1").panes[0].tabs[0];
    expect(tab.selection).toEqual({ anchor: 3, head: 7 });
    expect(tab.gridScrollTop).toBe(120);
    expect(tab.pageSize).toBe(500);
  });

  it("新フィールドが無い旧タブもそのまま読める (後方互換)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ kind: "query", title: "Q", sql: "SELECT 1" }]),
    );
    const tab = loadPersistedWorkspace("profile-1").panes[0].tabs[0];
    expect(tab.sql).toBe("SELECT 1");
    expect(tab.selection).toBeUndefined();
    expect(tab.gridScrollTop).toBeUndefined();
    expect(tab.pageSize).toBeUndefined();
  });

  it("壊れた selection / 負値の scroll / pageSize は捨ててタブ自体は残す", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          kind: "query",
          title: "Q",
          sql: "SELECT 1",
          selection: { anchor: "x", head: 2 },
          gridScrollTop: -5,
          pageSize: 0,
        },
      ]),
    );
    const tab = loadPersistedWorkspace("profile-1").panes[0].tabs[0];
    expect(tab.sql).toBe("SELECT 1");
    expect(tab.selection).toBeUndefined();
    expect(tab.gridScrollTop).toBeUndefined();
    expect(tab.pageSize).toBeUndefined();
  });
});
