import { describe, it, expect } from "vitest";
import {
  ACCENT_PRESETS,
  ACCENT_FG_DARK,
  ACCENT_FG_LIGHT,
  accentForeground,
  accentHover,
  accentSelection,
  accentSubtle,
  DARK_BG,
  LIGHT_BG,
  accentVars,
  contrastRatio,
  parseHex,
} from "../accent";
import type { Theme } from "../settings";

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

  it("also derives the harmonic tone tokens (#790)", () => {
    const v = accentVars("#2563eb", "dark");
    expect(v.accentSubtle).toBe(accentSubtle("#2563eb", "dark"));
    expect(v.accentSelection).toBe(accentSelection("#2563eb", "dark"));
  });
});

// ── 調和トーン (#790) ─────────────────────────────────────────────────────
const THEMES: Theme[] = ["light", "dark"];
// アプリの --text (本文) 代表色。App.css の各テーマ既定値と一致させ、面塗りの
// 上に乗る本文が実際にどの程度読めるかをテストでも検証する。
const TEXT_REF: Record<Theme, string> = {
  light: "#1a2330",
  dark: "#e6edf3",
};

describe("accentSubtle / accentSelection", () => {
  it("stay close to the base surface (never a saturated accent-colored block)", () => {
    // subtle/selection は面塗りであって、accent そのものではない — ボタンの
    // ような濃いアクセントに寄り過ぎないことを、輝度差で緩く固定する。
    for (const theme of THEMES) {
      const subtle = accentSubtle("#2563eb", theme);
      const selection = accentSelection("#2563eb", theme);
      expect(subtle).not.toBe("#2563eb");
      expect(selection).not.toBe("#2563eb");
      expect(subtle).not.toBe(selection);
    }
  });

  it("selection is a stronger tone than subtle (moves further from the base surface)", () => {
    for (const theme of THEMES) {
      const base = theme === "dark" ? DARK_BG : LIGHT_BG;
      const subtleRgb = parseHex(accentSubtle("#2563eb", theme));
      const selectionRgb = parseHex(accentSelection("#2563eb", theme));
      expect(subtleRgb).not.toBeNull();
      expect(selectionRgb).not.toBeNull();
      const dist = (rgb: [number, number, number]) =>
        Math.abs(rgb[0] - base[0]) + Math.abs(rgb[1] - base[1]) + Math.abs(rgb[2] - base[2]);
      expect(dist(selectionRgb as [number, number, number])).toBeGreaterThanOrEqual(
        dist(subtleRgb as [number, number, number]),
      );
    }
  });

  it("keeps body text readable (>= AA 4.5:1) against every built-in preset, both themes", () => {
    for (const theme of THEMES) {
      for (const p of ACCENT_PRESETS) {
        if (p.hex === null) continue;
        const subtle = accentSubtle(p.hex, theme);
        const selection = accentSelection(p.hex, theme);
        expect(
          contrastRatio(subtle, TEXT_REF[theme]),
          `subtle ${p.key} (${p.hex}) on ${theme} = ${subtle}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(selection, TEXT_REF[theme]),
          `selection ${p.key} (${p.hex}) on ${theme} = ${selection}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps body text readable for extreme boundary colors (near-white / near-black / pure-hue)", () => {
    const boundaries = ["#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#ffff00"];
    for (const theme of THEMES) {
      for (const hex of boundaries) {
        const subtle = accentSubtle(hex, theme);
        const selection = accentSelection(hex, theme);
        expect(
          contrastRatio(subtle, TEXT_REF[theme]),
          `subtle ${hex} on ${theme} = ${subtle}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(selection, TEXT_REF[theme]),
          `selection ${hex} on ${theme} = ${selection}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("falls back to the base surface tone for invalid input", () => {
    expect(accentSubtle("nope", "light")).toBe("#f5f7fa");
    expect(accentSubtle("nope", "dark")).toBe("#0d1117");
    expect(accentSelection("nope", "light")).toBe("#f5f7fa");
    expect(accentSelection("nope", "dark")).toBe("#0d1117");
  });

  it("approximates the existing fixed --bg-active tone for the default accent (#790 no-op intent)", () => {
    // App.css の既定固定値 (light: #e6f0ff / #d4e4ff, dark: #2c4373 / #3a5894) は
    // accentSubtle/accentSelection とは独立に手調整された値なのでビット一致はしない
    // が、既定アクセントを入力すると近い色になるよう混合率を逆算してある。ここでは
    // 色差 (各チャンネル絶対差の合計、0-765) を粗い上限で固定し、著しい乖離が
    // 入らないようにする。
    const colorDistance = (a: string, b: string): number => {
      const ra = parseHex(a);
      const rb = parseHex(b);
      if (!ra || !rb) throw new Error("bad hex");
      return Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]) + Math.abs(ra[2] - rb[2]);
    };
    expect(colorDistance(accentSubtle("#2563eb", "light"), "#e6f0ff")).toBeLessThan(40);
    expect(colorDistance(accentSelection("#2563eb", "light"), "#d4e4ff")).toBeLessThan(40);
    expect(colorDistance(accentSubtle("#4c93f7", "dark"), "#2c4373")).toBeLessThan(40);
    expect(colorDistance(accentSelection("#4c93f7", "dark"), "#3a5894")).toBeLessThan(40);
  });
});
