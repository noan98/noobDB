import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import type { TitleBarConnection } from "../components/titleBarContext";
import { t } from "../i18n";

/**
 * カスタムウィンドウクローム (#604)。`@tauri-apps/api/window` を**モジュール読み込み時**
 * (`getCurrentWindow()`) と mount effect (`isMaximized` / `onResized`) で使うため、
 * import 前にモックする。ウィンドウ操作ボタン (最小化 / 最大化 / 閉じる) が描画され、
 * 接続情報を与えると接続名が可視であることを固定する。
 */
const { closeMock } = vi.hoisted(() => ({ closeMock: vi.fn() }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: closeMock,
  }),
}));

import { TitleBar } from "../components/TitleBar";

describe("TitleBar render smoke (#604)", () => {
  it("renders the window control buttons", () => {
    renderWithProviders(<TitleBar />);
    expect(screen.getByRole("button", { name: t("titleBarMinimize") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("titleBarMaximize") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("titleBarClose") })).toBeInTheDocument();
  });

  it("asks onBeforeClose first and keeps the window open when declined", async () => {
    closeMock.mockClear();
    const onBeforeClose = vi.fn().mockResolvedValue(false);
    renderWithProviders(<TitleBar onBeforeClose={onBeforeClose} />);
    screen.getByRole("button", { name: t("titleBarClose") }).click();
    await vi.waitFor(() => expect(onBeforeClose).toHaveBeenCalled());
    await Promise.resolve();
    expect(closeMock).not.toHaveBeenCalled();
    onBeforeClose.mockResolvedValue(true);
    screen.getByRole("button", { name: t("titleBarClose") }).click();
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
  });

  it("shows the active connection name when connected", () => {
    const connection: TitleBarConnection = {
      name: "Alpha DB",
      color: null,
      isProduction: false,
      status: "connected",
    };
    renderWithProviders(<TitleBar connection={connection} />);
    expect(screen.getByText("Alpha DB")).toBeInTheDocument();
  });
});
