import { describe, expect, it } from "vitest";

import { renderWithProviders, screen } from "./testUtils";
import { ThresholdMeter } from "../components/ThresholdMeter";

describe("ThresholdMeter (#2239)", () => {
  it("role=meter に値と範囲、読み上げ文言を付け、0〜100 に丸める", () => {
    renderWithProviders(
      <ThresholdMeter percent={140} tone="danger" markers={[]} ariaLabel="使用率" valueText="満杯" />,
    );
    const meter = screen.getByRole("meter", { name: "使用率" });
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("aria-valuetext", "満杯");
  });

  it("閾値マーカーを複数置け、右端寄りのラベルは右揃えにする", () => {
    renderWithProviders(
      <ThresholdMeter
        percent={50}
        tone="accent"
        markers={[
          { percent: 80, label: "80%" },
          { percent: 95, label: "95%" },
        ]}
        ariaLabel="m"
        testIdPrefix="m"
      />,
    );
    expect(screen.getAllByTestId("m-threshold")).toHaveLength(2);
    expect(screen.getByTestId("m-fill")).toHaveAttribute("data-tone", "accent");
    expect(screen.getByText("80%").style.left).toBe("80%");
    expect(screen.getByText("95%").style.right).toBe("5%");
  });
});
