import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { PressableButton } from "../components/ui";

/**
 * `PressableButton` の回帰テスト (#541)。
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

  it("variant props が子 Button に伝播しレンダリングされる (danger / success / warning)", () => {
    // variant が正しく渡るかはボタン要素が描画されることで確認する。
    // Chakra recipe のクラス名は jsdom 環境ではハッシュになるため class 名では検査しない。
    const { rerender } = renderWithProviders(
      <PressableButton variant="danger">削除</PressableButton>,
    );
    expect(screen.getByRole("button", { name: "削除" })).toBeInTheDocument();

    rerender(
      <PressableButton variant="success">保存</PressableButton>,
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();

    rerender(
      <PressableButton variant="warning">中止</PressableButton>,
    );
    expect(screen.getByRole("button", { name: "中止" })).toBeInTheDocument();
  });
});
