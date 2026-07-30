import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { Icon, ICON_SIZES, ICON_STROKE, type IconName } from "../components/Icon";

/**
 * アイコンのセマンティック・レキシコンの回帰テスト。新オブジェクト種別と
 * グリッド操作アイコンが描画でき、サイズ/ストローク規約が一貫していることを固定する。
 */
describe("icon lexicon (#489)", () => {
  const semantic: IconName[] = [
    "view",
    "routine",
    "trigger",
    "production",
    "sort",
    "sort-asc",
    "sort-desc",
    "pin",
    "unplug",
  ];

  it.each(semantic)("renders an SVG for the %s glyph", (name) => {
    const { container, unmount } = renderWithProviders(<Icon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg, `Icon "${name}" should render an <svg>`).toBeTruthy();
    expect(svg?.querySelector("path, rect, circle, line, ellipse")).toBeTruthy();
    unmount();
  });

  it("exposes ascending, font-scale-tracking size tokens (#818)", () => {
    // 値は `calc(<px>px * var(--font-scale))` 形式の CSS 文字列。App.css の
    // --text-* / --space-* と同じ規約で、設定のフォントサイズにアイコンが追従する。
    const pxOf = (token: string) => {
      const match = token.match(/^calc\((\d+)px \* var\(--font-scale\)\)$/);
      expect(match, `unexpected ICON_SIZES token format: "${token}"`).toBeTruthy();
      return Number(match?.[1]);
    };
    expect(pxOf(ICON_SIZES.sm)).toBeLessThan(pxOf(ICON_SIZES.md));
    expect(pxOf(ICON_SIZES.md)).toBeLessThan(pxOf(ICON_SIZES.lg));
  });

  it("exposes stroke tokens with regular as the default weight", () => {
    expect(ICON_STROKE.thin).toBeLessThan(ICON_STROKE.regular);
    expect(ICON_STROKE.regular).toBeLessThan(ICON_STROKE.bold);
    expect(ICON_STROKE.regular).toBe(2);
  });

  it("renders ICON_SIZES tokens as their calc(--font-scale) CSS value verbatim (#818)", () => {
    // Chakra (emotion) は `width`/`height` をインラインスタイル/属性ではなく生成
    // した CSS クラスへ解決するため、実際に発行されたスタイルシートのルールを見て
    // calc() 式 (= --font-scale 追従) が Chakra のスタイル props パイプラインを
    // 通っても変質せず残ることを確認する。
    const { container, unmount } = renderWithProviders(<Icon name="table" size={ICON_SIZES.md} />);
    const svg = container.querySelector("svg");
    const className = svg?.getAttribute("class");
    expect(className, "Icon should render with a generated class name").toBeTruthy();
    const rule = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules);
        } catch {
          return [];
        }
      })
      .find((r) => r.cssText.includes(`.${className}`));
    expect(rule, `no stylesheet rule found for class "${className}"`).toBeTruthy();
    expect(rule?.cssText).toContain(`width: ${ICON_SIZES.md}`);
    expect(rule?.cssText).toContain(`height: ${ICON_SIZES.md}`);
    unmount();
  });
});
