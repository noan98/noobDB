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
