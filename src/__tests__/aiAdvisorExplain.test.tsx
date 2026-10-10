import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const hasAiApiKey = vi.fn().mockResolvedValue(true);
const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeTable = vi.fn();
const listIndexes = vi.fn();
const analyzeSchemaHealth = vi.fn();
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
      listIndexes: (...a: unknown[]) => listIndexes(...a),
      analyzeSchemaHealth: (...a: unknown[]) => analyzeSchemaHealth(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AdvisorPanel } from "../components/AdvisorPanel";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

function enable(sendScope: "schemaOnly" | "schemaAndSql" = "schemaAndSql", enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true, sendScope },
  });
}

const onInsertSql = vi.fn();
const ui = () => <AdvisorPanel sessionId="s1" database="app" onInsertSql={onInsertSql} />;

async function runDiagnosis() {
  fireEvent.click(screen.getByText(t("advisorRun")));
  await screen.findByText(t("advisorRuleUnusedIndexTitle"));
}
const askBtn = () => screen.findByRole("button", { name: t("advisorAiButton") });

const result = JSON.stringify({
  why: "WHY_TEXT",
  consequence: "CONSEQ_TEXT",
  fix_verdict: "caution",
  fix_advice: "ADVICE_TEXT",
  cautions: ["CAUTION_TEXT"],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hasAiApiKey.mockResolvedValue(true);
  describeTable.mockResolvedValue([
    { name: "id", data_type: "int", nullable: false, key: "PRI", default: "DEFAULT_SENTINEL", extra: "", referenced_table: null, referenced_column: null },
  ]);
  listIndexes.mockResolvedValue([{ name: "idx_note", columns: ["note"], unique: false, primary: false, method: null }]);
  analyzeSchemaHealth.mockResolvedValue({
    driver: "mysql",
    tables_analyzed: 1,
    findings: [
      {
        rule: "unused_index",
        severity: "low",
        table: "orders",
        columns: ["note"],
        context: ["idx_note"],
        fix_ddl: "DROP INDEX idx_note ON orders;",
        statistical: true,
      },
    ],
    skipped: [],
  });
  handlers = null;
  enable();
});

describe("アドバイザの AI 解説 (#1468)", () => {
  it("AI 無効 / キー未設定ならボタンを出さず、従来の表示のまま", async () => {
    enable("schemaAndSql", false);
    renderWithProviders(ui());
    await runDiagnosis();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: t("advisorAiButton") })).toBeNull();
    expect(screen.getByRole("button", { name: t("advisorInsertFix") })).toBeTruthy();
    cleanup();
    enable();
    hasAiApiKey.mockResolvedValue(false);
    renderWithProviders(ui());
    await runDiagnosis();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: t("advisorAiButton") })).toBeNull();
  });

  it("自動送信せず、押したときだけ advisorExplain で要求する。行データは送らない", async () => {
    renderWithProviders(ui());
    await runDiagnosis();
    const btn = await askBtn();
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("advisorExplain");
    expect(req.format.type).toBe("json_schema");
    expect(req.prompt).toContain("rule: unused_index");
    expect(req.prompt).toContain("DROP INDEX idx_note ON orders;");
    expect(req.prompt).toContain("index idx_note (note)");
    expect(req.prompt).not.toContain("DEFAULT_SENTINEL");
    expect(describeTable).toHaveBeenCalledWith("s1", "app", "orders");
  });

  it("2 回クリックしても要求は 1 本だけ", async () => {
    renderWithProviders(ui());
    await runDiagnosis();
    const btn = await askBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(runAiRequest).toHaveBeenCalledTimes(1);
  });

  it("結果を行内に表示し、SQL は実行 (挿入) しない", async () => {
    renderWithProviders(ui());
    await runDiagnosis();
    fireEvent.click(await askBtn());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("WHY_TEXT");
    expect(screen.getByText("CONSEQ_TEXT")).toBeTruthy();
    expect(screen.getByText("ADVICE_TEXT")).toBeTruthy();
    expect(screen.getByText(/CAUTION_TEXT/)).toBeTruthy();
    expect(screen.getByText(t("advisorAiVerdictCaution")).getAttribute("data-verdict")).toBe("caution");
    expect(screen.getByText(t("advisorAiGuardNote"))).toBeTruthy();
    expect(onInsertSql).not.toHaveBeenCalled();
  });

  it("応答を中止できる", async () => {
    renderWithProviders(ui());
    await runDiagnosis();
    fireEvent.click(await askBtn());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const streamId = runAiRequest.mock.calls[0][0].streamId;
    fireEvent.click(await screen.findByRole("button", { name: t("advisorAiStop") }));
    expect(cancelStream).toHaveBeenCalledWith(streamId);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("advisorAiCancelled"));
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui());
    await runDiagnosis();
    fireEvent.click(await askBtn());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("schemaOnly では送信前に確認し、取り消すと送らない", async () => {
    enable("schemaOnly");
    renderWithProviders(ui());
    await runDiagnosis();
    fireEvent.click(await askBtn());
    await screen.findByText(t("advisorAiScopeTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("実行中にアンマウントすると stream ID 付きで中止し unlisten する", async () => {
    const { unmount } = renderWithProviders(ui());
    await runDiagnosis();
    fireEvent.click(await askBtn());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const streamId = runAiRequest.mock.calls[0][0].streamId;
    unmount();
    expect(cancelStream).toHaveBeenCalledWith(streamId);
    expect(unlisten).toHaveBeenCalled();
  });
});
