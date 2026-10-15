import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { DataSearchStreamHandlers, TableRowEstimate } from "../api/tauri";

/**
 * DB 全体からの値検索 (#748) の空状態統一 (#847)。全テーブルを走査してもヒットが
 * 1 件もなかったケースで、共有 `EmptyState` (compact, icon="search") のタイトルが
 * 表示されることを固定する。
 *
 * 走査は Rust の `data_search_stream` (#1261) に移ったので、ここでは Channel のハンドラを
 * 捕まえて、バックエンドが送るメッセージ (進捗 / テーブルごとの結果 / 完了) を模擬する。
 */
const handlers: { current: DataSearchStreamHandlers | null } = { current: null };

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenDataSearchStream: vi.fn(async (_streamId: string, h: DataSearchStreamHandlers) => {
      handlers.current = h;
      return () => {
        handlers.current = null;
      };
    }),
    api: {
      ...actual.api,
      listTables: vi.fn().mockResolvedValue(["orders"]),
      tableRowEstimates: vi.fn().mockResolvedValue([{ name: "orders", estimate: 10 }] as TableRowEstimate[]),
      dataSearchStream: vi.fn().mockResolvedValue(undefined),
      cancelStream: vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 }),
    },
  };
});

import { api } from "../api/tauri";
import { DataSearchModal } from "../components/DataSearchModal";
import { dataSearchScope, loadDataSearchHistory, saveDataSearchHistory } from "../inputMemory";

beforeEach(() => {
  vi.clearAllMocks();
  handlers.current = null;
});

/** 走査中の Channel へバックエンドのメッセージを送る。 */
function emit(fn: (h: DataSearchStreamHandlers) => void) {
  act(() => {
    if (handlers.current) fn(handlers.current);
  });
}

async function startScan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(t("dataSearchTermLabel")), "needle");
  await user.click(screen.getByRole("button", { name: t("dataSearchStart") }));
  // 実行前確認ダイアログ (常時表示) を承認する。フッタの「開始」ボタンと同じラベルが
  // 確認ダイアログ側にも出るため、後から追加される (= 一覧の末尾) 方が確認ダイアログのボタン。
  const startButtons = await screen.findAllByRole("button", { name: t("dataSearchStart") });
  await user.click(startButtons[startButtons.length - 1]);
  await waitFor(() => expect(handlers.current).not.toBeNull());
  await waitFor(() => expect(api.dataSearchStream).toHaveBeenCalled());
  // 確認ダイアログが閉じ切る (退場アニメーション後にポインタ操作が戻る) まで待つ。
  await waitFor(() =>
    expect(screen.queryAllByRole("button", { name: t("dataSearchStart") })).toHaveLength(0),
  );
}

const renderModal = (onOpenHit: (sql: string, title: string) => void = () => {}) =>
  renderWithProviders(
    <DataSearchModal
      sessionId="s1"
      database="testdb"
      driver="mysql"
      isProduction={false}
      profileName="local"
      onOpenHit={onOpenHit}
      onClose={() => {}}
    />,
  );

describe("DataSearchModal empty state (#847)", () => {
  it("shows the shared EmptyState title when the scan finds no hits", async () => {
    const user = userEvent.setup();
    renderModal();
    await startScan(user);

    emit((h) => h.onProgress?.({ index: 0, total: 1, table: "orders" }));
    emit((h) => h.onTable?.({ entry: { status: "no-hit", table: "orders" } }));
    emit((h) => h.onDone?.());

    await waitFor(() => {
      expect(screen.getByText(t("dataSearchNoHits"))).toBeInTheDocument();
    });
  });
});

describe("DataSearchModal backend scan (#1261)", () => {
  it("sends the request (term, mode, tables, threshold) to the backend", async () => {
    const user = userEvent.setup();
    renderModal();
    await startScan(user);

    expect(api.dataSearchStream).toHaveBeenCalledWith({
      sessionId: "s1",
      streamId: expect.stringMatching(/^datasearch_/),
      request: {
        database: "testdb",
        term: "needle",
        mode: "contains",
        tables: ["orders"],
        rowThreshold: 500000,
      },
    });
  });

  it("renders hits and skipped tables from the streamed results, then opens a hit", async () => {
    const user = userEvent.setup();
    const onOpenHit = vi.fn();
    renderModal(onOpenHit);
    await startScan(user);

    emit((h) => h.onProgress?.({ index: 0, total: 1, table: "orders" }));
    emit((h) =>
      h.onTable?.({
        entry: {
          status: "hit",
          table: "orders",
          columns: [
            { name: "id", dataType: "int" },
            { name: "note", dataType: "varchar" },
          ],
          hits: [{ column: "note", count: 3 }],
        },
      }),
    );
    emit((h) =>
      h.onTable?.({
        entry: { status: "skipped", table: "big", reason: "row-threshold" },
      }),
    );
    emit((h) => h.onDone?.());

    const hit = await screen.findByText("note");
    expect(screen.getByText(t("dataSearchHitCount", { count: 3 }))).toBeInTheDocument();
    expect(screen.getByText(t("dataSearchSkipReasonThreshold"))).toBeInTheDocument();

    await user.click(hit);
    expect(onOpenHit).toHaveBeenCalledWith(
      "SELECT * FROM `testdb`.`orders` WHERE `note` LIKE '%needle%' ESCAPE '\\\\'",
      "orders.note",
    );
  });

  it("走査後に検索語を書き換えても、ヒットを開く条件は走査時の検索語のまま (#1594)", async () => {
    const user = userEvent.setup();
    const onOpenHit = vi.fn();
    renderModal(onOpenHit);
    await startScan(user);
    emit((h) =>
      h.onTable?.({
        entry: {
          status: "hit",
          table: "orders",
          columns: [{ name: "note", dataType: "varchar" }],
          hits: [{ column: "note", count: 3 }],
        },
      }),
    );
    emit((h) => h.onDone?.());
    const hit = await screen.findByText("note");

    const input = screen.getByLabelText(t("dataSearchTermLabel"));
    await user.clear(input);
    await user.type(input, "other");
    await user.click(hit);
    expect(onOpenHit).toHaveBeenCalledTimes(1);
    expect(onOpenHit.mock.calls[0][0]).toContain("%needle%");
    expect(onOpenHit.mock.calls[0][0]).not.toContain("other");
  });

  it("cancels the backend stream and shows the finished summary", async () => {
    const user = userEvent.setup();
    renderModal();
    await startScan(user);

    // 確認ダイアログの退場アニメーション中は同名のボタンが 2 つ並ぶので、1 つになるまで待つ。
    const cancelButton = await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: t("dataSearchCancel") });
      expect(buttons).toHaveLength(1);
      return buttons[0];
    });
    await user.click(cancelButton);
    expect(api.cancelStream).toHaveBeenCalledWith(expect.stringMatching(/^datasearch_/));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: t("dataSearchCancel") })).not.toBeInTheDocument();
    });
  });

  it("shows a stream-level error", async () => {
    const user = userEvent.setup();
    renderModal();
    await startScan(user);

    emit((h) => h.onError?.({ error: "boom", connectionLost: false }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});

describe("DataSearchModal skeleton (#1212)", () => {
  it("shows skeleton rows while the table metadata is loading", async () => {
    vi.mocked(api.listTables).mockReturnValueOnce(new Promise<string[]>(() => {}));
    renderModal();
    expect(await screen.findByText(t("dataSearchLoadingMeta"))).toBeInTheDocument();
    expect(screen.getAllByTestId("search-skeleton-row").length).toBeGreaterThan(0);
  });

  it("shows skeleton rows in the hits area while scanning, and removes them when done", async () => {
    const user = userEvent.setup();
    renderModal();
    await startScan(user);

    await waitFor(() => {
      expect(screen.getAllByTestId("search-skeleton-row").length).toBeGreaterThan(0);
    });

    emit((h) => h.onTable?.({ entry: { status: "no-hit", table: "orders" } }));
    emit((h) => h.onDone?.());
    await waitFor(() => {
      expect(screen.getByText(t("dataSearchNoHits"))).toBeInTheDocument();
    });
    expect(screen.queryAllByTestId("search-skeleton-row")).toHaveLength(0);
  });
});

describe("DataSearchModal の選択テーブル一覧の上限 (#1616)", () => {
  it("200 件までしか描画せず、「さらに表示」で広げ、絞り込みの入力で先頭へ戻る", async () => {
    const tables = Array.from({ length: 230 }, (_, i) => `tbl_${String(i).padStart(3, "0")}`);
    vi.mocked(api.listTables).mockResolvedValueOnce(tables);
    vi.mocked(api.tableRowEstimates).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByLabelText(t("dataSearchScopeSelected")));
    expect(await screen.findAllByRole("checkbox")).toHaveLength(200);
    await user.click(screen.getByRole("button", { name: t("dataSearchShowMoreTables", { remaining: 30 }) }));
    expect(await screen.findAllByRole("checkbox")).toHaveLength(230);
    await user.type(screen.getByPlaceholderText(t("dataSearchFilterPlaceholder")), "tbl_0");
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(100));
    expect(screen.queryByRole("button", { name: /^(さらに表示|Show more)/ })).toBeNull();
  });
});

describe("DataSearchModal の検索履歴 (#1631)", () => {
  it("履歴の条件をクリックすると、語と一致方式を戻して(確認を経て)再走査し、履歴の先頭へ繰り上げる", async () => {
    localStorage.clear();
    const scope = dataSearchScope("p1", "testdb");
    saveDataSearchHistory(scope, [
      { term: "older", mode: "contains", scope: "all", tables: [] },
      { term: "token-42", mode: "exact", scope: "all", tables: [] },
    ]);
    const user = userEvent.setup();
    renderWithProviders(
      <DataSearchModal
        sessionId="s1"
        database="testdb"
        driver="mysql"
        isProduction={false}
        profileName="local"
        profileId="p1"
        onOpenHit={() => {}}
        onClose={() => {}}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "token-42" }));
    // 実行前確認ダイアログを承認する。
    const startButtons = await screen.findAllByRole("button", { name: t("dataSearchStart") });
    await user.click(startButtons[startButtons.length - 1]);
    await waitFor(() => expect(api.dataSearchStream).toHaveBeenCalled());
    const call = vi.mocked(api.dataSearchStream).mock.calls[0][0];
    expect(call.request.term).toBe("token-42");
    expect(call.request.mode).toBe("exact");
    expect(call.request.tables).toEqual(["orders"]);
    expect(loadDataSearchHistory(scope).map((h) => h.term)).toEqual(["token-42", "older"]);
  });

  it("profileId が無ければ履歴を出さず、保存もしない", async () => {
    localStorage.clear();
    saveDataSearchHistory(dataSearchScope("p1", "testdb"), [
      { term: "secret-ish", mode: "contains", scope: "all", tables: [] },
    ]);
    renderModal();
    await screen.findByLabelText(t("dataSearchTermLabel"));
    expect(screen.queryByTestId("data-search-history")).not.toBeInTheDocument();
  });
});
