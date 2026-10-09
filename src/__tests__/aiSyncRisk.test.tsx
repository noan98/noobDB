import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const hasAiApiKey = vi.fn().mockResolvedValue(true);
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
      hasAiApiKey: () => hasAiApiKey(),
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiSyncRisk, type RiskByIndex } from "../components/AiSyncRisk";
import { SyncStatementRow } from "../components/SchemaCompareView";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";
import { setAiKeyPresent } from "../ai/aiKeyStore";
import type { SyncPlan } from "../api/tauri";

const PLAN: SyncPlan = {
  statements: [
    { sql: "ALTER TABLE users ADD COLUMN age int", table: "users", kind: "add_column", destructive: false },
    { sql: "DROP TABLE legacy", table: "legacy", kind: "drop_table", destructive: true },
  ],
  warnings: [],
};

function enable(sendScope: "schemaOnly" | "schemaAndSql" = "schemaAndSql", enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true, sendScope },
  });
}

function Harness({ isProduction = false, planKind = "schema" as "schema" | "data" }) {
  const [risks, setRisks] = useState<RiskByIndex | null>(null);
  return (
    <div>
      <AiSyncRisk
        plan={PLAN}
        planKind={planKind}
        diff={null}
        dataSummary={planKind === "data" ? { table: "users", inserts: 2, updates: 1, deletes: 1, truncated: false } : null}
        sourceDriver="mysql"
        targetDriver="mysql"
        allowDestructive
        allowDelete={false}
        isProduction={isProduction}
        onRisks={setRisks}
      />
      <ul>
        {PLAN.statements.map((s, i) => (
          <SyncStatementRow key={i} index={i} statement={s} checked onToggle={() => {}} risks={risks?.get(i)} />
        ))}
      </ul>
    </div>
  );
}

const response = JSON.stringify({
  summary: "Adds a column and drops a table",
  risk_items: [{ statement_index: 1, risk: "legacy is lost", severity: "high" }],
  recommendation: "Take a backup",
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hasAiApiKey.mockResolvedValue(true);
  setAiKeyPresent(true);
  handlers = null;
  enable();
});

async function click() {
  fireEvent.click(await screen.findByRole("button", { name: t("aiSyncRiskButton") }));
}

describe("AiSyncRisk (#697)", () => {
  it("AI 無効なら何も描かない", async () => {
    enable("schemaAndSql", false);
    const { container } = renderWithProviders(<Harness />);
    await act(async () => {});
    expect(container.querySelector("[data-testid=ai-sync-risk]")).toBeNull();
  });

  it("要約を表示し、各文にバッジを付ける (task は syncRisk)", async () => {
    renderWithProviders(<Harness />);
    expect(await screen.findByText(t("aiSyncRiskDisclaimer"))).toBeTruthy();
    await click();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("syncRisk");
    expect(req.model).toBeUndefined();
    expect(req.format.type).toBe("json_schema");
    expect(req.prompt).toContain("DROP TABLE legacy");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: response });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("Adds a column and drops a table");
    const badges = screen.getAllByTestId("ai-sync-risk-badge");
    // パネル内の一覧 + 行のバッジ。
    expect(badges.length).toBe(2);
    expect(badges.every((b) => b.getAttribute("data-severity") === "high")).toBe(true);
  });

  it("説明の無い破壊的文には補完バッジが付く", async () => {
    renderWithProviders(<Harness />);
    await click();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: JSON.stringify({ summary: "S", risk_items: [], recommendation: "R" }) });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("S");
    expect(screen.getAllByText(t("aiSyncRiskMissingExplanation")).length).toBeGreaterThan(0);
  });

  it("中止でき、バッジは付かない", async () => {
    renderWithProviders(<Harness />);
    await click();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: t("aiSyncRiskCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiSyncRiskCancelled"));
    expect(screen.queryAllByTestId("ai-sync-risk-badge").length).toBe(0);
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(<Harness />);
    await click();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("schemaOnly なら送る前に確認し、断ると送らない", async () => {
    enable("schemaOnly");
    renderWithProviders(<Harness />);
    await click();
    await screen.findByText(t("aiSyncRiskScopeTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: t("confirmDefaultCancel") }).at(-1) as HTMLElement);
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
    // もう一度押せば再び確認される (毎回)。
    await click();
    await screen.findByText(t("aiSyncRiskScopeTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiSyncRiskConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("本番接続なら確認し、データ比較のプロンプトに SQL 本文を含めない", async () => {
    renderWithProviders(<Harness isProduction planKind="data" />);
    await click();
    await screen.findByText(t("aiSyncRiskProdTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiSyncRiskConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const prompt = runAiRequest.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("rows to insert: 2");
    expect(prompt).not.toContain("DROP TABLE legacy");
  });
});
