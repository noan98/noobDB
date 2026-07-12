import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { HelpView } from "../components/HelpView";
import { t } from "../i18n";

/**
 * ヘルプ画面 (#604 レンダリング死角の解消)。純粋に表示のみのモーダルで、
 * マウント時に Tauri 呼び出しを持たない。ダイアログとしてマウントでき、
 * 見出しが可視であること・閉じるボタンで `onClose` が呼ばれることを固定する。
 */
describe("HelpView render smoke (#604)", () => {
  it("mounts as a dialog and shows the help title", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("helpTitle"))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(<HelpView onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("helpClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
