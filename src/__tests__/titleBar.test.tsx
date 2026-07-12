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
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
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
