import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { Segmented } from "../components/Segmented";

/**
 * 共有セグメントコントロール (#975)。`ResultViewSwitch` と `SettingsView` の
 * 密度・モーション設定セグメントを 1 つのプリミティブへ集約したため、ここでは
 * その共通のロール/選択/キーボード操作を固定する (各呼び出し側の固有の見た目
 * テストは `resultViewSwitch.test.tsx` に残す)。
 */
type Fruit = "apple" | "banana" | "cherry";

const OPTIONS = [
  { value: "apple" as Fruit, label: "Apple" },
  { value: "banana" as Fruit, label: "Banana" },
  { value: "cherry" as Fruit, label: "Cherry" },
];

describe("Segmented", () => {
  it("renders an exclusive radiogroup with the active option checked", () => {
    renderWithProviders(
      <Segmented value="banana" options={OPTIONS} onChange={() => {}} ariaLabel="Fruit" />,
    );

    expect(screen.getByRole("radiogroup", { name: "Fruit" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(screen.getByRole("radio", { name: "Banana" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Apple" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("reports the picked option and stays silent when the active one is clicked again", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Segmented value="apple" options={OPTIONS} onChange={onChange} ariaLabel="Fruit" />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Cherry" }));
    expect(onChange).toHaveBeenCalledWith("cherry");

    onChange.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Apple" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the group a single tab stop (roving focus on the selected item)", () => {
    renderWithProviders(
      <Segmented value="banana" options={OPTIONS} onChange={() => {}} ariaLabel="Fruit" />,
    );

    const tabIndexes = screen.getAllByRole("radio").map((r) => r.getAttribute("tabindex"));
    expect(tabIndexes).toEqual(["-1", "0", "-1"]);
  });

  it("moves focus with the arrow keys, Home and End", () => {
    renderWithProviders(
      <Segmented value="apple" options={OPTIONS} onChange={() => {}} ariaLabel="Fruit" />,
    );
    const [apple, banana, cherry] = screen.getAllByRole("radio");

    apple.focus();
    fireEvent.keyDown(apple, { key: "ArrowRight" });
    expect(document.activeElement).toBe(banana);

    fireEvent.keyDown(banana, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(apple);

    fireEvent.keyDown(apple, { key: "End" });
    expect(document.activeElement).toBe(cherry);

    fireEvent.keyDown(cherry, { key: "Home" });
    expect(document.activeElement).toBe(apple);

    // 端では巻き戻る (useRovingFocus の既定 wrap: true)。
    fireEvent.keyDown(apple, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cherry);
  });

  it("renders a sliding thumb only behind the active segment", () => {
    renderWithProviders(
      <Segmented value="banana" options={OPTIONS} onChange={() => {}} ariaLabel="Fruit" />,
    );

    const banana = screen.getByRole("radio", { name: "Banana" });
    const apple = screen.getByRole("radio", { name: "Apple" });
    expect(banana.querySelector('[aria-hidden]')).toBeTruthy();
    expect(apple.querySelector('[aria-hidden]')).toBeFalsy();
  });
});
