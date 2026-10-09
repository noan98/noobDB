import { describe, it, expect } from "vitest";
import app from "../App.tsx?raw";
import view from "../components/SettingsView.tsx?raw";
import {
  DEFAULT_SYNTAX_COLORS,
  effectiveTheme,
  themePresetDataTheme,
  THEME_PRESET_ORDER,
  type Theme,
  type ThemePreset,
} from "../settings";

/**
 * テーマプリセットの data-theme 合成ロジック。プリセット名が
 * theme.ts の `conditions.dark` ([data-theme$=dark]) と整合することを固定する。
 */
describe("themePresetDataTheme (#465)", () => {
  it("default follows the light/dark toggle", () => {
    expect(themePresetDataTheme("default", "light")).toBe("light");
    expect(themePresetDataTheme("default", "dark")).toBe("dark");
  });

  it("dracula is dark-only and ends with -dark", () => {
    expect(themePresetDataTheme("dracula", "light")).toBe("dracula-dark");
    expect(themePresetDataTheme("dracula", "dark")).toBe("dracula-dark");
  });

  it("nord / one-dark are dark-only and end with dark (#598)", () => {
    expect(themePresetDataTheme("nord", "light")).toBe("nord-dark");
    expect(themePresetDataTheme("nord", "dark")).toBe("nord-dark");
    expect(themePresetDataTheme("one-dark", "light")).toBe("one-dark");
    expect(themePresetDataTheme("one-dark", "dark")).toBe("one-dark");
  });

  it("solarized follows the light/dark toggle (#598)", () => {
    expect(themePresetDataTheme("solarized", "light")).toBe("solarized-light");
    expect(themePresetDataTheme("solarized", "dark")).toBe("solarized-dark");
  });

  it("catppuccin is dark-only; tokyo-night follows the light/dark toggle (#1237)", () => {
    expect(themePresetDataTheme("catppuccin", "light")).toBe("catppuccin-dark");
    expect(themePresetDataTheme("catppuccin", "dark")).toBe("catppuccin-dark");
    expect(themePresetDataTheme("tokyo-night", "light")).toBe("tokyo-night-light");
    expect(themePresetDataTheme("tokyo-night", "dark")).toBe("tokyo-night-dark");
  });

  it("every dark-variant preset name ends with 'dark' so conditions.dark matches", () => {
    for (const preset of THEME_PRESET_ORDER) {
      const dataTheme = themePresetDataTheme(preset, "dark");
      // light の場合 light で終わる、それ以外は dark 系。dark トグル時は必ず dark で終わる。
      expect(dataTheme.endsWith("dark") || dataTheme.endsWith("light")).toBe(true);
    }
  });
});

describe("effectiveTheme (#1237 レビュー指摘)", () => {
  const darkOnly: ThemePreset[] = ["dracula", "nord", "one-dark", "catppuccin"];
  const follows: ThemePreset[] = ["default", "solarized", "tokyo-night", "high-contrast", "colorblind"];

  it("ダーク専用プリセットはトグルに関わらず dark", () => {
    for (const p of darkOnly) {
      expect(effectiveTheme(p, "light")).toBe("dark");
      expect(effectiveTheme(p, "dark")).toBe("dark");
    }
  });

  it("ライト/ダーク追従プリセットはトグルに従う", () => {
    for (const p of follows) {
      expect(effectiveTheme(p, "light")).toBe("light");
      expect(effectiveTheme(p, "dark")).toBe("dark");
    }
  });

  it("全プリセットを網羅している", () => {
    expect([...darkOnly, ...follows].sort()).toEqual([...THEME_PRESET_ORDER].sort());
  });

  it("トグル light + Catppuccin ではダーク用の syntaxColors が選ばれる", () => {
    const toggle: Theme = "light";
    const picked = DEFAULT_SYNTAX_COLORS[effectiveTheme("catppuccin", toggle)];
    expect(picked).toBe(DEFAULT_SYNTAX_COLORS.dark);
    expect(picked).not.toBe(DEFAULT_SYNTAX_COLORS.light);
  });

  it("App.tsx / SettingsView は syntaxColors をトグル値ではなく実効テーマで引く", () => {
    expect(app).not.toMatch(/syntaxColors\[theme\]/);
    expect(app).toMatch(/syntaxColors\[effTheme\]/);
    expect(view).toMatch(/effectiveTheme\(settings\.themePreset/);
  });
});
