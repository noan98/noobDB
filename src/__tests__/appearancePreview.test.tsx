// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AppearancePreview } from "../components/AppearancePreview";
import { renderWithProviders, screen } from "./testUtils";
import { accentVars } from "../accent";
import { DEFAULT_SYNTAX_COLORS } from "../settings";
import { system } from "../theme";
import {
  appearancePreviewVars,
  PREVIEW_VAR_TOKENS,
  previewChakraVar,
  themePreviewColors,
  type AppearancePreviewInput,
} from "../themePresetPreview";

const base: AppearancePreviewInput = {
  previewPreset: null,
  previewAccent: null,
  currentPreset: "default",
  toggleTheme: "dark",
  accentColor: null,
  syntaxColors: DEFAULT_SYNTAX_COLORS,
};

describe("appearancePreviewVars (#1581)", () => {
  it("何もホバーしていなければ上書きしない (現在の設定がトークン経由で映る)", () => {
    expect(appearancePreviewVars(base)).toEqual({});
  });

  it("プリセットは代表色を CSS 変数と対応する Chakra 変数の両方で上書きする", () => {
    const c = themePreviewColors("dracula", "dark");
    const v = appearancePreviewVars({ ...base, previewPreset: "dracula" });
    expect(v["--bg"]).toBe(c.bg);
    expect(v["--text"]).toBe(c.text);
    expect(v["--accent"]).toBe(c.accent);
    expect(v["--chakra-colors-app-bg"]).toBe(c.bg);
    expect(v["--chakra-colors-app-accent"]).toBe(c.accent);
  });

  it("シンタックス色はプリセットの代表色ではなく settings.syntaxColors[実効テーマ] から入れる", () => {
    const custom = {
      light: DEFAULT_SYNTAX_COLORS.light,
      dark: { ...DEFAULT_SYNTAX_COLORS.dark, keyword: "#010203" },
    };
    const v = appearancePreviewVars({ ...base, previewPreset: "dracula", syntaxColors: custom });
    expect(v["--syntax-keyword"]).toBe("#010203");
    expect(v["--chakra-colors-app-syntax-keyword"]).toBe("#010203");
    expect(v["--syntax-string"]).toBe(DEFAULT_SYNTAX_COLORS.dark.string);
  });

  it("ダーク専用プリセットは、トグルがライトでも実効テーマ (ダーク) のシンタックス色を使う", () => {
    const v = appearancePreviewVars({ ...base, toggleTheme: "light", previewPreset: "dracula" });
    expect(v["--syntax-keyword"]).toBe(DEFAULT_SYNTAX_COLORS.dark.keyword);
    const light = appearancePreviewVars({ ...base, toggleTheme: "light", previewPreset: "default" });
    expect(light["--syntax-keyword"]).toBe(DEFAULT_SYNTAX_COLORS.light.keyword);
  });

  it("保存済みアクセントがあれば、プリセットのアクセントで上書きしない (App.tsx と同じ)", () => {
    const v = appearancePreviewVars({ ...base, previewPreset: "dracula", accentColor: "#e11d48" });
    expect(v["--accent"]).toBe("#e11d48");
    const expected = accentVars("#e11d48", "dark", {
      bg: themePreviewColors("dracula", "dark").bg,
      text: themePreviewColors("dracula", "dark").text,
    });
    expect(v["--accent-hover"]).toBe(expected.accentHover);
    expect(v["--accent-text"]).toBe(expected.accentText);
    expect(v["--bg-active"]).toBe(expected.accentSubtle);
  });

  it("アクセント系は accentVars と同じ式 (hover / 前景) で導く。ホバー中のスウォッチが最優先", () => {
    const v = appearancePreviewVars({ ...base, previewAccent: { hex: "#0f766e" }, accentColor: "#e11d48" });
    const c = themePreviewColors("default", "dark");
    const expected = accentVars("#0f766e", "dark", { bg: c.bg, text: c.text });
    expect(v["--accent"]).toBe("#0f766e");
    expect(v["--accent-hover"]).toBe(expected.accentHover);
    expect(v["--accent-text"]).toBe(expected.accentText);
    expect(v["--bg-active-strong"]).toBe(expected.accentSelection);
    // アクセントだけのプレビューでは背景などは触らない。
    expect(v["--bg"]).toBeUndefined();
  });

  it("「既定」スウォッチはそのテーマの既定アクセントをプレビューする", () => {
    const v = appearancePreviewVars({ ...base, previewAccent: { hex: null }, accentColor: "#e11d48" });
    expect(v["--accent"]).toBe(themePreviewColors("default", "dark").accent);
  });

  it("返す Chakra 変数はすべて実在する app.* トークンの出力 (var(...)) に現れる", () => {
    const v = appearancePreviewVars({ ...base, previewPreset: "dracula", previewAccent: { hex: "#0f766e" } });
    const chakraKeys = Object.keys(v).filter((k) => k.startsWith("--chakra-colors-"));
    expect(chakraKeys.length).toBeGreaterThan(10);
    for (const [cssVar, token] of Object.entries(PREVIEW_VAR_TOKENS)) {
      const out = JSON.stringify(system.css({ color: token }));
      expect(out, `${cssVar} → ${token}`).toContain(`var(${previewChakraVar(token)})`);
    }
    for (const k of chakraKeys) {
      const token = Object.values(PREVIEW_VAR_TOKENS).find((tk) => previewChakraVar(tk) === k);
      expect(token, k).toBeDefined();
    }
  });
});

describe("AppearancePreview (#1581)", () => {
  it("previewVars をモックのルートへインラインの CSS 変数として当てる", () => {
    renderWithProviders(<AppearancePreview previewVars={{ "--accent": "#123456" }} />);
    const el = screen.getByTestId("appearance-preview");
    expect(el.style.getPropertyValue("--accent")).toBe("#123456");
  });
});
