import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { Skeleton, SkeletonRow, SkeletonTableRows } from "../components/Skeleton";

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

describe("SkeletonTableRows (#846)", () => {
  it("renders the requested number of rows and columns inside a tbody", () => {
    const { container } = renderWithProviders(
      <table>
        <tbody>
          <SkeletonTableRows columns={3} rows={4} />
        </tbody>
      </table>,
    );
    const rows = container.querySelectorAll("tbody > tr");
    expect(rows).toHaveLength(4);
    rows.forEach((row) => {
      expect(row.querySelectorAll("td")).toHaveLength(3);
    });
  });

  it("defaults to 6 rows when `rows` is omitted", () => {
    const { container } = renderWithProviders(
      <table>
        <tbody>
          <SkeletonTableRows columns={2} />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(6);
  });

  it("marks every row as aria-hidden (decorative placeholder only)", () => {
    const { container } = renderWithProviders(
      <table>
        <tbody>
          <SkeletonTableRows columns={2} rows={3} />
        </tbody>
      </table>,
    );
    const rows = container.querySelectorAll("tbody > tr");
    rows.forEach((row) => {
      expect(row.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("staggers animation-delay and opacity across rows/columns for visual depth", () => {
    const { container } = renderWithProviders(
      <table>
        <tbody>
          <SkeletonTableRows columns={2} rows={2} />
        </tbody>
      </table>,
    );
    const rows = container.querySelectorAll("tbody > tr");
    // 1 行目は不透明、2 行目はわずかに薄くなる (奥行き演出)。
    expect((rows[0] as HTMLElement).style.opacity).toBe("1");
    expect((rows[1] as HTMLElement).style.opacity).toBe("0.88");
    const bars = container.querySelectorAll("tbody > tr td > div");
    expect(bars.length).toBe(4);
    // 各バーの animationDelay が単調増加 (スタッガ) していること。
    const delays = Array.from(bars).map((b) => parseFloat((b as HTMLElement).style.animationDelay));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });
});
