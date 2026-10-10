import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ProcessInfo } from "../api/tauri";

const hasAiApiKey = vi.fn().mockResolvedValue(true);
const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeTable = vi.fn();
const tableRowEstimate = vi.fn().mockResolvedValue(null);
const getProcessQuery = vi.fn();
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
      tableRowEstimate: (...a: unknown[]) => tableRowEstimate(...a),
      getProcessQuery: (...a: unknown[]) => getProcessQuery(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiLockDiagnose } from "../components/AiLockDiagnose";
import { resetAiKeyStoreForTest, setAiKeyPresent } from "../ai/aiKeyStore";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

function proc(id: number, over: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id,
    user: "app",
    host: "10.0.0.9:5555",
    database: "shop",
    command: "Query",
    state: null,
    time_secs: 10,
    query_summary: null,
    query_truncated: false,
    is_self: false,
    blocked_by: [],
    ...over,
  };
}

const chain = [
  proc(1, { query_summary: "UPDATE orders SET note = 'top-sec…" }),
  proc(2, { blocked_by: [1], query_summary: "SELECT * FROM orders FOR UPDATE" }),
];

function enable(opts: { sendScope?: "schemaOnly" | "schemaAndSql"; enabled?: boolean; maskLiterals?: boolean } = {}) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      enabled: opts.enabled ?? true,
      consentGiven: true,
      sendScope: opts.sendScope ?? "schemaAndSql",
      maskLiterals: opts.maskLiterals ?? true,
    },
  });
}

function ui(over: Partial<React.ComponentProps<typeof AiLockDiagnose>> = {}) {
  return (
    <AiLockDiagnose
      sessionId="s1"
      driver="mysql"
      processes={chain}
      selectedIds={new Set()}
      {...over}
    />
  );
}

const result = JSON.stringify({
  summary: "SUMMARY_TEXT",
  waits: [{ session_id: 2, waiting_for: [1], detail: "WAIT_DETAIL" }],
  stop_candidates: [{ session_id: 1, impact: "low", reason: "STOP_REASON" }],
  prevention: ["PREVENT_TEXT"],
});

const ask = () => screen.findByRole("button", { name: new RegExp(t("lockDiagnoseButton")) });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetAiKeyStoreForTest();
  setAiKeyPresent(true);
  getProcessQuery.mockImplementation(async (_s: string, id: number) =>
    id === 1 ? "UPDATE orders SET note = 'top-secret-note' WHERE id = 5" : null,
  );
  describeTable.mockResolvedValue([
    { name: "id", data_type: "int", nullable: false, key: "PRI", default: "DEFAULT_SENTINEL", extra: "", referenced_table: null, referenced_column: null },
  ]);
  tableRowEstimate.mockResolvedValue(12000);
  handlers = null;
  enable();
});

describe("AiLockDiagnose (#1478)", () => {
  it("AI 無効 / キー未設定 / SQLite では入口を出さない", async () => {
    enable({ enabled: false });
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByTestId("ai-lock-diagnose")).toBeNull();
    cleanup();
    enable();
    setAiKeyPresent(false);
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByTestId("ai-lock-diagnose")).toBeNull();
    cleanup();
    setAiKeyPresent(true);
    renderWithProviders(ui({ driver: "sqlite" }));
    await act(async () => {});
    expect(screen.queryByTestId("ai-lock-diagnose")).toBeNull();
  });

  it("自動送信せず、押したときだけ lockDiagnose タスクで要求する (待機関係・全文・スキーマ)", async () => {
    renderWithProviders(ui());
    await ask();
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(await ask());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("lockDiagnose");
    expect(req.format.type).toBe("json_schema");
    expect(req.prompt).toContain("#2 waits for #1");
    expect(req.prompt).toContain("orders (estimated rows: 12000)");
    // 全文を取り直して送る (要約に切り替わっていない)。ホストと既定値は送らない。
    expect(req.prompt).toContain("UPDATE orders SET note =");
    expect(req.prompt).not.toContain("10.0.0.9");
    expect(req.prompt).not.toContain("DEFAULT_SENTINEL");
  });

  it("maskLiterals の設定でクエリ本文のリテラルを送る / 送らないが変わる", async () => {
    renderWithProviders(ui());
    fireEvent.click(await ask());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("top-secret-note");
    cleanup();
    vi.clearAllMocks();
    enable({ maskLiterals: false });
    renderWithProviders(ui());
    fireEvent.click(await ask());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("top-secret-note");
  });

  it("送信範囲が「スキーマのみ」なら確認し、拒否したら送らない / 承諾したら送る", async () => {
    enable({ sendScope: "schemaOnly" });
    renderWithProviders(ui());
    fireEvent.click(await ask());
    fireEvent.click(await screen.findByRole("button", { name: t("dangerousAiConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("確認を拒否すると要求しない", async () => {
    enable({ sendScope: "schemaOnly" });
    renderWithProviders(ui());
    fireEvent.click(await ask());
    await screen.findByText(t("lockDiagnoseScopeTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("結果 (待機・止める候補・再発防止) を表示し、KILL は自動実行せず注意書きを出す", async () => {
    renderWithProviders(ui());
    expect(await screen.findByText(t("lockDiagnoseGuardNote"))).toBeTruthy();
    fireEvent.click(await ask());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SUMMARY_TEXT");
    expect(screen.getByText("WAIT_DETAIL")).toBeTruthy();
    expect(screen.getByText("STOP_REASON")).toBeTruthy();
    expect(screen.getByText(/PREVENT_TEXT/)).toBeTruthy();
    expect(screen.getByText(t("lockDiagnoseStopNote"))).toBeTruthy();
  });

  it("実行中は中止でき、中止の表示になる", async () => {
    renderWithProviders(ui());
    fireEvent.click(await ask());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: t("dangerousAiStop") }));
    expect(cancelStream).toHaveBeenCalled();
  });

  it("対象が無いときは要求しない", async () => {
    renderWithProviders(ui({ processes: [proc(1, { time_secs: 0 })] }));
    fireEvent.click(await ask());
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("選択中のプロセスがあればそれを対象にする", async () => {
    renderWithProviders(
      ui({
        processes: [proc(7, { query_summary: "SELECT 1 FROM t" }), ...chain],
        selectedIds: new Set([7]),
      }),
    );
    expect((await screen.findByTestId("ai-lock-scope")).textContent).toContain(t("lockDiagnoseScopeSelection"));
    fireEvent.click(await ask());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("#7");
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("#1 (");
  });
});
