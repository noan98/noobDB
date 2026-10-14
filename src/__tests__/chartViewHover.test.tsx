import { describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { CartesianChart, formatTick } from "../components/ChartView";
import type { ChartModel } from "../components/chartData";

function model(n: number): ChartModel {
  return {
    labels: Array.from({ length: n }, (_, i) => `L${i}`),
    series: [{ name: "s", values: Array.from({ length: n }, (_, i) => i) }],
    sampledFrom: null,
  };
}

describe("CartesianChart: ホバー index がモデル差し替えで範囲外になる", () => {
  it("ラベル数が減っても例外にならず、ツールチップを出さない", () => {
    const { rerender } = renderWithProviders(
      <CartesianChart model={model(50)} type="bar" xName="x" colors={["#000"]} />,
    );
    const svg = screen.getByRole("group");
    fireEvent.keyDown(svg, { key: "End" });
    expect(() =>
      rerender(<CartesianChart model={model(3)} type="bar" xName="x" colors={["#000"]} />),
    ).not.toThrow();
  });
});

describe("formatTick: 小さい値域の目盛り", () => {
  it("0.01 刻みが 0.0 に潰れない", () => {
    const labels = [0, 0.01, 0.02, 0.03].map(formatTick);
    expect(new Set(labels).size).toBe(4);
    expect(labels[1]).toBe("0.01");
  });
  it("従来の整形を保つ", () => {
    expect(formatTick(5)).toBe("5");
    expect(formatTick(0.5)).toBe("0.5");
    expect(formatTick(2500)).toBe("2.5k");
  });
});
