import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const hasAiApiKey = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, hasAiApiKey: () => hasAiApiKey() } };
});

import { resetAiKeyStoreForTest } from "../ai/aiKeyStore";
import { OPEN_AI_SETTINGS_EVENT } from "../ai/aiSettingsNav";
import { sanitizeAiSettings } from "../ai/aiSettings";
import { AiSetupHint } from "../components/AiSetupHint";
import { DEFAULT_SETTINGS, getSettings, replaceAllSettings } from "../settings";

function setAi(patch: Partial<typeof DEFAULT_SETTINGS.ai>) {
  replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, consentGiven: true, ...patch } });
}

beforeEach(() => {
  cleanup();
  resetAiKeyStoreForTest();
  hasAiApiKey.mockReset();
  hasAiApiKey.mockResolvedValue(false);
  setAi({ enabled: false });
});

describe("AiSetupHint (#1475)", () => {
  it("AI 無効なら案内リンクを出す", async () => {
    renderWithProviders(<AiSetupHint />);
    await act(async () => {});
    expect(screen.getByTestId("ai-setup-hint")).toBeTruthy();
    expect(screen.getByText(t("aiSetupHintLabel"))).toBeTruthy();
  });

  it("有効だがキー未登録でも出す", async () => {
    setAi({ enabled: true });
    renderWithProviders(<AiSetupHint />);
    await waitFor(() => expect(screen.getByTestId("ai-setup-hint")).toBeTruthy());
  });

  it("有効かつキー登録済みなら出さない", async () => {
    hasAiApiKey.mockResolvedValue(true);
    setAi({ enabled: true });
    renderWithProviders(<AiSetupHint />);
    await act(async () => {});
    expect(screen.queryByTestId("ai-setup-hint")).toBeNull();
  });

  it("有効化済みでキーの有無が未確定の間は出さない", () => {
    hasAiApiKey.mockReturnValue(new Promise(() => {}));
    setAi({ enabled: true });
    renderWithProviders(<AiSetupHint />);
    expect(screen.queryByTestId("ai-setup-hint")).toBeNull();
  });

  it("リンクを押すと AI 設定を開く要求が飛ぶ", async () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_AI_SETTINGS_EVENT, onOpen);
    renderWithProviders(<AiSetupHint />);
    await act(async () => {});
    fireEvent.click(screen.getByText(t("aiSetupHintLabel")));
    window.removeEventListener(OPEN_AI_SETTINGS_EVENT, onOpen);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("「今後表示しない」で設定に保存され、以降は出ない", async () => {
    renderWithProviders(<AiSetupHint />);
    await act(async () => {});
    fireEvent.click(screen.getByText(t("aiSetupHintDismiss")));
    expect(getSettings().ai.hideSetupHint).toBe(true);
    expect(screen.queryByTestId("ai-setup-hint")).toBeNull();
  });

  it("hideSetupHint は保存値の丸めで既定 false、true だけが残る", () => {
    expect(sanitizeAiSettings({}).hideSetupHint).toBe(false);
    expect(sanitizeAiSettings({ hideSetupHint: "yes" }).hideSetupHint).toBe(false);
    expect(sanitizeAiSettings({ hideSetupHint: true }).hideSetupHint).toBe(true);
  });
});
