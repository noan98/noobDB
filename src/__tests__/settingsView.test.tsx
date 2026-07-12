import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * 設定モーダル (#604)。マウント時に `api.readLogs()` (ログビューア) と
 * `getCurrentAppVersion()` (更新セクション) を呼ぶため、両方をモックして実 Tauri
 * ランタイムなしでレンダリングできるようにする。ダイアログとしてマウントでき、
 * タイトルが可視であること・閉じるボタンで `onClose` が呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readLogs: vi.fn().mockResolvedValue({ text: "", path: "/tmp/noobdb.log" }),
    },
  };
});

vi.mock("../updater", () => ({
  getCurrentAppVersion: vi.fn().mockResolvedValue("1.2.3"),
  checkForAppUpdate: vi.fn().mockResolvedValue(null),
}));

// SettingsView から import される updatePrompt はダイアログ経由でのみ使われるため
// 空のスタブで十分 (マウント時には呼ばれない)。
vi.mock("../components/updatePrompt", () => ({
  confirmAndInstallUpdate: vi.fn(),
}));

import { SettingsView } from "../components/SettingsView";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsView render smoke (#604)", () => {
  it("mounts as a dialog and shows the settings title", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(t("settingsTitle"))).toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", async () => {
    const onClose = vi.fn();
    renderWithProviders(<SettingsView theme="dark" onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByText(t("settingsTitle"))).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: t("settingsClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
