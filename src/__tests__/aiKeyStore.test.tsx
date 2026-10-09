import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderWithProviders, screen, waitFor } from "./testUtils";

const hasAiApiKey = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, hasAiApiKey: () => hasAiApiKey() } };
});

import { resetAiKeyStoreForTest, setAiKeyPresent } from "../ai/aiKeyStore";
import { useAiAvailable } from "../ai/useAiAvailable";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

function Probe() {
  return <span data-testid="p">{useAiAvailable() ? "on" : "off"}</span>;
}

function setEnabled(enabled: boolean) {
  replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true } });
}

beforeEach(() => {
  cleanup();
  resetAiKeyStoreForTest();
  hasAiApiKey.mockReset();
  hasAiApiKey.mockResolvedValue(false);
});

describe("useAiAvailable (#691)", () => {
  it("有効かつキーありのときだけ true。初回は IPC で読み込む", async () => {
    hasAiApiKey.mockResolvedValue(true);
    setEnabled(true);
    renderWithProviders(<Probe />);
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("on"));
  });

  it("無効ならキーがあっても false", async () => {
    hasAiApiKey.mockResolvedValue(true);
    setEnabled(false);
    renderWithProviders(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId("p").textContent).toBe("off");
  });

  it("有効化の後にキーを保存すると再起動なしで true、削除すると false に戻る", async () => {
    setEnabled(true);
    renderWithProviders(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId("p").textContent).toBe("off");
    act(() => setAiKeyPresent(true));
    expect(screen.getByTestId("p").textContent).toBe("on");
    act(() => setAiKeyPresent(false));
    expect(screen.getByTestId("p").textContent).toBe("off");
  });
});
