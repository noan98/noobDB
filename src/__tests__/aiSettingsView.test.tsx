import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const setAiApiKey = vi.fn().mockResolvedValue(undefined);
const hasAiApiKey = vi.fn().mockResolvedValue(false);
const testAiConnection = vi.fn();
const runAiRequest = vi.fn().mockResolvedValue(undefined);
let handlers: import("../api/tauri").AiStreamHandlers | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      return () => {};
    }),
    api: {
      ...actual.api,
      setAiApiKey: (...a: unknown[]) => setAiApiKey(...a),
      hasAiApiKey: () => hasAiApiKey(),
      getAiUsageHistory: () => Promise.resolve([]),
      testAiConnection: (...a: unknown[]) => testAiConnection(...a),
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      cancelStream: vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 }),
    },
  };
});

import { AiSettings } from "../components/AiSettings";
import { getSettings, replaceAllSettings, DEFAULT_SETTINGS } from "../settings";

beforeEach(() => {
  vi.clearAllMocks();
  hasAiApiKey.mockResolvedValue(false);
  replaceAllSettings(DEFAULT_SETTINGS);
});

describe("AiSettings (#690)", () => {
  it("初回の有効化は同意ダイアログを経由し、キャンセルすると有効にならない", async () => {
    renderWithProviders(<AiSettings />);
    fireEvent.click(screen.getByLabelText(t("aiEnable")));
    await screen.findByText(t("aiConsentTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("aiConsentTitle"))).toBeNull());
    expect(getSettings().ai.enabled).toBe(false);
  });

  it("同意すると有効になり、以後は同意を再度求めない", async () => {
    renderWithProviders(<AiSettings />);
    fireEvent.click(screen.getByLabelText(t("aiEnable")));
    await screen.findByText(t("aiConsentTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiConsentConfirm") }));
    await waitFor(() => expect(getSettings().ai.enabled).toBe(true));
    expect(getSettings().ai.consentGiven).toBe(true);
    fireEvent.click(screen.getByLabelText(t("aiEnable")));
    await waitFor(() => expect(getSettings().ai.enabled).toBe(false));
    fireEvent.click(screen.getByLabelText(t("aiEnable")));
    await waitFor(() => expect(getSettings().ai.enabled).toBe(true));
    await waitFor(() => expect(screen.queryByText(t("aiConsentTitle"))).toBeNull());
  });

  it("API キーを保存すると入力値が画面から消え「設定済み」になる", async () => {
    renderWithProviders(<AiSettings />);
    const input = screen.getByLabelText(t("aiApiKeyLabel")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiApiKeySave") }));
    await waitFor(() => expect(setAiApiKey).toHaveBeenCalledWith("sk-ant-secret"));
    await screen.findByText(t("aiApiKeyConfigured"));
    expect(input.value).toBe("");
    expect(screen.queryByDisplayValue("sk-ant-secret")).toBeNull();
  });

  it("タスク別の設定は既定で畳まれ、見出しに「すべて既定のまま」/「変更 N 件」を出して開くと 17 行を描く (#1608)", async () => {
    const { rerender } = renderWithProviders(<AiSettings />);
    const toggle = screen.getByRole("button", { name: new RegExp(t("aiTaskModels")) });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: t("aiTaskModels") })).toBeNull();
    expect(screen.getByTestId("ai-task-models-summary").textContent).toBe(t("aiTaskModelsAllDefault"));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const group = screen.getByRole("group", { name: t("aiTaskModels") });
    expect(group.querySelectorAll("select")).toHaveLength(34);
    // 推奨が既定と異なるインライン補完は「既定に従う」ではなく推奨モデルを使う旨を出す。
    const inline = screen.getByLabelText(`${t("aiTaskInlineComplete")} - ${t("aiColModel")}`) as HTMLSelectElement;
    expect(inline.options[0].textContent).toBe(t("aiModelFollowRecommended", { model: "Claude Haiku 5.5" }));
    const generic = screen.getByLabelText(`${t("aiTaskGeneric")} - ${t("aiColModel")}`) as HTMLSelectElement;
    expect(generic.options[0].textContent).toBe(t("aiModelFollowDefault"));
    fireEvent.change(generic, { target: { value: "claude-haiku-5-5" } });
    rerender(<AiSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-task-models-summary").textContent).toBe(t("aiTaskModelsChanged", { count: 1 })),
    );
  });

  it("API キー欄は Enter で保存できる (IME 変換中の Enter は保存しない) (#1608)", async () => {
    renderWithProviders(<AiSettings />);
    const input = screen.getByLabelText(t("aiApiKeyLabel")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-enter" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(setAiApiKey).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(setAiApiKey).toHaveBeenCalledWith("sk-ant-enter"));
    await screen.findByText(t("aiApiKeyConfigured"));
    expect(input.value).toBe("");
  });

  it("モデルのプルダウンに (推奨) が表示され、エフォートは推奨値を選ぶと null で保存される", async () => {
    renderWithProviders(<AiSettings />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("aiTaskModels")) }));
    const suffix = t("aiRecommendedSuffix");
    const def = screen.getByLabelText(t("aiDefaultModel")) as HTMLSelectElement;
    const opt = Array.from(def.options).find((o) => o.value === "claude-opus-5-5");
    expect(opt?.textContent?.endsWith(suffix)).toBe(true);

    const effort = screen.getByLabelText(
      `${t("aiTaskGeneric")} - ${t("aiColEffort")}`,
    ) as HTMLSelectElement;
    expect(effort.value).toBe("medium");
    fireEvent.change(effort, { target: { value: "max" } });
    expect(getSettings().ai.taskEfforts.generic).toBe("max");
    fireEvent.change(effort, { target: { value: "medium" } });
    expect(getSettings().ai.taskEfforts.generic).toBeNull();
  });

  it("接続テストの結果を種別ごとに表示する", async () => {
    hasAiApiKey.mockResolvedValue(true);
    testAiConnection.mockResolvedValue({
      status: "authError",
      message: "rejected",
      model: null,
      elapsedMs: 3,
    });
    replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true } });
    renderWithProviders(<AiSettings />);
    const btn = await screen.findByRole("button", { name: t("aiTestConnection") });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await screen.findByText(t("aiTestAuthError", { message: "rejected" }));
  });
});

// ストリーミング (サンプル要求) の状態遷移と、モデル ID を渡さない契約 (#690)。
describe("AiSettings サンプル要求 (#690)", () => {
  const base = { streamId: "s" };
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  async function start() {
    hasAiApiKey.mockResolvedValue(true);
    replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true } });
    renderWithProviders(<AiSettings />);
    const btn = await screen.findByRole("button", { name: t("aiSampleRequest") });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
  }

  beforeEach(() => {
    handlers = null;
  });

  it("delta が表示され、done で完了表示になる。runAiRequest にモデル ID は渡らない", async () => {
    await start();
    const args = runAiRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["prompt", "settings", "streamId", "task"]);
    expect(args.task).toBe("generic");
    expect(JSON.stringify(args.settings)).toContain("defaultModel"); // 設定スナップショットとしては渡る
    expect(Object.keys(args)).not.toContain("model");
    act(() => handlers?.onDelta?.({ ...base, text: "Hel" }));
    act(() => handlers?.onDelta?.({ ...base, text: "lo" }));
    await waitFor(() => expect(screen.getByTestId("ai-sample-text").textContent).toBe("Hello"));
    act(() =>
      handlers?.onDone?.({ ...base, model: "claude-opus-5-5", requestedModel: "claude-opus-5-5", fallbackUsed: false, stopReason: "end_turn", usage }),
    );
    await screen.findByText(t("aiUsageLine", { model: "Claude Opus 5.5", input: "1", output: "2" }));
    // 既存の完了帯と使用量表示が二重にならない
    expect(screen.getAllByTestId("ai-usage-note")).toHaveLength(1);
  });

  it("error イベントはエラー表示になる", async () => {
    await start();
    act(() => handlers?.onError?.({ ...base, error: "boom", kind: "aiApi" }));
    await screen.findByText(t("aiSampleError", { message: "boom" }));
  });

  it("refusal は警告表示、cancelled は中止表示", async () => {
    await start();
    act(() => handlers?.onError?.({ ...base, error: "no", kind: "aiRefused" }));
    await screen.findByText(t("aiSampleRefused", { message: "no" }));
    cleanup();
    await start();
    act(() => handlers?.onCancelled?.({ streamId: "s", deliveredRows: 0 }));
    await screen.findByText(t("aiSampleCancelled"));
  });
});
