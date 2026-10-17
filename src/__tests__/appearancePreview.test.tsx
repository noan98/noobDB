// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AppearancePreview } from "../components/AppearancePreview";
import { renderWithProviders, screen } from "./testUtils";
import { appearancePreviewVars, themePreviewColors } from "../themePresetPreview";

describe("appearancePreviewVars (#1581)", () => {
  it("何もホバーしていなければ上書きしない (現在の設定がトークン経由で映る)", () => {
    expect(appearancePreviewVars(null, null, "dark")).toEqual({});
  });

  it("プリセットは代表 5 色を CSS 変数として上書きする", () => {
    const c = themePreviewColors("dracula", "dark");
    const v = appearancePreviewVars("dracula", null, "dark");
    expect(v["--bg"]).toBe(c.bg);
    expect(v["--accent"]).toBe(c.accent);
    expect(v["--text"]).toBe(c.text);
    expect(v["--syntax-keyword"]).toBe(c.keyword);
    // Chakra の app.* トークンは :root で解決済みの値が継承されるため、対応する変数も上書きする。
    expect(v["--chakra-colors-app-bg"]).toBe(c.bg);
    expect(v["--chakra-colors-app-accent"]).toBe(c.accent);
  });

  it("アクセントのホバーはプリセットのアクセントより優先する", () => {
    const v = appearancePreviewVars("dracula", "#ff0000", "dark");
    expect(v["--accent"]).toBe("#ff0000");
    expect(v["--chakra-colors-app-accent"]).toBe("#ff0000");
    expect(v["--accent-highlight"]).toContain("#ff0000");
  });
});

describe("AppearancePreview (#1581)", () => {
  it("previewVars をモックのルートへインラインの CSS 変数として当てる", () => {
    renderWithProviders(<AppearancePreview previewVars={{ "--accent": "#123456" }} />);
    const el = screen.getByTestId("appearance-preview");
    expect(el.style.getPropertyValue("--accent")).toBe("#123456");
  });
});
