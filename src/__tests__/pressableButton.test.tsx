import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { PressableButton } from "../components/ui";

/**
 * `PressableButton` の回帰テスト。
 *
 * クリックコールバック・無効化・`data-pressable` 属性の存在を検証する。
 * Motion の spring アニメーション自体は jsdom では走らないが、
 * - 通常状態でボタンに `data-pressable="true"` が付与されること
 * - disabled のときはボタンが押せないこと
 * を保証し、CSS の `:active` 打ち消しが機能するための属性が維持されているかを確認する。
 */
describe("PressableButton", () => {
  it("クリックハンドラが呼ばれる", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <PressableButton variant="primary" onClick={onClick}>
        実行
      </PressableButton>,
    );

    await user.click(screen.getByRole("button", { name: "実行" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("data-pressable 属性が付与されている (CSS :active 打ち消しに必要)", () => {
    renderWithProviders(
      <PressableButton variant="primary">実行</PressableButton>,
    );

    const btn = screen.getByRole("button", { name: "実行" });
    expect(btn).toHaveAttribute("data-pressable", "true");
  });

  it("disabled のときはボタンが無効化されクリックしても実行されない", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <PressableButton variant="primary" disabled onClick={onClick}>
        実行
      </PressableButton>,
    );

    const btn = screen.getByRole("button", { name: "実行" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("variant props が子 Button に伝播し recipe のクラスが切り替わる (danger / success / warning)", () => {
    // Chakra recipe のクラス名は jsdom 環境ではハッシュになるため固定名では検査
    // できないが、variant が内側の Button まで届いていれば variant ごとに異なる
    // recipe クラスが生成される。クラス集合の差分で伝播そのものを検証する。
    const { rerender } = renderWithProviders(
      <PressableButton variant="danger">実行</PressableButton>,
    );
    const dangerClass = screen.getByRole("button", { name: "実行" }).className;

    rerender(<PressableButton variant="success">実行</PressableButton>);
    const successClass = screen.getByRole("button", { name: "実行" }).className;

    rerender(<PressableButton variant="warning">実行</PressableButton>);
    const warningClass = screen.getByRole("button", { name: "実行" }).className;

    expect(dangerClass).toBeTruthy();
    expect(successClass).toBeTruthy();
    expect(warningClass).toBeTruthy();
    // variant が無視されていれば 3 つとも同一クラスになるため、相異なることを確認する。
    expect(new Set([dangerClass, successClass, warningClass]).size).toBe(3);
  });
});
