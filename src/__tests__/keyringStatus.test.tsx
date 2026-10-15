import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, checkKeyring: vi.fn() } };
});

import { api } from "../api/tauri";
import { ConnectionForm } from "../components/ConnectionForm";
import { getKeyringStatus, keyringReasonKey, resetKeyringStatusCache } from "../keyringStatus";

beforeEach(() => {
  vi.clearAllMocks();
  resetKeyringStatusCache();
});

describe("keyring 疎通診断 (#1622)", () => {
  it("診断は 1 回だけ実行してキャッシュする", async () => {
    vi.mocked(api.checkKeyring).mockResolvedValue({ available: true, reason: null });
    await getKeyringStatus();
    await getKeyringStatus();
    expect(api.checkKeyring).toHaveBeenCalledTimes(1);
  });

  it("IPC の失敗は null (警告なし) で、キャッシュせず次回再試行する", async () => {
    vi.mocked(api.checkKeyring).mockRejectedValueOnce(new Error("boom"));
    expect(await getKeyringStatus()).toBeNull();
    vi.mocked(api.checkKeyring).mockResolvedValue({ available: false, reason: "storage_unavailable" });
    expect(await getKeyringStatus()).toEqual({ available: false, reason: "storage_unavailable" });
  });

  it("理由コードを文言キーへ対応づける (未知は other)", () => {
    expect(keyringReasonKey("storage_unavailable")).toBe("keyringReasonStorageUnavailable");
    expect(keyringReasonKey("platform_failure")).toBe("keyringReasonPlatformFailure");
    expect(keyringReasonKey("readback_mismatch")).toBe("keyringReasonReadback");
    expect(keyringReasonKey("zzz")).toBe("keyringReasonOther");
    expect(keyringReasonKey(null)).toBe("keyringReasonOther");
  });

  it("使えない環境では接続フォームのパスワード欄に Callout が出る", async () => {
    vi.mocked(api.checkKeyring).mockResolvedValue({ available: false, reason: "storage_unavailable" });
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    const callout = await screen.findByTestId("keyring-unavailable");
    expect(callout.textContent).toContain(t("keyringUnavailableBody"));
    expect(callout.textContent).toContain(t("keyringReasonStorageUnavailable"));
  });

  it("使える環境では Callout を出さない", async () => {
    vi.mocked(api.checkKeyring).mockResolvedValue({ available: true, reason: null });
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    await waitFor(() => expect(api.checkKeyring).toHaveBeenCalled());
    expect(screen.queryByTestId("keyring-unavailable")).toBeNull();
  });
});
