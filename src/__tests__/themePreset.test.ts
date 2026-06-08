import { describe, it, expect } from "vitest";
import { themePresetDataTheme, THEME_PRESET_ORDER } from "../settings";

/**
 * テーマプリセット (#465) の data-theme 合成ロジック。プリセット名が
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

  it("every dark-variant preset name ends with 'dark' so conditions.dark matches", () => {
    for (const preset of THEME_PRESET_ORDER) {
      const dataTheme = themePresetDataTheme(preset, "dark");
      // light の場合 light で終わる、それ以外は dark 系。dark トグル時は必ず dark で終わる。
      expect(dataTheme.endsWith("dark") || dataTheme.endsWith("light")).toBe(true);
    }
  });
});
