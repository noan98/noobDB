import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders as render } from "./testUtils";
import { LatencySparkline } from "../components/LatencySparkline";

/** 最新区間の描き入れ (#1874)。初回表示・reduced-motion・ハイコントラストでは静止する。 */
describe("LatencySparkline の描き入れ", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-motion");
    document.documentElement.removeAttribute("data-theme");
  });

  it("初回表示では描き入れない", () => {
    const { queryByTestId } = render(<LatencySparkline samples={[10, 20, 30]} />);
    expect(queryByTestId("sparkline-latest")).toBeNull();
  });

  it("サンプル更新で最新区間だけを描き入れる", () => {
    document.documentElement.setAttribute("data-motion", "full");
    const { container, rerender, queryByTestId } = render(<LatencySparkline samples={[10, 20, 30]} />);
    rerender(<LatencySparkline samples={[10, 20, 30, 40]} />);
    expect(queryByTestId("sparkline-latest")).not.toBeNull();
    expect(container.querySelectorAll("line[data-level]").length).toBe(3);
  });

  it("ハイコントラストでは更新しても静止する", () => {
    document.documentElement.setAttribute("data-motion", "full");
    document.documentElement.setAttribute("data-theme", "hc-dark");
    const { rerender, queryByTestId } = render(<LatencySparkline samples={[10, 20, 30]} />);
    rerender(<LatencySparkline samples={[10, 20, 30, 40]} />);
    expect(queryByTestId("sparkline-latest")).toBeNull();
  });
});
