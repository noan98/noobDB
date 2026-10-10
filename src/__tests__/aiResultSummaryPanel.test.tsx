import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
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
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiResultSummaryPanel, type AiResultSummaryRequest } from "../components/AiResultSummaryPanel";
import { ResultGrid } from "../components/ResultGrid";
import { resetAiKeyStoreForTest, setAiKeyPresent } from "../ai/aiKeyStore";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onInsert = vi.fn().mockResolvedValue("inserted");
const onRequestConsumed = vi.fn();

function setAi(patch: Partial<typeof DEFAULT_SETTINGS.ai> = {}) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true, sendScope: "schemaAndSql", ...patch },
  });
}

const req = (patch: Partial<AiResultSummaryRequest> = {}): AiResultSummaryRequest => ({
  id: 1,
  tabId: "tab1",
  tabTitle: "Query 1",
  sql: "SELECT email, amount FROM users",
  database: "app",
  columns: [
    { name: "email", type_name: "VARCHAR" },
    { name: "amount", type_name: "INT" },
  ],
  rows: [
    ["alice@secret.example", 10],
    ["bob@secret.example", 20],
  ],
  autoRun: true,
  ...patch,
});

function ui(request: AiResultSummaryRequest | null, isProduction = false) {
  return (
    <AiResultSummaryPanel
      driver="mysql"
      isProduction={isProduction}
      request={request}
      onRequestConsumed={onRequestConsumed}
      onInsert={onInsert}
    />
  );
}

const resultJson = JSON.stringify({
  summary: "SUMMARY-TEXT",
  trends: ["TREND-1"],
  anomalies: ["ANOMALY-1"],
  next_queries: [{ title: "QUERY-TITLE", sql: "SELECT COUNT(*) FROM users", reason: "WHY" }],
});

async function finish(text: string) {
  await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
  act(() => {
    handlers?.onDelta?.({ streamId: "x", text });
    handlers?.onDone?.({} as never);
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  setLocale("en");
  setAi();
});

describe("AiResultSummaryPanel (#1476)", () => {
  it("依頼がなければ案内を出し、送信しない", () => {
    renderWithProviders(ui(null));
    expect(screen.getByText(t("aiResultSummaryEmpty"))).toBeTruthy();
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("allowRowData オフ: セルの値を送らず (task: resultSummary)、送信内容にもそう表示する", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const arg = runAiRequest.mock.calls[0][0];
    expect(arg.task).toBe("resultSummary");
    expect(arg.format.type).toBe("json_schema");
    const sent = `${arg.system}\n${arg.prompt}`;
    expect(sent).not.toContain("alice@secret.example");
    expect(sent).not.toContain("bob@secret.example");
    expect(sent).toContain("email VARCHAR");
    expect(screen.getByTestId("ai-result-summary-source").textContent).toContain("Query 1");
    expect(screen.getByTestId("ai-result-summary-sends").textContent).toContain(t("aiResultSummaryRowsNone"));
  });

  it("allowRowData オン: 確認ダイアログを経て先頭行を送る。取りやめれば送らない", async () => {
    setAi({ allowRowData: true });
    renderWithProviders(ui(req()));
    await screen.findByText(t("aiResultSummaryRowsTitle"));
    fireEvent.click(screen.getAllByRole("button", { name: t("confirmDefaultCancel") }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByText(t("aiResultSummaryRowsTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();

    cleanup();
    renderWithProviders(ui(req({ id: 2 })));
    await screen.findByText(t("aiResultSummaryRowsTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("alice@secret.example");
  });

  it("本番接続では送信前に確認する", async () => {
    renderWithProviders(ui(req(), true));
    await screen.findByText(new RegExp(t("aiResultSummaryProdBody").slice(0, 30)));
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("完了後に傾向・外れ値・追加 SQL 案を表示し、「エディタに挿入」で親へ渡す", async () => {
    renderWithProviders(ui(req()));
    await finish(resultJson);
    await screen.findByText("SUMMARY-TEXT");
    expect(screen.getByText(/TREND-1/)).toBeTruthy();
    expect(screen.getByText(/ANOMALY-1/)).toBeTruthy();
    expect(screen.getByText("QUERY-TITLE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("aiResultSummaryInsert") }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(1));
    expect(onInsert.mock.calls[0][0].tabId).toBe("tab1");
    expect(onInsert.mock.calls[0][1]).toBe("SELECT COUNT(*) FROM users");
    await screen.findByText(t("aiResultSummaryInserted"));
  });

  it("実行中に中止できる", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: t("aiSqlCancel") }));
    await waitFor(() => expect(cancelStream).toHaveBeenCalled());
  });
});

describe("結果グリッドの「AI で要約」入口", () => {
  const result = { columns: req().columns, rows: req().rows, rows_affected: 0, elapsed_ms: 1 };

  beforeEach(() => {
    resetAiKeyStoreForTest();
  });

  it("AI 有効 + キーありなら出て、押すと依頼コールバックが呼ばれる", async () => {
    setAi();
    setAiKeyPresent(true);
    const onSummarize = vi.fn();
    renderWithProviders(<ResultGrid result={result} onSummarizeWithAi={onSummarize} />);
    const btn = await screen.findByRole("button", { name: new RegExp(t("aiResultSummaryToolbar")) });
    fireEvent.click(btn);
    expect(onSummarize).toHaveBeenCalledTimes(1);
  });

  it("AI 無効 / キー未設定 / コールバック無しなら出さない", async () => {
    const onSummarize = vi.fn();
    const q = () => screen.queryByRole("button", { name: new RegExp(t("aiResultSummaryToolbar")) });
    replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: false } });
    setAiKeyPresent(true);
    renderWithProviders(<ResultGrid result={result} onSummarizeWithAi={onSummarize} />);
    expect(q()).toBeNull();
    cleanup();
    setAi();
    setAiKeyPresent(false);
    renderWithProviders(<ResultGrid result={result} onSummarizeWithAi={onSummarize} />);
    expect(q()).toBeNull();
    cleanup();
    setAiKeyPresent(true);
    renderWithProviders(<ResultGrid result={result} />);
    expect(q()).toBeNull();
  });
});
