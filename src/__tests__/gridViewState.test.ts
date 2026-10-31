// @vitest-environment jsdom (localStorage に触れるため。DOM を使わないテストは node 環境で走る)
import { beforeEach, describe, expect, it } from "vitest";
import { touchColumnLayoutLru } from "../components/columnLayoutStorage";
import type { FilterOp } from "../components/gridSortFilter";
import {
  GRID_PRESET_MAX,
  condFormatKeyFrom,
  normalizeCondFormat,
  readStoredCondFormat,
  writeStoredCondFormat,
  GRID_PRESET_NAME_MAX,
  gridPresetsKeyFrom,
  normalizeGridPresets,
  normalizeGridView,
  normalizePresetName,
  readStoredGridPresets,
  removeGridPreset,
  resultShapeSizingKey,
  toPersistedGridView,
  upsertGridPreset,
  writeStoredGridPresets,
} from "../components/gridViewState";

const ALL_OPS: FilterOp[] = [
  "contains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "eq",
  "ne",
  "gt",
  "lt",
  "between",
];

describe("gridViewState の列フィルタ往復", () => {
  it.each(ALL_OPS)("演算子 %s が保存と復元で消えない", (op) => {
    const value = { op, value: "a", value2: "b", nullMode: "any" as const };
    const persisted = toPersistedGridView([], [{ id: "c", value }]);
    expect(persisted.filters).toEqual([{ id: "c", value }]);
    const restored = normalizeGridView(JSON.parse(JSON.stringify(persisted)));
    expect(restored.filters).toEqual([{ id: "c", value }]);
  });
});

describe("値のチェックリスト (in) の保存と復元 (#1628)", () => {
  it("values を保持して往復する", () => {
    const value = { op: "in" as const, value: "", value2: "", nullMode: "any" as const, values: ["a", "b"] };
    const persisted = toPersistedGridView([], [{ id: "c", value }]);
    const restored = normalizeGridView(JSON.parse(JSON.stringify(persisted)));
    expect(restored.filters).toEqual([{ id: "c", value }]);
  });
  it("values が配列でない in は捨てる", () => {
    const broken = { op: "in", value: "", value2: "", nullMode: "any", values: "a" };
    expect(normalizeGridView({ filters: [{ id: "c", value: broken }] }).filters).toBeUndefined();
  });
});

describe("名前付きビュープリセット (#1942)", () => {
  const view = {
    sorting: [{ id: "0", desc: true }],
    filters: [
      { id: "1", value: { op: "contains" as const, value: "x", value2: "", nullMode: "any" as const } },
    ],
    masks: { secret: false },
  };
  const layout = {
    order: ["1", "0"],
    visibility: { "2": false },
    pinning: { left: ["0"], right: [] },
    sizing: { "0": 120 },
  };

  beforeEach(() => localStorage.clear());

  it("キーは結果シェイプキーから導出し、キー無しは undefined", () => {
    const sk = resultShapeSizingKey([{ name: "a" }], "db", "t");
    expect(gridPresetsKeyFrom(sk)).toBe('noobdb.gridpresets.v1::db::t::["a"]');
    expect(gridPresetsKeyFrom(undefined)).toBeUndefined();
  });

  it("保存して読み戻すとビューとレイアウトが往復する", () => {
    const key = gridPresetsKeyFrom(resultShapeSizingKey([{ name: "a" }], "db", "t"));
    writeStoredGridPresets(key, [
      { name: "エラー行", view, layout },
      { name: "空", view: {} },
    ]);
    const back = readStoredGridPresets(key);
    expect(back).toEqual([
      { name: "エラー行", view, layout },
      { name: "空", view: {} },
    ]);
  });

  it("別シェイプ (列構成/テーブルが違う) のキーとは衝突しない", () => {
    const k1 = gridPresetsKeyFrom(resultShapeSizingKey([{ name: "a" }], "db", "t"));
    const k2 = gridPresetsKeyFrom(resultShapeSizingKey([{ name: "a" }, { name: "b" }], "db", "t"));
    const k3 = gridPresetsKeyFrom(resultShapeSizingKey([{ name: "a" }], "db", "u"));
    writeStoredGridPresets(k1, [{ name: "p", view }]);
    expect(readStoredGridPresets(k2)).toEqual([]);
    expect(readStoredGridPresets(k3)).toEqual([]);
    expect(readStoredGridPresets(k1)).toHaveLength(1);
  });

  it("空配列を書くとエントリごと削除する", () => {
    const key = "noobdb.gridpresets.v1::db::t::[]";
    writeStoredGridPresets(key, [{ name: "p", view }]);
    expect(localStorage.getItem(key)).not.toBeNull();
    writeStoredGridPresets(key, []);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("壊れた JSON・配列でない値は空配列にフォールバックする", () => {
    const key = "noobdb.gridpresets.v1::db::t::[]";
    localStorage.setItem(key, "{not json");
    expect(readStoredGridPresets(key)).toEqual([]);
    localStorage.setItem(key, JSON.stringify({ name: "x" }));
    expect(readStoredGridPresets(key)).toEqual([]);
  });

  it("不正なエントリ (名前無し・重複・未知演算子・型不一致レイアウト) は捨てる", () => {
    const out = normalizeGridPresets([
      null,
      { view },
      { name: "  " },
      {
        name: "a",
        view: { filters: [{ id: "0", value: { op: "bogus" } }] },
        layout: { order: [1], sizing: { "0": -3 } },
      },
      { name: "a", view },
      { name: "b", layout: "x" },
    ]);
    expect(out).toEqual([
      { name: "a", view: {} },
      { name: "b", view: {} },
    ]);
  });

  it("名前は前後の空白除去・最大長で切り詰める", () => {
    expect(normalizePresetName("  abc  ")).toBe("abc");
    expect(normalizePresetName("x".repeat(100))).toHaveLength(GRID_PRESET_NAME_MAX);
  });

  it("読み込み時に上限で打ち切る", () => {
    const many = Array.from({ length: GRID_PRESET_MAX + 5 }, (_, i) => ({ name: `p${i}`, view: {} }));
    expect(normalizeGridPresets(many)).toHaveLength(GRID_PRESET_MAX);
  });

  it("upsert: 同名は位置を保って上書き、新規は末尾、上限では full", () => {
    const a = { name: "a", view: {} };
    const b = { name: "b", view: {} };
    const r1 = upsertGridPreset([a, b], { name: " a ", view });
    expect(r1.presets.map((p) => p.name)).toEqual(["a", "b"]);
    expect(r1.presets[0]?.view).toEqual(view);
    const r2 = upsertGridPreset([a], b);
    expect(r2.presets.map((p) => p.name)).toEqual(["a", "b"]);
    expect(upsertGridPreset([a], { name: "  ", view: {} }).presets).toEqual([a]);
    const full = Array.from({ length: GRID_PRESET_MAX }, (_, i) => ({ name: `p${i}`, view: {} }));
    expect(upsertGridPreset(full, { name: "new", view: {} })).toEqual({ presets: full, full: true });
    expect(upsertGridPreset(full, { name: "p3", view }).full).toBe(false);
  });

  it("remove: 名前で削除する", () => {
    const list = [
      { name: "a", view: {} },
      { name: "b", view: {} },
    ];
    expect(removeGridPreset(list, "a")).toEqual([{ name: "b", view: {} }]);
    expect(removeGridPreset(list, "zzz")).toEqual(list);
  });

  it("LRU 退避で形状を追い出すとプリセットも一緒に消える", () => {
    const sk = resultShapeSizingKey([{ name: "a" }], "db", "t") as string;
    const key = gridPresetsKeyFrom(sk);
    writeStoredGridPresets(key, [{ name: "p", view }]);
    touchColumnLayoutLru(sk, 1);
    touchColumnLayoutLru("noobdb.colsizing.v1::db::other::[]", 1);
    expect(readStoredGridPresets(key)).toEqual([]);
  });
});

describe("条件付き書式の永続化 (#1958)", () => {
  const KEY = condFormatKeyFrom(resultShapeSizingKey([{ name: "a" }, { name: "b" }], "db", "t"));

  beforeEach(() => localStorage.clear());

  it("キーは結果シェイプキー体系に相乗りし、キー無しでは undefined", () => {
    expect(KEY).toContain("noobdb.gridcondfmt.v1::db::t::");
    expect(condFormatKeyFrom(undefined)).toBeUndefined();
  });

  it("書式・閾値・パレットが往復する", () => {
    const state = {
      formats: { 0: "bar" as const, 1: "threshold" as const },
      thresholds: { 1: { op: ">=" as const, value: 10, tone: "warning" as const } },
      palette: "teal",
    };
    writeStoredCondFormat(KEY, state);
    expect(readStoredCondFormat(KEY)).toEqual(state);
  });

  it("実質既定ならエントリを削除する", () => {
    writeStoredCondFormat(KEY, { formats: { 0: "heat" } });
    expect(localStorage.getItem(KEY as string)).not.toBeNull();
    writeStoredCondFormat(KEY, { formats: {} });
    expect(localStorage.getItem(KEY as string)).toBeNull();
  });

  it("閾値モードでない列の閾値ルールは保存しない", () => {
    writeStoredCondFormat(KEY, {
      formats: { 0: "bar" },
      thresholds: { 0: { op: ">", value: 1, tone: "danger" } },
    });
    expect(readStoredCondFormat(KEY)).toEqual({ formats: { 0: "bar" } });
  });

  it("壊れた JSON は空へフォールバックする", () => {
    localStorage.setItem(KEY as string, "{broken");
    expect(readStoredCondFormat(KEY)).toEqual({});
  });

  it("未知のモード・不正な列位置・不正な閾値・未知のパレットは捨てる", () => {
    const out = normalizeCondFormat({
      formats: { 0: "bar", 1: "sparkle", x: "heat", "-1": "bar", 2: 5 },
      thresholds: {
        0: { op: "~", value: 1, tone: "danger" },
        1: { op: ">", value: "1", tone: "danger" },
        2: { op: ">", value: 1, tone: "pink" },
        3: { op: "<", value: 2.5, tone: "success" },
      },
      palette: "toString",
    });
    expect(out).toEqual({
      formats: { 0: "bar" },
      thresholds: { 3: { op: "<", value: 2.5, tone: "success" } },
    });
  });

  it("配列・null・非オブジェクトは空", () => {
    expect(normalizeCondFormat(null)).toEqual({});
    expect(normalizeCondFormat([])).toEqual({});
    expect(normalizeCondFormat("x")).toEqual({});
    expect(normalizeCondFormat({ formats: [], thresholds: "x" })).toEqual({});
  });
});
