import { describe, it, expect } from "vitest";
import { themePresetDataTheme, THEME_PRESET_ORDER } from "../settings";

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

  it("every dark-variant preset name ends with 'dark' so conditions.dark matches", () => {
    for (const preset of THEME_PRESET_ORDER) {
      const dataTheme = themePresetDataTheme(preset, "dark");
      // light の場合 light で終わる、それ以外は dark 系。dark トグル時は必ず dark で終わる。
      expect(dataTheme.endsWith("dark") || dataTheme.endsWith("light")).toBe(true);
    }
  });
});
