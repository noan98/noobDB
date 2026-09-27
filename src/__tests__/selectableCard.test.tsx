import { describe, it, expect, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { SelectableCard } from "../components/ui";

/**
 * クリック可能サーフェスカードの共通プリミティブ (#1161)。角丸・エレベーション・
 * ホバーリフト・押下フィードバックの見た目は `theme.ts` の
 * `selectableCardRecipe` (CSS の box-shadow / transform) が担い、jsdom の
 * `getComputedStyle` では検証できない (emotion が注入する実スタイルシートを
 * jsdom は解決しない) ため、ここでは `WelcomeCard` / `ProfileCard` /
 * `ThemePresetCard` が共通して依存する「配線」— `aria-pressed` の選択状態・
 * `disabled` での操作抑止・クリックの発火・用途固有の装飾 (`borderLeft` の
 * スパインなど) が正しく素通しされることを固定する。
 */
describe("SelectableCard (#1161)", () => {
  it("renders as a native button and fires onClick", () => {
    const onClick = vi.fn();
    renderWithProviders(
      <SelectableCard type="button" onClick={onClick}>
        カード
      </SelectableCard>,
    );
    const card = screen.getByRole("button", { name: "カード" });
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("reflects the selected state via aria-pressed (ThemePresetCard の選択表示)", () => {
    const { rerender } = renderWithProviders(
      <SelectableCard type="button" aria-pressed={false}>
        プリセット
      </SelectableCard>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");

    rerender(
      <SelectableCard type="button" aria-pressed={true}>
        プリセット
      </SelectableCard>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("disabled なカードはクリックを発火せず disabled 属性を持つ (接続試行中の抑止)", () => {
    const onClick = vi.fn();
    renderWithProviders(
      <SelectableCard type="button" disabled onClick={onClick}>
        接続中
      </SelectableCard>,
    );
    const card = screen.getByRole("button", { name: "接続中" });
    expect(card).toBeDisabled();
    fireEvent.click(card);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("用途固有の装飾 (本番スパインの borderLeft など) を通常の style prop として重ねられる", () => {
    // jsdom は emotion が注入する実スタイルシートを解決しないため
    // `getComputedStyle` / インラインスタイルでは値を検証できない。ここでは
    // `borderLeft`/`borderLeftColor` (recipe が触らないプロパティ) を渡すと
    // recipe 単体のときと異なる atomic class が発行されること — つまり
    // recipe を迂回せず素通しの style prop として実際に効いていること — を
    // 確認する。
    const { unmount } = renderWithProviders(
      <SelectableCard type="button" data-testid="plain-card">
        plain
      </SelectableCard>,
    );
    const plainClass = screen.getByTestId("plain-card").className;
    unmount();

    renderWithProviders(
      <SelectableCard
        type="button"
        borderLeft="3px solid"
        borderLeftColor="var(--status-error)"
        data-testid="spine-card"
      >
        本番プロファイル
      </SelectableCard>,
    );
    const spineClass = screen.getByTestId("spine-card").className;
    expect(spineClass).not.toBe(plainClass);
  });
});
