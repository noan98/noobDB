import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const schemaOverview = vi.fn();
const foreignKeys = vi.fn();
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const unlisten = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;
let listenGate: Promise<void> | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      if (listenGate !== null) await listenGate;
      return unlisten;
    }),
    api: {
      ...actual.api,
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      schemaOverview: (...a: unknown[]) => schemaOverview(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiQueryModal } from "../components/AiQueryModal";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onInsert = vi.fn();
const onOpenInNewTab = vi.fn();
const onClose = vi.fn();

function enable(enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true },
  });
}

function ui(over: Partial<React.ComponentProps<typeof AiQueryModal>> = {}) {
  return (
    <AiQueryModal
      sessionId="s1"
      driver="postgres"
      database="app"
      readOnly={false}
      isProduction={false}
      onInsert={onInsert}
      onOpenInNewTab={onOpenInNewTab}
      onClose={onClose}
      {...over}
    />
  );
}

const result = JSON.stringify({
  sql: "SELECT 1",
  explanation: "説明です",
  warnings: ["注意です"],
  tables_used: ["orders"],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  listenGate = null;
  schemaOverview.mockResolvedValue([{ name: "orders", columns: ["id", "amount"] }]);
  foreignKeys.mockResolvedValue([]);
  enable();
});

async function generate(text = "注文を集計して") {
  const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
  fireEvent.change(input, { target: { value: text } });
  const btn = screen.getByRole("button", { name: t("aiQueryGenerate") });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

describe("AiQueryModal (#691)", () => {
  it("AI 無効なら何も描かない", async () => {
    enable(false);
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByTestId("ai-query-modal")).toBeNull();
  });

  it("生成 → 結果表示 → 挿入 / 新しいタブで開く。nl2sql タスクで依頼し、実行はしない", async () => {
    renderWithProviders(ui());
    const btn = await generate();
    fireEvent.click(btn); // 二重クリックでも 1 本だけ
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("nl2sql");
    expect(req.prompt).toBe("注文を集計して");
    expect(req.system).toContain("PostgreSQL");
    expect(req.system).toContain("- orders(id, amount)");
    expect(req.format.type).toBe("json_schema");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SELECT 1");
    expect(screen.getByText("説明です")).toBeTruthy();
    expect(screen.getByText("注意です")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryInsert") }));
    expect(onInsert).toHaveBeenCalledWith("SELECT 1");
    await screen.findByText(t("aiQueryInserted"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryOpenInNewTab") }));
    expect(onOpenInNewTab).toHaveBeenCalledWith("SELECT 1", "app");
    // 挿入後も説明・注意点は見えたまま。
    expect(screen.getByText("説明です")).toBeTruthy();
  });

  it("読み取り専用ならプロンプトに SELECT 制約が入る", async () => {
    renderWithProviders(ui({ readOnly: true }));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(runAiRequest.mock.calls[0][0].system).toContain("READ-ONLY");
  });

  it("中止でき、アンマウント時は実行中ストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiQueryCancelled"));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(2);
  });

  it("購読の完了前に中止したら、リクエストを送らずに中止表示にする", async () => {
    let release: () => void = () => {};
    listenGate = new Promise<void>((r) => {
      release = r;
    });
    renderWithProviders(ui());
    await generate();
    fireEvent.click(await screen.findByRole("button", { name: t("aiQueryCancel") }));
    await act(async () => release());
    await screen.findByText(t("aiQueryCancelled"));
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("リクエスト登録前に中止したら、登録後に同じ streamId であらためて cancelStream する", async () => {
    let finish: () => void = () => {};
    runAiRequest.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = () => r();
        }),
    );
    renderWithProviders(ui());
    await generate();
    fireEvent.click(await screen.findByRole("button", { name: t("aiQueryCancel") }));
    const streamId = runAiRequest.mock.calls[0][0].streamId;
    expect(cancelStream).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(cancelStream).toHaveBeenCalledTimes(2));
    expect(cancelStream.mock.calls.map((c) => c[0])).toEqual([streamId, streamId]);
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("本番では送信前に確認し、取り消すと送らない", async () => {
    renderWithProviders(ui({ isProduction: true }));
    await generate();
    await screen.findByText(t("aiQueryConfirmTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("aiQueryConfirmTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();
    await generate();
    await screen.findByText(t("aiQueryConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("テーブルが多いスキーマは送信前に件数を見せる", async () => {
    schemaOverview.mockResolvedValue(Array.from({ length: 301 }, (_, i) => ({ name: `t${i}`, columns: ["id"] })));
    renderWithProviders(ui());
    const sends = await screen.findByTestId("ai-query-sends");
    expect(sends.textContent).toContain("301");
    expect(screen.getByText(/This schema is large|スキーマが大きいため/)).toBeTruthy();
  });

  it("データベースが無い (MySQL 未選択) ときは生成できない", async () => {
    renderWithProviders(ui({ driver: "mysql", database: null }));
    await screen.findByText(t("aiQueryNoDatabase"));
    expect((screen.getByRole("button", { name: t("aiQueryGenerate") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("テーブルが 0 件なら警告を出して生成を無効にする", async () => {
    schemaOverview.mockResolvedValue([]);
    renderWithProviders(ui());
    await screen.findByText(t("aiQueryEmptySchema"));
    fireEvent.change(screen.getByLabelText(t("aiQueryRequestLabel")), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: t("aiQueryGenerate") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("onError と aiRefused を表示し分ける", async () => {
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    await screen.findByText(t("aiQueryError", { message: "boom" }));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    act(() => handlers?.onError?.({ streamId: "x", error: "no", kind: "aiRefused" }));
    await screen.findByText(t("aiQueryRefused", { message: "no" }));
  });
});
