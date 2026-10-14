import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { ThrottledColorInput } from "../components/SettingsView";

// 色ピッカーの間引き (#1616): ドラッグ中は連続 input を 1 フレーム 1 回にまとめ、blur で最後の値を確定する。
describe("ThrottledColorInput", () => {
  it("blur で最後の値を 1 回だけ確定する", () => {
    const onCommit = vi.fn();
    renderWithProviders(
      <ThrottledColorInput type="color" aria-label="c" value="#000000" onCommit={onCommit} />,
    );
    const input = screen.getByLabelText("c");
    fireEvent.change(input, { target: { value: "#111111" } });
    fireEvent.change(input, { target: { value: "#222222" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("#222222");
  });

  it("アンマウント時に未確定の値を確定する", () => {
    const onCommit = vi.fn();
    const { unmount } = renderWithProviders(
      <ThrottledColorInput type="color" aria-label="c" value="#000000" onCommit={onCommit} />,
    );
    fireEvent.change(screen.getByLabelText("c"), { target: { value: "#333333" } });
    unmount();
    expect(onCommit).toHaveBeenCalledWith("#333333");
  });
});
