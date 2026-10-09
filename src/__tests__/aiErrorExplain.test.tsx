import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const hasAiApiKey = vi.fn().mockResolvedValue(true);
const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeTable = vi.fn().mockResolvedValue([]);
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const unlisten = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      return unlisten;
    }),
    api: {
      ...actual.api,
      hasAiApiKey: () => hasAiApiKey(),
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      describeTable: (...a: unknown[]) => describeTable(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiErrorExplain } from "../components/AiErrorExplain";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onApply = vi.fn().mockResolvedValue("applied");

function enable(sendScope: "schemaOnly" | "schemaAndSql" = "schemaAndSql", enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true, sendScope },
  });
}

function ui(isProduction = false) {
  return (
    <AiErrorExplain
      sessionId="s1"
      driver="mysql"
      isProduction={isProduction}
      errorKind="db"
      message="Unknown column 'nme'"
      sql="SELECT nme FROM users"
      database="app"
      onApply={onApply}
    />
  );
}

const result = JSON.stringify({ explanation: "E", cause: "C", suggestedSql: "SELECT name FROM users", notes: ["N"] });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hasAiApiKey.mockResolvedValue(true);
  handlers = null;
  enable();
});

async function clickExplain() {
  const btn = await screen.findByRole("button", { name: t("aiErrorExplainButton") });
  fireEvent.click(btn);
  return btn;
}

describe("AiErrorExplain (#692)", () => {
  it("AI 無効 / キー未設定なら何も描かない", async () => {
    enable("schemaAndSql", false);
    const { container } = renderWithProviders(ui());
    await act(async () => {});
    expect(container.querySelector("[data-testid=ai-error-explain]")).toBeNull();
  });

  it("二重クリックしても要求は 1 本だけ", async () => {
    renderWithProviders(ui());
    const btn = await clickExplain();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].task).toBe("errorExplain");
    expect(runAiRequest.mock.calls[0][0].format.type).toBe("json_schema");
  });

  it("onDone で結果を表示し、反映ボタンで onApply が呼ばれる", async () => {
    renderWithProviders(ui());
    await clickExplain();
    await waitFor(() => expect(handlers).not.toBeNull());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("E");
    fireEvent.click(screen.getByRole("button", { name: t("aiErrorExplainApply") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("SELECT name FROM users"));
    await screen.findByText(t("aiErrorExplainApplied"));
    expect(screen.getByText(t("aiErrorExplainMaskedNote"))).toBeTruthy();
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui());
    await clickExplain();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("onError / onCancelled の表示", async () => {
    renderWithProviders(ui());
    await clickExplain();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    await screen.findByText(t("aiErrorExplainError", { message: "boom" }));
    await clickExplain();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiErrorExplainCancelled"));
  });

  it("アンマウント時に実行中のストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui());
    await clickExplain();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it("schemaOnly では送信前に確認し、キャンセルすると送らない", async () => {
    enable("schemaOnly");
    renderWithProviders(ui());
    await clickExplain();
    await screen.findByText(t("aiErrorExplainScopeTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("aiErrorExplainScopeTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();
    // 取りやめた後は再度押せる
    await clickExplain();
    await screen.findByText(t("aiErrorExplainScopeTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiErrorExplainConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });
});
