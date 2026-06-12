import { describe, it, expect } from "vitest";
import {
  ACCENT_PRESETS,
  ACCENT_FG_DARK,
  ACCENT_FG_LIGHT,
  accentForeground,
  accentHover,
  accentVars,
  contrastRatio,
  parseHex,
} from "../accent";

/**
 * グローバルアクセント色の純粋ロジックの回帰テスト。前景コントラスト保証と
 * hover の明暗方向、CSS 変数算出を固定する。
 */

const sum = (hex: string): number => {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`not a hex: ${hex}`);
  return rgb[0] + rgb[1] + rgb[2];
};

describe("parseHex", () => {
  it("parses #rrggbb into rgb", () => {
    expect(parseHex("#000000")).toEqual([0, 0, 0]);
    expect(parseHex("#ffffff")).toEqual([255, 255, 255]);
    expect(parseHex("#2563eb")).toEqual([0x25, 0x63, 0xeb]);
  });

  it("rejects malformed input", () => {
    expect(parseHex("#fff")).toBeNull();
    expect(parseHex("2563eb")).toBeNull();
    expect(parseHex("#xyzxyz")).toBeNull();
    expect(parseHex("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white and symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });

  it("is 1:1 for identical colors", () => {
    expect(contrastRatio("#2563eb", "#2563eb")).toBeCloseTo(1, 5);
  });

  it("returns 1 for invalid input", () => {
    expect(contrastRatio("nope", "#ffffff")).toBe(1);
  });
});

describe("accentForeground", () => {
  it("picks dark text on a light accent and light text on a dark accent", () => {
    expect(accentForeground("#ffffff")).toBe(ACCENT_FG_DARK);
    expect(accentForeground("#000000")).toBe(ACCENT_FG_LIGHT);
  });

  it("falls back to light text for invalid input", () => {
    expect(accentForeground("bogus")).toBe(ACCENT_FG_LIGHT);
  });

  it("keeps every built-in preset's foreground at WCAG AA (>= 4.5:1)", () => {
    for (const p of ACCENT_PRESETS) {
      if (p.hex === null) continue;
      const fg = accentForeground(p.hex);
      const ratio = contrastRatio(fg, p.hex);
      expect(
        ratio,
        `preset ${p.key} (${p.hex}) with fg ${fg} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("accentHover", () => {
  it("darkens in light theme and lightens in dark theme", () => {
    const base = "#2563eb";
    expect(sum(accentHover(base, "light"))).toBeLessThan(sum(base));
    expect(sum(accentHover(base, "dark"))).toBeGreaterThan(sum(base));
  });

  it("returns the input unchanged for invalid hex", () => {
    expect(accentHover("nope", "light")).toBe("nope");
  });
});

describe("accentVars", () => {
  it("keeps the chosen accent and derives hover + text", () => {
    const v = accentVars("#2563eb", "light");
    expect(v.accent).toBe("#2563eb");
    expect(v.accentText).toBe(accentForeground("#2563eb"));
    expect(v.accentHover).toBe(accentHover("#2563eb", "light"));
  });
});
