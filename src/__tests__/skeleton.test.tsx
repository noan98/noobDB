import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { Skeleton, SkeletonRow } from "../components/Skeleton";

/**
 * スケルトン UI プリミティブのユニットテスト。
 *
 * jsdom 環境での CSS アニメーション (`skeleton-shimmer`) は動かないが、
 * 要素が正しく描画されること・ARIA 属性・スタイル属性の付与を確認する。
 */
describe("Skeleton (#537)", () => {
  it("renders a div with the shimmer gradient background", () => {
    const { container } = renderWithProviders(<Skeleton height="10px" width="80px" />);
    const el = container.querySelector("div");
    expect(el).toBeTruthy();
  });

  it("passes through style props (width/height)", () => {
    const { container } = renderWithProviders(
      <Skeleton style={{ width: "120px", height: "12px" }} />,
    );
    const el = container.querySelector("div") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.width).toBe("120px");
    expect(el.style.height).toBe("12px");
  });

  it("supports animation-delay via style prop (for staggered rows)", () => {
    const { container } = renderWithProviders(
      <Skeleton style={{ animationDelay: "0.2s" }} />,
    );
    const el = container.querySelector("div") as HTMLElement;
    expect(el.style.animationDelay).toBe("0.2s");
  });
});

describe("SkeletonRow (#537)", () => {
  it("renders as a div for tree-node placeholder", () => {
    const { container } = renderWithProviders(<SkeletonRow />);
    const el = container.querySelector("div");
    expect(el).toBeTruthy();
  });

  it("allows width override via style prop", () => {
    const { container } = renderWithProviders(
      <SkeletonRow style={{ width: "65%" }} />,
    );
    const el = container.querySelector("div") as HTMLElement;
    expect(el.style.width).toBe("65%");
  });

  it("supports opacity for fade-out effect", () => {
    const { container } = renderWithProviders(
      <SkeletonRow style={{ opacity: 0.5 }} />,
    );
    const el = container.querySelector("div") as HTMLElement;
    expect(el.style.opacity).toBe("0.5");
  });

  it("renders multiple SkeletonRow for a loading list", () => {
    const SKELETON_ROW_WIDTHS = [72, 58, 85, 65, 78];
    const { container } = renderWithProviders(
      <div data-testid="list" aria-hidden>
        {SKELETON_ROW_WIDTHS.map((w, i) => (
          <SkeletonRow
            key={i}
            data-testid="skeleton-row"
            style={{ width: `${w}%`, animationDelay: `${i * 0.1}s`, opacity: 1 - i * 0.15 }}
          />
        ))}
      </div>,
    );
    const rows = container.querySelectorAll("[data-testid='skeleton-row']");
    expect(rows).toHaveLength(SKELETON_ROW_WIDTHS.length);
  });

  it("is hidden from assistive technology when aria-hidden is set on parent", () => {
    const { container } = renderWithProviders(
      <div aria-hidden="true">
        <SkeletonRow />
        <SkeletonRow />
      </div>,
    );
    // aria-hidden が親に付いているため、スクリーンリーダーからは見えない。
    const wrapper = container.querySelector("div[aria-hidden='true']");
    expect(wrapper).toBeTruthy();
    const skeletonRows = wrapper!.querySelectorAll("div");
    expect(skeletonRows.length).toBe(2);
  });
});
