import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * 設定画面のログ節 (#1622): 診断バンドルの書き出しと、パフォーマンス計測のトグル。
 */
const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => save(...a),
  open: vi.fn(),
}));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readLogs: vi.fn().mockResolvedValue({ text: "log", path: "/tmp/noobdb.log" }),
      getHistoryRetentionDays: vi.fn().mockResolvedValue(0),
      setHistoryRetentionDays: vi.fn().mockResolvedValue(0),
      buildDiagnosticBundle: vi.fn().mockResolvedValue("# noobDB diagnostic bundle\napp_version: 1.2.3\n"),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock("../updater", () => ({
  getCurrentAppVersion: vi.fn().mockResolvedValue("1.2.3"),
  checkForAppUpdate: vi.fn().mockResolvedValue(null),
}));
vi.mock("../components/updatePrompt", () => ({ confirmAndInstallUpdate: vi.fn() }));

import { SettingsView } from "../components/SettingsView";
import { api } from "../api/tauri";
import { getSettings } from "../settings";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("設定画面の診断 (#1622)", () => {
  it("診断情報の書き出しは保存ダイアログで選んだ場所へバンドル本文を書く", async () => {
    save.mockResolvedValue("/tmp/diag.txt");
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: t("settingsDiagBundle") }));
    await waitFor(() =>
      expect(api.writeTextFile).toHaveBeenCalledWith(
        "/tmp/diag.txt",
        expect.stringContaining("app_version: 1.2.3"),
      ),
    );
    expect(api.buildDiagnosticBundle).toHaveBeenCalledTimes(1);
  });

  it("保存ダイアログをキャンセルしたらバンドルを作らない", async () => {
    save.mockResolvedValue(null);
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: t("settingsDiagBundle") }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(api.buildDiagnosticBundle).not.toHaveBeenCalled();
    expect(api.writeTextFile).not.toHaveBeenCalled();
  });

  it("パフォーマンス計測のスイッチで設定が切り替わる (既定はオフ)", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    const sw = await screen.findByLabelText(t("settingsPerfMeasure"));
    expect(getSettings().perfMeasureEnabled).toBe(false);
    fireEvent.click(sw);
    expect(getSettings().perfMeasureEnabled).toBe(true);
  });
});
