import { describe, it, expect } from "vitest";
import {
  system,
  buttonRecipe,
  inputRecipe,
  selectRecipe,
  textareaRecipe,
  checkboxRecipe,
} from "../theme";

/**
 * テーマ基盤の回帰テスト。後続の Chakra 移行フェーズはここで定義したトークン
 * ブリッジと共通 recipe に依存するため、(1) `app.*` トークンが App.css の CSS 変数へ
 * 正しく橋渡しされていること、(2) ダーク条件がアプリの `data-theme` 属性を見て
 * いること、(3) recipe が実在するトークンを参照していること (パスのタイプミスは
 * ビルドでは検出されない) を固定する。
 */

describe("token bridge resolves to App.css CSS variables", () => {
  it("bridges app.* color tokens", () => {
    expect(system.token("colors.app.accent")).toBe("var(--accent)");
    expect(system.token("colors.app.bgInput")).toBe("var(--bg-input)");
    expect(system.token("colors.app.borderSubtle")).toBe("var(--border-subtle)");
    expect(system.token("colors.app.status.error")).toBe("var(--status-error)");
    expect(system.token("colors.app.status.warning")).toBe("var(--status-warning)");
    expect(system.token("colors.app.bgWarning")).toBe("var(--bg-warning)");
    expect(system.token("colors.app.textWarning")).toBe("var(--text-warning)");
    expect(system.token("colors.app.syntax.keyword")).toBe("var(--syntax-keyword)");
    expect(system.token("colors.app.cell.boolTrue")).toBe("var(--cell-bool-true)");
  });

  it("bridges spacing and fontSize tokens", () => {
    expect(system.token("spacing.2")).toBe("var(--space-2)");
    expect(system.token("fontSizes.sm")).toBe("var(--text-sm)");
    expect(system.token("fontSizes.base")).toBe("var(--text-base)");
  });

  it("bridges shadows by overriding Chakra's default semantic shadows", () => {
    // Chakra の既定 shadow は semanticToken なので tokens 側では上書きできない。
    expect(JSON.stringify(system.tokens.getByName("shadows.md")?.value)).toContain(
      "var(--shadow-md)",
    );
  });
});

describe("dark mode condition targets the data-theme attribute", () => {
  it("emits a [data-theme$=dark] selector for _dark styles (matches preset dark themes, #465)", () => {
    const out = system.css({ color: "red", _dark: { color: "blue" } });
    // 末尾一致にしてダーク系プリセット ("dracula-dark" 等) でも _dark が効く。
    expect(JSON.stringify(out)).toContain("data-theme$=dark");
  });
});

describe("common recipes reference real tokens", () => {
  it("button variants use accent / semantic color tokens", () => {
    const variant = buttonRecipe.variants!.variant;
    expect(JSON.stringify(system.css(variant.primary))).toContain(
      "chakra-colors-app-accent",
    );
    expect(JSON.stringify(system.css(variant.success))).toContain(
      "chakra-colors-app-success-bg",
    );
  });

  it("input / select / textarea use the bgInput token", () => {
    for (const recipe of [inputRecipe, selectRecipe, textareaRecipe]) {
      expect(JSON.stringify(system.css(recipe.base))).toContain(
        "chakra-colors-app-bg-input",
      );
    }
  });

  it("checkbox tints to the accent token", () => {
    expect(JSON.stringify(system.css(checkboxRecipe.base))).toContain(
      "chakra-colors-app-accent",
    );
  });
});
