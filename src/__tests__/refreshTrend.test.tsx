import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { RefreshTrend, trendSegmentPercents } from "../components/RefreshTrend";

describe("RefreshTrend (#1621)", () => {
  it("scales segments against the largest refresh and stacks added/changed/removed", () => {
    const max = 10;
    expect(trendSegmentPercents({ at: 1, added: 5, changed: 3, removed: 2 }, max)).toEqual({
      added: 50,
      changed: 30,
      removed: 20,
    });
    // 変化が一度も無いときは 0 割りにならない。
    expect(trendSegmentPercents({ at: 1, added: 0, changed: 0, removed: 0 }, 0)).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
    });
  });

  it("renders one bar per sample with an accessible summary of the latest refresh", () => {
    renderWithProviders(
      <RefreshTrend
        samples={[
          { at: 1, added: 0, changed: 0, removed: 0 },
          { at: 2, added: 4, changed: 2, removed: 1 },
        ]}
      />,
    );
    expect(screen.getAllByTestId("refresh-trend-bar")).toHaveLength(2);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      t("refreshTrendAria", { count: 2, added: 4, changed: 2, removed: 1 }),
    );
  });
});
