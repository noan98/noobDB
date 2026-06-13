import { describe, it, expect } from "vitest";
import {
  SEQUENTIAL_RAMPS,
  DIVERGING_RAMPS,
  CATEGORICAL,
  sampleRamp,
  categoricalColor,
  readableInk,
  INK_DARK,
  INK_LIGHT,
} from "../colorScale";

// データ可視化カラースケール体系 (#525) の値 → 色マッピング純関数の検証。
// 最小/最大/NaN/退化など境界を固定し、チャート・ヒートマップ・データバーが
// 共有する色定義のリグレッションをここで防ぐ。

describe("sampleRamp (#525)", () => {
  const blue = SEQUENTIAL_RAMPS.blue.stops; // ["#eff6ff", "#93c5fd", "#1d4ed8"]

  it("returns endpoint colors at t=0 and t=1", () => {
    expect(sampleRamp(0, blue)).toBe("rgb(239, 246, 255)"); // #eff6ff
    expect(sampleRamp(1, blue)).toBe("rgb(29, 78, 216)"); // #1d4ed8
  });

  it("returns the middle stop exactly at the midpoint of a 3-stop ramp", () => {
    expect(sampleRamp(0.5, blue)).toBe("rgb(147, 197, 253)"); // #93c5fd
  });

  it("interpolates linearly between adjacent stops", () => {
    // 0.25 は先頭 (#eff6ff) と中央 (#93c5fd) の中点。
    const [r1, g1, b1] = [0xef, 0xf6, 0xff];
    const [r2, g2, b2] = [0x93, 0xc5, 0xfd];
    const mid = (a: number, b: number) => Math.round(a + (b - a) * 0.5);
    expect(sampleRamp(0.25, blue)).toBe(`rgb(${mid(r1, r2)}, ${mid(g1, g2)}, ${mid(b1, b2)})`);
  });

  it("clamps t outside [0,1]", () => {
    expect(sampleRamp(-1, blue)).toBe(sampleRamp(0, blue));
    expect(sampleRamp(2, blue)).toBe(sampleRamp(1, blue));
  });

  it("treats NaN / non-finite as 0 (safe side for NULL / non-numeric)", () => {
    expect(sampleRamp(NaN, blue)).toBe(sampleRamp(0, blue));
    expect(sampleRamp(Infinity, blue)).toBe(sampleRamp(0, blue));
    expect(sampleRamp(-Infinity, blue)).toBe(sampleRamp(0, blue));
  });

  it("returns the single color for a 1-stop ramp regardless of t", () => {
    expect(sampleRamp(0, ["#1d4ed8"])).toBe("rgb(29, 78, 216)");
    expect(sampleRamp(0.7, ["#1d4ed8"])).toBe("rgb(29, 78, 216)");
  });

  it("samples a diverging ramp with a pale center", () => {
    const cool = DIVERGING_RAMPS.coolWarm.stops; // blue → near-white → red
    expect(sampleRamp(0, cool)).toBe("rgb(37, 99, 235)"); // #2563eb
    expect(sampleRamp(0.5, cool)).toBe("rgb(248, 250, 252)"); // #f8fafc
    expect(sampleRamp(1, cool)).toBe("rgb(220, 38, 38)"); // #dc2626
  });
});

describe("categoricalColor (#525)", () => {
  it("maps indices 0..n-1 to the palette in order", () => {
    CATEGORICAL.forEach((hex, i) => {
      expect(categoricalColor(i)).toBe(hex);
    });
  });

  it("cycles when the index exceeds the palette length", () => {
    expect(categoricalColor(CATEGORICAL.length)).toBe(CATEGORICAL[0]);
    expect(categoricalColor(CATEGORICAL.length + 2)).toBe(CATEGORICAL[2]);
  });

  it("handles negative and fractional indices safely", () => {
    expect(categoricalColor(-1)).toBe(CATEGORICAL[CATEGORICAL.length - 1]);
    expect(categoricalColor(2.9)).toBe(CATEGORICAL[2]); // floors
  });

  it("falls back to the first color for NaN / non-finite", () => {
    expect(categoricalColor(NaN)).toBe(CATEGORICAL[0]);
    expect(categoricalColor(Infinity)).toBe(CATEGORICAL[0]);
  });

  it("only contains valid #rrggbb hex colors", () => {
    for (const hex of CATEGORICAL) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("readableInk (#525/#526)", () => {
  it("uses dark ink on light fills (yellow / grey) and white on dark fills", () => {
    expect(readableInk("#ccbb44")).toBe(INK_DARK); // categorical yellow
    expect(readableInk("#bbbbbb")).toBe(INK_DARK); // categorical grey
    expect(readableInk("#4477aa")).toBe(INK_LIGHT); // categorical blue
    expect(readableInk("#228833")).toBe(INK_LIGHT); // categorical green
  });

  it("handles white and black extremes", () => {
    expect(readableInk("#ffffff")).toBe(INK_DARK);
    expect(readableInk("#000000")).toBe(INK_LIGHT);
  });

  it("falls back to dark ink for invalid hex", () => {
    expect(readableInk("not-a-color")).toBe(INK_DARK);
  });
});

describe("color-blind safety metadata (#525)", () => {
  it("ships color-blind-safe sequential ramps (single hue, read by lightness)", () => {
    expect(Object.values(SEQUENTIAL_RAMPS).every((r) => r.colorBlindSafe)).toBe(true);
  });

  it("offers at least one color-blind-safe diverging ramp", () => {
    expect(Object.values(DIVERGING_RAMPS).some((r) => r.colorBlindSafe)).toBe(true);
    expect(DIVERGING_RAMPS.blueOrange.colorBlindSafe).toBe(true);
    expect(DIVERGING_RAMPS.coolWarm.colorBlindSafe).toBe(false);
  });

  it("provides enough distinct categorical colors for multi-series charts", () => {
    expect(new Set(CATEGORICAL).size).toBe(CATEGORICAL.length);
    expect(CATEGORICAL.length).toBeGreaterThanOrEqual(6);
  });
});
