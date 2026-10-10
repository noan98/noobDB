import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

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
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      describeTable: (...a: unknown[]) => describeTable(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiSqlPanel, type AiSqlRequest } from "../components/AiSqlPanel";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onApply = vi.fn().mockResolvedValue("applied");
const onRequestConsumed = vi.fn();

function enable(sendScope: "schemaOnly" | "schemaAndSql" = "schemaAndSql", maskLiterals = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true, sendScope, maskLiterals },
  });
}

const req = (patch: Partial<AiSqlRequest> = {}): AiSqlRequest => ({
  id: 1,
  kind: "explain",
  sql: "SELECT * FROM users\nWHERE id = 1",
  range: { from: 0, to: 33 },
  tabId: "tab1",
  database: "app",
  autoRun: true,
  ...patch,
});

function ui(request: AiSqlRequest | null, isProduction = false) {
  return (
    <AiSqlPanel
      sessionId="s1"
      driver="mysql"
      isProduction={isProduction}
      request={request}
      onRequestConsumed={onRequestConsumed}
      onApply={onApply}
    />
  );
}

const explainJson = JSON.stringify({
  overview: "OVERVIEW",
  steps: [{ title: "STEP1", detail: "DETAIL1" }],
  caveats: ["CAVEAT1"],
});
const rewriteJson = JSON.stringify({
  rewritten_sql: "SELECT id\nFROM users\nWHERE id = 1",
  changes: [{ what: "WHAT", why: "WHY" }],
  equivalence_notes: ["EQ"],
  caveats: ["CAV"],
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
  enable();
});

describe("AiSqlPanel (#695)", () => {
  it("依頼がなければ案内を出す", () => {
    renderWithProviders(ui(null));
    expect(screen.getByText(t("aiSqlEmpty"))).toBeTruthy();
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("見出しと閉じるボタンを持たない (タブバーが担う)", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("button", { name: t("bottomPanelClose") })).toBeNull();
  });

  it("解説: 自動送信し (task: sqlExplain)、受信中は経過 / 途中の文章、完了後に構造化表示する", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(onRequestConsumed).toHaveBeenCalled();
    const arg = runAiRequest.mock.calls[0][0];
    expect(arg.task).toBe("sqlExplain");
    expect(arg.model).toBeUndefined();
    expect(arg.format.type).toBe("json_schema");
    act(() => handlers?.onDelta?.({ streamId: "x", text: "{\"over" }));
    await screen.findByText(t("aiStreamChars", { count: 6 }));
    const mid = explainJson.indexOf("VIEW") + 2;
    act(() => handlers?.onDelta?.({ streamId: "x", text: explainJson.slice(6, mid) }));
    expect((await screen.findByTestId("ai-stream-preview")).textContent).toBe("OVERVI");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: explainJson.slice(mid) });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("OVERVIEW");
    expect(screen.getByText("STEP1")).toBeTruthy();
    expect(screen.getByText("DETAIL1")).toBeTruthy();
    expect(screen.getByText("CAVEAT1")).toBeTruthy();
  });

  it("マスク有効なら文字列リテラルを送らない", async () => {
    renderWithProviders(ui(req({ sql: "SELECT * FROM users WHERE name = 'secret-value'" })));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("secret-value");
  });

  it("参照テーブルの定義を引いて送る (最大 5 件まで extractTableRefs が絞る)", async () => {
    describeTable.mockResolvedValueOnce([
      { name: "id", data_type: "int", nullable: false, key: "PRI", referenced_table: null, referenced_column: null },
    ]);
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(describeTable).toHaveBeenCalledWith("s1", "app", "users");
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("id int");
  });

  it("リライト: diff を色分けして出し、警告を必ず見せ、適用ボタンで onApply を呼ぶ", async () => {
    renderWithProviders(ui(req({ kind: "rewrite" })));
    await finish(rewriteJson);
    expect(runAiRequest.mock.calls[0][0].task).toBe("sqlRewrite");
    await screen.findByTestId("ai-sql-diff");
    expect(screen.getByText(t("aiSqlRewriteWarning"))).toBeTruthy();
    const rows = Array.from(document.querySelectorAll("[data-diff]")).map((e) => e.getAttribute("data-diff"));
    expect(rows).toContain("add");
    expect(rows).toContain("del");
    // 適用は明示操作のみ
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlApply") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1]).toBe("SELECT id\nFROM users\nWHERE id = 1");
    expect(onApply.mock.calls[0][0].tabId).toBe("tab1");
    await screen.findByText(t("aiSqlApplied"));
  });

  it("リライト: 提案が元と同じなら適用ボタンを無効にする (マスク無効で比較)", async () => {
    enable("schemaAndSql", false);
    renderWithProviders(ui(req({ kind: "rewrite" })));
    await finish(JSON.stringify({ ...JSON.parse(rewriteJson), rewritten_sql: "SELECT * FROM users\nWHERE id = 1" }));
    await screen.findByText(t("aiSqlNoChange"));
    expect((screen.getByRole("button", { name: t("aiSqlApply") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("適用が取りやめられたら通知する", async () => {
    onApply.mockResolvedValueOnce("cancelled");
    renderWithProviders(ui(req({ kind: "rewrite" })));
    await finish(rewriteJson);
    fireEvent.click(await screen.findByRole("button", { name: t("aiSqlApply") }));
    await screen.findByText(t("aiSqlApplyCancelled"));
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui(req()));
    await finish("plain text");
    await screen.findByText("plain text");
    expect(screen.getByText(t("aiSqlParseError"))).toBeTruthy();
  });

  it("中止ボタンで cancelStream し、onCancelled で表示する", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: t("aiSqlCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiSqlCancelled"));
  });

  it("onError を表示する", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    await screen.findByText(t("aiSqlError", { message: "boom" }));
  });

  it("アンマウント時に実行中のストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it("schemaOnly では送信前に確認し、取りやめると送らない", async () => {
    enable("schemaOnly");
    renderWithProviders(ui(req()));
    await screen.findByText(t("aiSqlScopeTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("aiSqlScopeTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();
    // 手動ボタンから再送でき、確認 → 送信する
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlExplainButton") }));
    await screen.findByText(t("aiSqlScopeTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("本番接続では送信前に確認する", async () => {
    renderWithProviders(ui(req(), true));
    await screen.findByText(t("aiSqlProdTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("autoRun が false の依頼 (再表示) では自動送信しない", async () => {
    renderWithProviders(ui(req({ autoRun: false })));
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlRewriteButton") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].task).toBe("sqlRewrite");
  });

  it("マスク有効: 空白リテラルを元の値に差し戻して diff に出し、適用 SQL にも反映する", async () => {
    renderWithProviders(ui(req({ kind: "rewrite", sql: "SELECT * FROM users WHERE name = 'bob'" })));
    await finish(JSON.stringify({ ...JSON.parse(rewriteJson), rewritten_sql: "SELECT id FROM users WHERE name = '   '" }));
    await screen.findByText(t("aiSqlRestoredNote"));
    // diff の左辺は生の元 SQL、右辺は差し戻し後
    const texts = Array.from(document.querySelectorAll("[data-diff]")).map((e) => e.textContent);
    expect(texts.some((x) => x?.includes("name = 'bob'") && x.startsWith("+"))).toBe(true);
    expect(texts.some((x) => x?.includes("SELECT * FROM users WHERE name = 'bob'") && x.startsWith("-"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlApply") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][1]).toBe("SELECT id FROM users WHERE name = 'bob'");
  });

  it("マスク有効で差し戻せないときは警告を出し、確認で取りやめると適用しない", async () => {
    renderWithProviders(ui(req({ kind: "rewrite", sql: "SELECT * FROM users" })));
    await finish(JSON.stringify({ ...JSON.parse(rewriteJson), rewritten_sql: "SELECT id FROM users WHERE n = ' '" }));
    await screen.findByText(t("aiSqlMaskedNote"));
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlApply") }));
    await screen.findByText(t("aiSqlMissingTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await screen.findByText(t("aiSqlApplyCancelled"));
    expect(onApply).not.toHaveBeenCalled();
    // 取りやめた後は再度押せて、承認すれば適用される
    await waitFor(() => expect(screen.queryByText(t("aiSqlMissingTitle"))).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlApply") }));
    await screen.findByText(t("aiSqlMissingTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlApplyAnyway") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });

  it("文の数が違う提案は適用前に確認する", async () => {
    enable("schemaAndSql", false);
    renderWithProviders(ui(req({ kind: "rewrite", sql: "SELECT 1;\nSELECT 2;" })));
    await finish(JSON.stringify({ ...JSON.parse(rewriteJson), rewritten_sql: "SELECT 1;" }));
    fireEvent.click(await screen.findByRole("button", { name: t("aiSqlApply") }));
    await screen.findByText(t("aiSqlStmtTitle"));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("aiSqlApplyAnyway") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });

  it("適用ボタンを続けて 2 回押しても 1 回しか適用されず、適用後は無効になる", async () => {
    let resolve: (v: string) => void = () => {};
    onApply.mockImplementationOnce(() => new Promise<string>((r) => { resolve = r; }));
    renderWithProviders(ui(req({ kind: "rewrite" })));
    await finish(rewriteJson);
    const btn = (await screen.findByRole("button", { name: t("aiSqlApply") })) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => resolve("applied"));
    await screen.findByText(t("aiSqlApplied"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("key (依頼) が変わると実行中のストリームを中止する", async () => {
    const wrap = (id: number) => <div key={id}>{ui(req({ id }))}</div>;
    const { rerender } = renderWithProviders(wrap(1));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    rerender(wrap(2));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
  });

  it("自動送信時にパネルへフォーカスを移す", async () => {
    renderWithProviders(ui(req()));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(document.activeElement).toBe(screen.getByTestId("ai-sql-panel"));
  });
});
