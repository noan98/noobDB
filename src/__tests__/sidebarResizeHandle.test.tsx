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
    <div>
    <SidebarResizeHandle
      width={width}
      onWidthChange={onWidthChange}
      resizing={false}
      onResizingChange={vi.fn()}
      ariaLabel="サイドバーの幅を変更"
    />
    </div>,
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

  it("矢印 / Home / End / Enter はキーを離すまで確定せず、離したときに 1 回だけ幅を渡す", () => {
    const { handle, onWidthChange } = renderHandle(300);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onWidthChange).not.toHaveBeenCalled();
    expect(handle).toHaveAttribute("aria-valuenow", "316");
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    expect(onWidthChange).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyUp(handle, { key: "Home" });
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_MIN_WIDTH);
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyUp(handle, { key: "End" });
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_MAX_WIDTH);
    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.keyUp(handle, { key: "Enter" });
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_DEFAULT_WIDTH);
  });

  it("キーのリピート中は CSS 変数だけが動き、離したときに 1 回だけ確定する", () => {
    const { handle, onWidthChange } = renderHandle(300);
    for (let i = 0; i < 3; i++) fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.parentElement?.style.getPropertyValue("--sidebar-width")).toBe("348px");
    expect(onWidthChange).not.toHaveBeenCalled();
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    expect(onWidthChange).toHaveBeenCalledWith(348);
  });

  it("ポインタのドラッグ中は onWidthChange を呼ばず、離したときに最終幅を 1 回だけ渡す (#1312)", () => {
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { handle, onWidthChange } = renderHandle(300);
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 380 });
      // 1 フレームにつき 1 回だけ反映される (最新位置のみ)。
      expect(rafs).toHaveLength(1);
      rafs.shift()?.(0);
      expect(handle.parentElement?.style.getPropertyValue("--sidebar-width")).toBe("380px");
      expect(handle).toHaveAttribute("aria-valuenow", "380");
      expect(onWidthChange).not.toHaveBeenCalled();
      // 最後の move が rAF 前でも、pointerup で取りこぼさず確定する。
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 420 });
      expect(onWidthChange).toHaveBeenCalledTimes(1);
      expect(onWidthChange).toHaveBeenCalledWith(420);
    } finally {
      vi.unstubAllGlobals();
    }
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
