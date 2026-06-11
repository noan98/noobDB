import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { Icon, ICON_SIZES, ICON_STROKE, type IconName } from "../components/Icon";

/**
 * アイコンのセマンティック・レキシコン (#489) の回帰テスト。新オブジェクト種別と
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

  it("exposes ascending size tokens", () => {
    expect(ICON_SIZES.sm).toBeLessThan(ICON_SIZES.md);
    expect(ICON_SIZES.md).toBeLessThan(ICON_SIZES.lg);
  });

  it("exposes stroke tokens with regular as the default weight", () => {
    expect(ICON_STROKE.thin).toBeLessThan(ICON_STROKE.regular);
    expect(ICON_STROKE.regular).toBeLessThan(ICON_STROKE.bold);
    expect(ICON_STROKE.regular).toBe(2);
  });
});
