import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { HistoryEntry } from "../api/tauri";
import { makeProfile } from "./fixtures/componentFixtures";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const getHistorySql = vi.fn();
const listHistory = vi.fn();
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
      listHistory: (...a: unknown[]) => listHistory(...a),
    },
  };
});

import { AiHistorySearch, type HistoryFilterParams } from "../components/AiHistorySearch";
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

const FILTERS: HistoryFilterParams = { profileId: "p1", search: "sales", status: "ok", from: "2026-01-01T00:00:00Z", to: null };

function ui(list: HistoryEntry[] = entries) {
  listHistory.mockResolvedValue(list);
  return <AiHistorySearch filters={FILTERS} periodLabel="Last 7 days" onOpen={onOpen} />;
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
  listHistory.mockResolvedValue(entries);
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

  it("購読の完了前に中止したら、リクエストを送らずに中止表示にする", async () => {
    let release: () => void = () => {};
    listenImpl = () => new Promise<void>((r) => (release = r));
    renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistoryCancel") }));
    await act(async () => release());
    await screen.findByText(t("aiHistoryCancelled"));
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
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const streamId = runAiRequest.mock.calls[0][0].streamId;
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistoryCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(cancelStream).toHaveBeenCalledTimes(2));
    expect(cancelStream.mock.calls.map((c) => c[0])).toEqual([streamId, streamId]);
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

  it("候補は現在のフィルタ + limit 301 で取り直し、300 件を超えたら案内して 300 件だけ送る", async () => {
    const many = Array.from({ length: 301 }, (_, i) => entry(i + 1));
    getHistorySql.mockImplementation(async () => "SELECT 1");
    renderWithProviders(ui(many));
    await typeAndSearch();
    await screen.findByText(t("aiHistoryConfirmTitle"));
    expect(listHistory).toHaveBeenCalledWith({ ...FILTERS, limit: 301 });
    // 確認文にも上限超過の案内が入る
    expect(screen.getAllByText(t("aiHistoryOverflow", { max: 300 })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: t("aiHistoryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled(), { timeout: 5000 });
    expect(getHistorySql).toHaveBeenCalledTimes(300);
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("[id=301]");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: JSON.stringify({ matches: [{ history_id: "1", relevance: 1, reason: "r" }] }) });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("r");
    expect(screen.getAllByText(t("aiHistoryOverflow", { max: 300 })).length).toBeGreaterThan(0);
  });

  it("プロファイル読み込みが遅くても、確認前に最新を待って本番の注記を出す", async () => {
    let resolve: (v: unknown) => void = () => {};
    listProfiles.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithProviders(ui());
    await typeAndSearch();
    await act(async () => {});
    expect(screen.queryByText(t("aiHistoryConfirmTitle"))).toBeNull();
    await act(async () => resolve([makeProfile({ id: "p1", name: "Main DB", is_production: true })]));
    await screen.findByText(t("aiHistoryConfirmTitle"));
    expect(screen.getByText(t("aiHistoryConfirmProduction"))).toBeTruthy();
  });

  it("プロファイル取得に失敗したら安全側に倒して本番扱いの注記を出す", async () => {
    listProfiles.mockRejectedValue(new Error("x"));
    renderWithProviders(ui());
    await typeAndSearch();
    await screen.findByText(t("aiHistoryConfirmTitle"));
    expect(screen.getByText(t("aiHistoryConfirmProductionUnknown"))).toBeTruthy();
  });

  it("データベース名が確認文に入る", async () => {
    renderWithProviders(ui());
    await typeAndSearch();
    await screen.findByText(t("aiHistoryConfirmTitle"));
    expect(screen.getByText(/databases: app/)).toBeTruthy();
  });

  it("SQL 取得バッチの途中で中止したら、以降の取得も送信もしない", async () => {
    const many = Array.from({ length: 45 }, (_, i) => entry(i + 1));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    getHistorySql.mockImplementation(async () => {
      await gate;
      return "SELECT 1";
    });
    renderWithProviders(ui(many));
    await typeAndSearch();
    await confirmSend();
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistoryCancel") }));
    await act(async () => release());
    await screen.findByText(t("aiHistoryCancelled"));
    expect(getHistorySql).toHaveBeenCalledTimes(20);
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("一部の SQL 取得に失敗したら件数を通知する", async () => {
    getHistorySql.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error("gone");
      return "SELECT 1";
    });
    renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(runAiRequest.mock.calls[0][0].prompt).not.toContain("[id=2]");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: JSON.stringify({ matches: [] }) });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText(t("aiHistoryFetchFailed", { count: 1 }));
  });

  it("結果の行は完了時のスナップショットを持つ (props が変わっても消えない)", async () => {
    const { rerender } = renderWithProviders(ui());
    await typeAndSearch();
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: JSON.stringify({ matches: [{ history_id: "1", relevance: 50, reason: "keep" }] }) });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("keep");
    rerender(<AiHistorySearch filters={{ ...FILTERS, search: null }} periodLabel="All time" onOpen={onOpen} />);
    expect(screen.getByText("keep")).toBeTruthy();
    expect(screen.getByText("SELECT sum(x) FROM sales")).toBeTruthy();
  });

  it("サマリ経路でもリテラルとコメントをマスクして送る", async () => {
    getHistorySql.mockImplementation(async () => "SELECT 1 -- note: topsecret\n, 'literal-value'");
    renderWithProviders(ui());
    fireEvent.click(await screen.findByRole("button", { name: t("aiHistorySummaryRun") }));
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const prompt = runAiRequest.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("literal-value");
    expect(prompt).not.toContain("topsecret");
    // 期間は ISO で送る
    expect(prompt).toMatch(/Period: Last 7 days \(2026-01-01T00:00:00Z - 2026-01-01T00:00:00Z\)/);
  });

  it("検索とサマリを続けて押してもストリームは 1 本", async () => {
    renderWithProviders(ui());
    await typeAndSearch();
    const summary = await screen.findByRole("button", { name: t("aiHistorySummaryRun") });
    expect((summary as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(summary);
    await confirmSend();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].format).toBeDefined();
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

describe("AiHistorySearch 候補 0 件 (#699)", () => {
  it("条件に一致する履歴が無ければ送信せず案内を出す", async () => {
    renderWithProviders(ui([]));
    await typeAndSearch();
    await screen.findByText(t("aiHistoryNoCandidates"));
    expect(screen.queryByText(t("aiHistoryConfirmTitle"))).toBeNull();
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("SQL 全文を 1 件も取得できなければ送信せずエラーにする", async () => {
    getHistorySql.mockRejectedValue(new Error("gone"));
    renderWithProviders(ui([entry(1)]));
    await typeAndSearch();
    await confirmSend();
    await screen.findByText(new RegExp(t("aiHistoryFetchAllFailed")));
    expect(runAiRequest).not.toHaveBeenCalled();
  });
});
