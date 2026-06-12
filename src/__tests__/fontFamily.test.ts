import { describe, it, expect } from "vitest";
import {
  monoFontStack,
  uiFontStack,
  MONO_FONT_FALLBACK,
  UI_FONT_FALLBACK,
} from "../settings";

/**
 * フォントファミリ設定のスタック生成ロジック。選んだファミリを共有
 * フォールバックチェーンの先頭に積むことで、未インストール時もプラットフォーム
 * 既定へ自然に劣化することを固定する。
 */
describe("font family stacks (#449)", () => {
  it("returns null for the default (no override)", () => {
    expect(monoFontStack(null)).toBeNull();
    expect(uiFontStack(null)).toBeNull();
    expect(monoFontStack("")).toBeNull();
  });

  it("quotes multi-word families and appends the mono fallback", () => {
    expect(monoFontStack("JetBrains Mono")).toBe(`"JetBrains Mono", ${MONO_FONT_FALLBACK}`);
  });

  it("leaves single-word families unquoted", () => {
    expect(monoFontStack("Consolas")).toBe(`Consolas, ${MONO_FONT_FALLBACK}`);
  });

  it("appends the sans fallback for UI fonts", () => {
    expect(uiFontStack("Inter")).toBe(`Inter, ${UI_FONT_FALLBACK}`);
    expect(uiFontStack("Helvetica Neue")).toBe(`"Helvetica Neue", ${UI_FONT_FALLBACK}`);
  });

  it("does not double-quote already quoted families", () => {
    expect(monoFontStack('"Fira Code"')).toBe(`"Fira Code", ${MONO_FONT_FALLBACK}`);
  });
});
