import { describe, expect, it } from "vitest";
import type { TableStatRow } from "../components/tableSize";
import {
  INDEX_HEAVY_MIN_BYTES,
  TREEMAP_CHAR_W,
  TREEMAP_PAD,
  TREEMAP_OTHER_ID,
  growthRate,
  isIndexHeavy,
  layoutTileLabel,
  layoutTableTreemap,
  neighborTile,
  squarify,
} from "../components/tableTreemap";

function row(name: string, over: Partial<TableStatRow> = {}): TableStatRow {
  return {
    name,
    row_estimate: 100,
    data_bytes: 600,
    index_bytes: 400,
    total_bytes: 1000,
    dead_rows: null,
    last_vacuum_at: null,
    last_analyze_at: null,
    columnCount: 1,
    indexCount: 1,
    hasPrimaryKey: true,
    foreignKeyCount: 0,
    change: null,
    ...over,
  } as TableStatRow;
}

const SIZE = { width: 400, height: 200 };
const area = (r: { w: number; h: number }) => r.w * r.h;

describe("squarify", () => {
  it("面積が値に比例し、矩形全体を隙間なく埋める", () => {
    const out = squarify(
      [{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }],
      { x: 0, y: 0, w: 600, h: 400 },
    );
    expect(out).toHaveLength(7);
    const total = out.reduce((s, r) => s + area(r), 0);
    expect(total).toBeCloseTo(600 * 400, 3);
    for (const r of out) {
      expect(area(r) / total).toBeCloseTo(r.value / 24, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it("矩形同士が重ならない", () => {
    const out = squarify([{ value: 5 }, { value: 3 }, { value: 3 }, { value: 1 }], {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox > 1e-6 && oy > 1e-6).toBe(false);
      }
    }
  });

  it("0 以下・非有限・空・面積 0 の矩形は何も返さない", () => {
    expect(squarify([], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(
      squarify([{ value: 0 }, { value: -1 }, { value: Number.NaN }], { x: 0, y: 0, w: 10, h: 10 }),
    ).toEqual([]);
    expect(squarify([{ value: 1 }], { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });

  it("1 件なら矩形全体を占める。入力は変更しない", () => {
    const input = [{ value: 2 }, { value: 9 }];
    const out = squarify(input, { x: 5, y: 7, w: 20, h: 10 });
    expect(input[0].value).toBe(2);
    expect(out[0].value).toBe(9);
    expect(squarify([{ value: 3 }], { x: 5, y: 7, w: 20, h: 10 })[0]).toMatchObject({
      x: 5,
      y: 7,
      w: 20,
      h: 10,
    });
  });
});

describe("layoutTableTreemap", () => {
  it("サイズ不明 (null) と 0 は面積に使わず別枠へ分ける", () => {
    const l = layoutTableTreemap(
      [row("a"), row("b", { total_bytes: null }), row("c", { total_bytes: 0 })],
      SIZE,
      0,
    );
    expect(l.tiles.map((t) => t.id)).toEqual(["a"]);
    expect(l.unknown).toEqual(["b"]);
    expect(l.empty).toEqual(["c"]);
    expect(l.totalBytes).toBe(1000);
  });

  it("全テーブルがサイズ不明ならタイルは空", () => {
    const l = layoutTableTreemap([row("a", { total_bytes: null })], SIZE, 0);
    expect(l.tiles).toEqual([]);
    expect(l.unknown).toEqual(["a"]);
  });

  it("小さすぎる表 (2 件以上) は「その他」に集約し、1 件だけなら集約しない", () => {
    const big = row("big", { total_bytes: 100000 });
    const l = layoutTableTreemap(
      [big, row("s1", { total_bytes: 10 }), row("s2", { total_bytes: 20 })],
      SIZE,
      0,
    );
    const other = l.tiles.find((t) => t.id === TREEMAP_OTHER_ID);
    expect(other?.count).toBe(2);
    expect(other?.value).toBe(30);
    expect(other?.members.sort()).toEqual(["s1", "s2"]);
    const single = layoutTableTreemap([big, row("s1", { total_bytes: 10 })], SIZE, 0);
    expect(single.tiles.map((t) => t.id).sort()).toEqual(["big", "s1"]);
  });

  it("タイル数の上限を超えた分は「その他」へ集約する", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, { total_bytes: 1000 - i }));
    const l = layoutTableTreemap(rows, SIZE, 0, { maxTiles: 4 });
    expect(l.tiles).toHaveLength(4);
    expect(l.tiles.filter((t) => t.id !== TREEMAP_OTHER_ID)).toHaveLength(3);
    expect(l.tiles.find((t) => t.id === TREEMAP_OTHER_ID)?.count).toBe(7);
  });

  it("面積の割合 share と data / index の比率を持つ。内訳が不明なら null", () => {
    const l = layoutTableTreemap(
      [row("a", { total_bytes: 750 }), row("b", { total_bytes: 250, index_bytes: null })],
      SIZE,
      0,
    );
    const a = l.tiles.find((t) => t.id === "a");
    const b = l.tiles.find((t) => t.id === "b");
    expect(a?.share).toBeCloseTo(0.75);
    expect(a?.dataShare).toBeCloseTo(0.6);
    expect(b?.dataShare).toBeNull();
  });

  it("肥大・インデックス過大・前回比の増加を判定する", () => {
    const l = layoutTableTreemap(
      [
        row("bloat", { total_bytes: 1000000, row_estimate: 1000, dead_rows: 1000, last_analyze_at: 1e12 }),
        row("idx", {
          data_bytes: 1,
          index_bytes: INDEX_HEAVY_MIN_BYTES * 2,
          total_bytes: INDEX_HEAVY_MIN_BYTES * 2 + 1,
        }),
        row("grow", { total_bytes: 1000000, change: { since: "x", rows: null, totalBytes: 250000 } }),
        row("plain", { total_bytes: 1000000 }),
      ],
      SIZE,
      0,
    );
    const g = (id: string) => l.tiles.find((t) => t.id === id);
    expect(g("bloat")?.bloated).toBe(true);
    expect(g("plain")?.bloated).toBe(false);
    expect(g("idx")?.indexHeavy).toBe(true);
    expect(g("grow")?.growth).toBeCloseTo(250000 / 750000);
    expect(g("plain")?.growth).toBeNull();
  });
});

describe("growthRate / isIndexHeavy", () => {
  it("増加していない・前回が 0・不明は null", () => {
    const ch = (d: number | null) => ({ since: "x", rows: null, totalBytes: d });
    expect(growthRate({ total_bytes: 100, change: ch(-5) })).toBeNull();
    expect(growthRate({ total_bytes: 100, change: ch(0) })).toBeNull();
    expect(growthRate({ total_bytes: 100, change: ch(100) })).toBeNull();
    expect(growthRate({ total_bytes: 100, change: ch(null) })).toBeNull();
    expect(growthRate({ total_bytes: null, change: ch(5) })).toBeNull();
    expect(growthRate({ total_bytes: 100, change: null })).toBeNull();
    expect(growthRate({ total_bytes: 150, change: ch(50) })).toBeCloseTo(0.5);
  });

  it("インデックスが data を超え、かつ最小サイズ以上のときだけ true。不明は false", () => {
    const big = INDEX_HEAVY_MIN_BYTES;
    expect(isIndexHeavy({ data_bytes: 10, index_bytes: big })).toBe(true);
    expect(isIndexHeavy({ data_bytes: 10, index_bytes: big - 1 })).toBe(false);
    expect(isIndexHeavy({ data_bytes: big * 2, index_bytes: big })).toBe(false);
    expect(isIndexHeavy({ data_bytes: null, index_bytes: big })).toBe(false);
    expect(isIndexHeavy({ data_bytes: 10, index_bytes: null })).toBe(false);
  });
});

describe("neighborTile", () => {
  const tiles = [
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 100, y: 0, w: 100, h: 50 },
    { id: "c", x: 100, y: 50, w: 100, h: 50 },
  ];
  it("方向ごとに最も近いタイルを返す", () => {
    expect(neighborTile(tiles, "a", "right")).toBe("b");
    expect(neighborTile(tiles, "b", "down")).toBe("c");
    expect(neighborTile(tiles, "c", "up")).toBe("b");
    expect(neighborTile(tiles, "c", "left")).toBe("a");
  });
  it("その方向に無い・不明な id は null", () => {
    expect(neighborTile(tiles, "a", "left")).toBeNull();
    expect(neighborTile(tiles, "zzz", "left")).toBeNull();
  });
});

describe("layoutTileLabel (名前と増加率が重ならない)", () => {
  const textW = (n: number) => n * TREEMAP_CHAR_W;

  it("広いタイルは名前を切らず、増加率の三角は右端の数字の左に置く", () => {
    const l = layoutTileLabel("users", 300, "12%");
    expect(l.name).toBe("users");
    expect(l.growth).toBe("12%");
    // 名前の右端 < 三角の左端、三角 + 数字は右の余白内に収まる。
    expect(TREEMAP_PAD + textW("users".length)).toBeLessThanOrEqual(l.growthTriangleX);
    expect(l.growthTriangleX + 10 + textW(3)).toBeLessThanOrEqual(300 - TREEMAP_PAD + 1);
  });

  it("増加率が長い (6 文字) ほど三角が左へ寄り、名前の切り詰め幅も狭まる", () => {
    const short = layoutTileLabel("a_long_table_name_here", 200, "9%");
    const long = layoutTileLabel("a_long_table_name_here", 200, "1234.5%");
    expect(long.growthTriangleX).toBeLessThan(short.growthTriangleX);
    expect(long.name.length).toBeLessThanOrEqual(short.name.length);
    for (const l of [short, long]) {
      expect(TREEMAP_PAD + textW(l.name.length)).toBeLessThanOrEqual(l.growthTriangleX);
    }
  });

  it("名前を最低限残せない幅では増加率を省き、名前に全幅を使う", () => {
    const l = layoutTileLabel("orders", 90, "100.0%");
    expect(l.growth).toBe("");
    expect(l.name).not.toBe("");
  });

  it("幅 90 未満・増加率なしでは増加率を出さない", () => {
    expect(layoutTileLabel("t", 80, "5%").growth).toBe("");
    expect(layoutTileLabel("users", 300, "").growth).toBe("");
  });

  it("どの幅でも、増加率を出すなら名前と重ならない", () => {
    for (let w = 40; w <= 400; w += 7) {
      const l = layoutTileLabel("customer_orders", w, "45%");
      if (l.growth) {
        expect(TREEMAP_PAD + textW(l.name.length)).toBeLessThanOrEqual(l.growthTriangleX);
      }
    }
  });
});
