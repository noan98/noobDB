import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const hasAiApiKey = vi.fn().mockResolvedValue(true);
const runAiRequest = vi.fn().mockResolvedValue(undefined);
const listIndexes = vi.fn().mockResolvedValue([]);
const tableRowEstimate = vi.fn().mockResolvedValue(100);
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
      listIndexes: (...a: unknown[]) => listIndexes(...a),
      tableRowEstimate: (...a: unknown[]) => tableRowEstimate(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { ExplainViewer } from "../components/ExplainViewer";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";
import type { QueryResult } from "../api/tauri";
import paneSource from "../components/PaneView.tsx?raw";
import appSource from "../App.tsx?raw";

const onInsertSql = vi.fn();

function enable(sendScope: "schemaOnly" | "schemaAndSql" = "schemaAndSql", enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true, sendScope },
  });
}

function sqliteResult(): QueryResult {
  return {
    columns: ["id", "parent", "notused", "detail"],
    rows: [[2, 0, 0, "SCAN users"]],
  } as unknown as QueryResult;
}

function ui(
  opts: { readOnly?: boolean; isProduction?: boolean; withAi?: boolean; streaming?: boolean; result?: QueryResult } = {},
) {
  return (
    <ExplainViewer
      result={opts.result ?? sqliteResult()}
      streaming={opts.streaming}
      driver="sqlite"
      ai={
        opts.withAi === false
          ? undefined
          : {
              sessionId: "s1",
              isProduction: opts.isProduction ?? false,
              readOnly: opts.readOnly ?? false,
              sql: "SELECT * FROM users WHERE name = 'alice'",
              database: "main",
              onInsertSql,
            }
      }
    />
  );
}

const answer = JSON.stringify({
  summary: "全件走査です",
  bottlenecks: [{ node: "users", reason: "フルスキャン", severity: "high" }],
  suggestions: [{ kind: "ddl", sql: "CREATE INDEX idx_name ON users(name)", rationale: "絞り込み" }],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hasAiApiKey.mockResolvedValue(true);
  handlers = null;
  enable();
});

async function clickInterpret() {
  const btn = await screen.findByRole("button", { name: t("explainAiButton") });
  fireEvent.click(btn);
  return btn;
}

describe("AiExplainInterpret (#693)", () => {
  it("AI 無効 / ai 未指定なら入口を出さない (従来どおり)", async () => {
    enable("schemaAndSql", false);
    const { container, unmount } = renderWithProviders(ui());
    await act(async () => {});
    expect(container.querySelector("[data-testid=ai-explain-interpret]")).toBeNull();
    unmount();
    enable();
    const r = renderWithProviders(ui({ withAi: false }));
    await act(async () => {});
    expect(r.container.querySelector("[data-testid=ai-explain-interpret]")).toBeNull();
  });

  it("API キー未設定なら出さない", async () => {
    hasAiApiKey.mockResolvedValue(false);
    const { container } = renderWithProviders(ui());
    await act(async () => {});
    expect(container.querySelector("[data-testid=ai-explain-interpret]")).toBeNull();
  });

  it("解釈 → 結果表示 → 挿入ハンドラ。task は explainInterpret で自動実行しない", async () => {
    renderWithProviders(ui({ readOnly: true }));
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("explainInterpret");
    expect(req.format.type).toBe("json_schema");
    expect(req.prompt).toContain("EXPLAIN QUERY PLAN");
    expect(req.prompt).toContain("SCAN users");
    expect(req.prompt).not.toContain("alice");
    expect(listIndexes).toHaveBeenCalledWith("s1", "main", "users");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: answer });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("全件走査です");
    expect(screen.getByText(t("explainAiReadOnlyNote"))).toBeTruthy();
    expect(onInsertSql).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("explainAiInsert") }));
    expect(onInsertSql).toHaveBeenCalledWith("CREATE INDEX idx_name ON users(name)");
    await screen.findByText(t("explainAiInserted"));
    expect(runAiRequest).toHaveBeenCalledTimes(1);
  });

  it("読み取り専用でなければ注記を出さない", async () => {
    renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: answer });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("全件走査です");
    expect(screen.queryByText(t("explainAiReadOnlyNote"))).toBeNull();
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("中止ボタンで cancelStream し、onCancelled の表示が出る", async () => {
    renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: t("explainAiCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("explainAiCancelled"));
  });

  it("アンマウント時に実行中のストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it("schemaOnly では送信前に確認し、取りやめると送らない", async () => {
    enable("schemaOnly");
    renderWithProviders(ui());
    await clickInterpret();
    await screen.findByText(t("explainAiScopeTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("explainAiScopeTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();
    await clickInterpret();
    await screen.findByText(t("explainAiScopeTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("explainAiConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("本番接続では毎回確認する", async () => {
    renderWithProviders(ui({ isProduction: true }));
    await clickInterpret();
    await screen.findByText(t("explainAiConfirmTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("explainAiConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("ストリーミング中はボタンが無効", async () => {
    renderWithProviders(ui({ streaming: true }));
    const btn = await screen.findByRole("button", { name: t("explainAiButton") });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("二重クリックしても要求は 1 本だけ", async () => {
    renderWithProviders(ui());
    const btn = await clickInterpret();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("計画が変わると作り直され、実行中のストリームは cancelStream される", async () => {
    const { rerender } = renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const next = { columns: ["id", "parent", "notused", "detail"], rows: [[2, 0, 0, "SEARCH users"]] } as unknown as QueryResult;
    rerender(ui({ result: next }));
    await waitFor(() => expect(cancelStream).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(t("explainAiCancel"))).toBeNull();
  });

  it("listIndexes に失敗したテーブルは落とし、行数推定の失敗は unknown で送る", async () => {
    listIndexes.mockRejectedValueOnce(new Error("no table"));
    renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("Tables referenced");
    cleanup();
    vi.clearAllMocks();
    hasAiApiKey.mockResolvedValue(true);
    listIndexes.mockResolvedValue([]);
    tableRowEstimate.mockRejectedValueOnce(new Error("no stats"));
    renderWithProviders(ui());
    await clickInterpret();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("estimated rows: unknown");
  });
});

describe("EXPLAIN タブの配線 (#693)", () => {
  const pane = paneSource;
  const app = appSource;
  it("AI には EXPLAIN 前の元 SQL (explainSourceSql) を渡し、挿入は tab.database を引き継ぐ", () => {
    expect(pane).toContain("sql: tab.explainSourceSql ?? getTabSql(tab)");
    expect(pane).toContain("actions.openQueryInEditor(sql, undefined, tab.database)");
  });
  it("runExplainInTab が推定・実測の両方で元 SQL をタブに保存する", () => {
    expect(app).toContain("{ explainAnalyze: false, explainSourceSql: sql }");
    expect(app).toContain("{ explainAnalyze: true, explainSourceSql: sql }");
  });
});
