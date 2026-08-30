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

  it("exposes ascending, font-scale-tracking size tokens (#818, #886)", () => {
    // 値は `calc(<px>px * var(--font-scale))` 形式の CSS 文字列。App.css の
    // --text-* / --space-* と同じ規約で、設定のフォントサイズにアイコンが追従する。
    const pxOf = (token: string) => {
      const match = token.match(/^calc\((\d+)px \* var\(--font-scale\)\)$/);
      expect(match, `unexpected ICON_SIZES token format: "${token}"`).toBeTruthy();
      return Number(match?.[1]);
    };
    expect(pxOf(ICON_SIZES.sm)).toBeLessThan(pxOf(ICON_SIZES.md));
    expect(pxOf(ICON_SIZES.md)).toBeLessThan(pxOf(ICON_SIZES.lg));
    // #886: 22px 超の強調アイコン向けに追加した xl / 2xl も同じ calc() 形式で、
    // 既存 3 段階からの昇順が保たれること (ピクセル直値の例外を無くした規約)。
    expect(pxOf(ICON_SIZES.lg)).toBeLessThan(pxOf(ICON_SIZES.xl));
    expect(pxOf(ICON_SIZES.xl)).toBeLessThan(pxOf(ICON_SIZES["2xl"]));
    // 昇順だけでは xl=21 / 2xl=22 のような値でも通ってしまうため、#886 で
    // 置換した実寸 (PivotView の 28px、EmptyState 非 compact と App.tsx の
    // ドラッグフィードバックの 32px) を基準値として直接固定する。
    expect(pxOf(ICON_SIZES.xl)).toBe(28);
    expect(pxOf(ICON_SIZES["2xl"])).toBe(32);
  });

  it("exposes stroke tokens with regular as the default weight", () => {
    expect(ICON_STROKE.thin).toBeLessThan(ICON_STROKE.regular);
    expect(ICON_STROKE.regular).toBeLessThan(ICON_STROKE.bold);
    expect(ICON_STROKE.regular).toBe(2);
  });

  it("renders ICON_SIZES tokens as their calc(--font-scale) CSS value verbatim (#818)", () => {
    // 寸法は SVG の width/height 属性 (= Tabler の `size` prop) ではなくインライン
    // スタイルで与える (calc() は属性としては不正で、CSS プロパティとしてのみ有効。
    // 詳細は Icon.tsx のコメント)。ここでは calc() 式が変質せず DOM まで届くこと
    // = 設定のフォントサイズへの追従が生きていることを直接固定する。
    const { container, unmount } = renderWithProviders(<Icon name="table" size={ICON_SIZES.md} />);
    const svg = container.querySelector("svg");
    const style = svg?.getAttribute("style") ?? "";
    expect(style).toContain(`width: ${ICON_SIZES.md}`);
    expect(style).toContain(`height: ${ICON_SIZES.md}`);
    unmount();
  });

  it("keeps driver brand logos as filled glyphs", () => {
    // ブランドロゴだけは Tabler の外 (simple-icons 由来の単一パス) に残す例外経路。
    // 塗り glyph としてのレンダリングと、他のアイコンと同じサイズ規約の適用を固定する。
    for (const name of ["mysql", "postgres", "sqlite"] as const) {
      const { container, unmount } = renderWithProviders(<Icon name={name} size={ICON_SIZES.sm} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("fill"), `brand icon "${name}" should be filled`).toBe(
        "currentColor",
      );
      expect(svg?.querySelector("path")).toBeTruthy();
      expect(svg?.getAttribute("style") ?? "").toContain(`width: ${ICON_SIZES.sm}`);
      unmount();
    }
  });

  it("maps the stroke token onto the rendered stroke width", () => {
    // ストローク幅は Tabler の `stroke` prop (色ではなく線幅) 経由で渡している。
    const { container, unmount } = renderWithProviders(
      <Icon name="table" strokeWidth={ICON_STROKE.bold} />,
    );
    expect(container.querySelector("svg")?.getAttribute("stroke-width")).toBe(
      String(ICON_STROKE.bold),
    );
    unmount();
  });
});
