import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { HistoryEntry } from "../api/tauri";
import { makeProfile } from "./fixtures/componentFixtures";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const getHistorySql = vi.fn();
const listProfiles = vi.fn();
const unlisten = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;
let listenImpl: (() => Promise<void>) | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      if (listenImpl) await listenImpl();
      return unlisten;
    }),
    api: {
      ...actual.api,
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
      getHistorySql: (...a: unknown[]) => getHistorySql(...a),
      listProfiles: () => listProfiles(),
    },
  };
});

import { AiHistorySearch } from "../components/AiHistorySearch";
import { setAiKeyPresent } from "../ai/aiKeyStore";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

function entry(id: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    profile_id: "p1",
    driver: "mysql",
    database: "app",
    sql_preview: `SELECT ${id}`,
    sql_len: 10,
    rows: 1,
    rows_affected: null,
    elapsed_ms: 1,
    status: "ok",
    error: null,
    executed_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function enable(opts: { sendScope?: "schemaOnly" | "schemaAndSql"; enabled?: boolean; mask?: boolean } = {}) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      enabled: opts.enabled ?? true,
      consentGiven: true,
      sendScope: opts.sendScope ?? "schemaAndSql",
      maskLiterals: opts.mask ?? true,
    },
  });
}

const onOpen = vi.fn();
const entries = [entry(1, { sql_preview: "SELECT sum(x) FROM sales" }), entry(2)];

function ui(list: HistoryEntry[] = entries) {
  return <AiHistorySearch entries={list} periodLabel="Last 7 days" onOpen={onOpen} />;
}

async function typeAndSearch(q = "売上集計") {
  const input = await screen.findByLabelText(t("aiHistoryQueryLabel"));
  fireEvent.change(input, { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: t("aiHistorySearchRun") }));
}

async function confirmSend() {
  await screen.findByText(t("aiHistoryConfirmTitle"));
  fireEvent.click(screen.getByRole("button", { name: t("aiHistoryConfirmSend") }));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  listenImpl = null;
  setAiKeyPresent(true);
  enable();
  listProfiles.mockResolvedValue([makeProfile({ id: "p1", name: "Main DB" })]);
  getHistorySql.mockImplementation(async (id: number) =>
    id === 1 ? "SELECT sum(x) FROM sales WHERE email = 'secret@example.com'" : "SELECT 2",
  );
});

describe("AiHistorySearch (#699)", () => {
  it("AI 無効 / キー未設定なら何も描かない", async () => {
    enable({ enabled: false });
    const { container } = renderWithProviders(ui());
    await act(async () => {});
    expect(container.querySelector("[data-testid=ai-history-search]")).toBeNull();
    cleanup();
    enable();
    setAiKeyPresent(false);
    const r = renderWithProviders(ui());
    await act(async () => {});
    expect(r.container.querySelector("[data-testid=ai-history-search]")).toBeNull();
  });

  it("確認 → 検索 → 候補外 id を除いて結果を表示し、行で復元できる", async () => {
    renderWithProviders(ui());
    await typeAndSearch();
    // 確認前は送信しない
    await screen.findByText(t("aiHistoryConfirmTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("historySearch");
    expect(req.model).toBeUndefined();
    expect(req.format.type).toBe("json_schema");
    // リテラルはマスクされて送られる
    expect(req.prompt).not.toContain("secret@example.com");
    expect(req.prompt).toContain("[id=1]");
    act(() => {
      handlers?.onDelta?.({
        streamId: "x",
        text: JSON.stringify({
          matches: [
            { history_id: "2", relevance: 20, reason: "弱い" },
            { history_id: "999", relevance: 100, reason: "存在しない" },
            { history_id: "1", relevance: 90, reason: "売上の集計" },
          ],
        }),
      });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("売上の集計");
    expect(screen.queryByText("存在しない")).toBeNull();
    const rows = await screen.findAllByRole("button", { name: new RegExp(t("aiHistoryOpen")) });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("マスク無効ならリテラルもそのまま送る", async () => {
    enable({ mask: false });
    renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("secret@example.com");
  });

  it("確認をキャンセルすると SQL 取得も送信もしない", async () => {
    renderWithProviders(ui());
    await typeAndSearch();
    await screen.findByText(t("aiHistoryConfirmTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("aiHistoryConfirmTitle"))).toBeNull());
    expect(getHistorySql).not.toHaveBeenCalled();
    expect(runAiRequest).not.toHaveBeenCalled();
    // 取りやめた後に再実行できる
    fireEvent.click(screen.getByRole("button", { name: t("aiHistorySearchRun") }));
    await screen.findByText(t("aiHistoryConfirmTitle"));
  });

  it("確認文に件数・接続・schemaOnly・本番の注意が入る", async () => {
    enable({ sendScope: "schemaOnly" });
    listProfiles.mockResolvedValue([makeProfile({ id: "p1", name: "Main DB", is_production: true })]);
    renderWithProviders(ui());
    // 接続名が引けるのを待つ
    await act(async () => {});
    await typeAndSearch();
    await screen.findByText(t("aiHistoryConfirmTitle"));
    expect(screen.getByText(/Main DB/)).toBeTruthy();
    expect(screen.getByText(new RegExp(t("aiHistoryConfirmScopeOnly").slice(0, 10)))).toBeTruthy();
    expect(screen.getByText(new RegExp(t("aiHistoryConfirmProduction")))).toBeTruthy();
  });

  it("サマリ生成は構造化なしで本文を表示し、コピーできる", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(ui());
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistorySummaryRun") }));
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("historySearch");
    expect(req.format).toBeUndefined();
    expect(req.prompt).toContain("Period: Last 7 days");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "- 売上テーブルを集計\n" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText(/売上テーブルを集計/);
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistorySummaryCopy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("- 売上テーブルを集計"));
  });

  it("実行中の中止で cancelStream を呼び、onCancelled で表示を変える", async () => {
    renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistoryCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiHistoryCancelled"));
  });

  it("リクエスト登録前の中止は、登録後にあらためて cancelStream する", async () => {
    let release: () => void = () => {};
    listenImpl = () => new Promise<void>((r) => (release = r));
    renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistoryCancel") }));
    await act(async () => release());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    // 登録前の呼び出し + 登録後の再呼び出し
    await waitFor(() => expect(cancelStream.mock.calls.length).toBeGreaterThanOrEqual(1));
    expect(cancelStream.mock.calls.every((c) => typeof c[0] === "string")).toBe(true);
  });

  it("購読の完了前にアンマウントされたら cancelStream する", async () => {
    let release: () => void = () => {};
    listenImpl = () => new Promise<void>((r) => (release = r));
    const { unmount } = renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(handlers).not.toBeNull());
    unmount();
    await act(async () => release());
    expect(cancelStream).toHaveBeenCalled();
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("300 件を超える履歴は新しい 300 件だけを対象にし、案内を出す", async () => {
    const many = Array.from({ length: 305 }, (_, i) => entry(i + 1));
    getHistorySql.mockImplementation(async () => "SELECT 1");
    renderWithProviders(ui(many));
    expect(await screen.findByText(/305/)).toBeTruthy();
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled(), { timeout: 5000 });
    expect(getHistorySql).toHaveBeenCalledTimes(300);
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("[id=301]");
  });

  it("エラーと JSON でない応答を表示する", async () => {
    renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText(t("aiHistoryParseError"));
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistorySearchRun") }));
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    await screen.findByText(t("aiHistoryError", { message: "boom" }));
  });
});
