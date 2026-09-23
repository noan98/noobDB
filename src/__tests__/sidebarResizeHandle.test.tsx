import { describe, it, expect, vi } from "vitest";
import appSource from "../App.tsx?raw";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { SidebarResizeHandle } from "../components/SidebarResizeHandle";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../components/sidebarLayout";

/**
 * サイドバーの幅変更ハンドル (#1112)。ポインタ専用で読み上げ名も誤っていた区切りを、
 * `Splitter` と同じくキーボードで操作でき現在幅を伝える separator に揃えた。
 */

function renderHandle(width = 300) {
  const onWidthChange = vi.fn();
  renderWithProviders(
    <SidebarResizeHandle
      width={width}
      onWidthChange={onWidthChange}
      resizing={false}
      onResizingChange={vi.fn()}
      ariaLabel="サイドバーの幅を変更"
    />,
  );
  return { onWidthChange, handle: screen.getByRole("separator", { name: "サイドバーの幅を変更" }) };
}

describe("SidebarResizeHandle (#1112)", () => {
  it("フォーカス可能な separator として現在幅と範囲を公開する", () => {
    const { handle } = renderHandle(320);
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    expect(handle).toHaveAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
    expect(handle).toHaveAttribute("aria-valuemax", String(SIDEBAR_MAX_WIDTH));
  });

  it("矢印 / Home / End / Enter で幅を変える", () => {
    const { handle, onWidthChange } = renderHandle(300);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_MIN_WIDTH);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_MAX_WIDTH);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_DEFAULT_WIDTH);
  });

  it("ダブルクリックで既定幅に戻す", () => {
    const { handle, onWidthChange } = renderHandle(480);
    fireEvent.doubleClick(handle);
    expect(onWidthChange).toHaveBeenCalledWith(SIDEBAR_DEFAULT_WIDTH);
  });

  it("App.tsx はこのハンドルを使い、区切りに専用の読み上げ名を付ける", () => {
    expect(appSource).toContain("<SidebarResizeHandle");
    expect(appSource).toContain('ariaLabel={t("sidebarResizeAria")}');
  });
});
