import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { ResultViewSwitch } from "../components/ResultViewSwitch";
import { t } from "../i18n";

/**
 * 結果パネルの表示切替セグメント (グリッド / ピボット / チャート)。以前は
 * 「ピボット」「チャート」の独立ボタンで、現在どのビューを見ているかがボタンから
 * 読めなかった。ここでは 3 択の排他セグメントとして描画されること・選択中の
 * セグメントが `aria-checked` で示されること・別のセグメントを押したときだけ
 * `onChange` が呼ばれることを固定する。
 */
describe("ResultViewSwitch", () => {
  it("renders the three views as an exclusive radio group", () => {
    renderWithProviders(<ResultViewSwitch value="grid" onChange={() => {}} />);

    expect(
      screen.getByRole("radiogroup", { name: t("resultViewSwitchAria") }),
    ).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      t("gridViewLabel"),
      t("pivotShow"),
      t("chartShow"),
    ]);
  });

  it("marks the current view as checked and the others as not", () => {
    renderWithProviders(<ResultViewSwitch value="chart" onChange={() => {}} />);

    expect(
      screen.getByRole("radio", { name: t("chartShow") }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: t("gridViewLabel") }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("reports the picked view, and stays silent when the current one is picked", () => {
    const onChange = vi.fn();
    renderWithProviders(<ResultViewSwitch value="grid" onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: t("pivotShow") }));
    expect(onChange).toHaveBeenCalledWith("pivot");

    onChange.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: t("gridViewLabel") }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the group a single tab stop (roving focus on the selected item)", () => {
    renderWithProviders(<ResultViewSwitch value="pivot" onChange={() => {}} />);

    const tabIndexes = screen
      .getAllByRole("radio")
      .map((r) => r.getAttribute("tabindex"));
    expect(tabIndexes).toEqual(["-1", "0", "-1"]);
  });

  // tabIndex の静的値だけでは `useRovingFocus` がコンテナに配線されているかまでは
  // 見えないため、実際のキー操作でフォーカスが動くことを固定する。
  it("moves focus with the arrow keys, Home and End", () => {
    renderWithProviders(<ResultViewSwitch value="grid" onChange={() => {}} />);
    const [grid, pivot, chart] = screen.getAllByRole("radio");

    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(document.activeElement).toBe(pivot);

    fireEvent.keyDown(pivot, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(grid);

    fireEvent.keyDown(grid, { key: "End" });
    expect(document.activeElement).toBe(chart);

    fireEvent.keyDown(chart, { key: "Home" });
    expect(document.activeElement).toBe(grid);

    // 端では巻き戻る (useRovingFocus の既定 wrap: true)。
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(chart);
  });
});
