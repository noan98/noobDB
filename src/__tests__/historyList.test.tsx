import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor, fireEvent } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { HistoryEntry } from "../api/tauri";

/**
 * クエリ履歴パネル (#604)。マウント時に `api.listHistory()` を呼ぶためモックする。
 * 履歴 0 件で空状態が例外なくマウントされること、検索欄が可視であることを固定する。
 */
const listHistory = vi.fn().mockResolvedValue([]);
// 一覧は要約 (sql_preview) しか持たず、全文は getHistorySql で必要時に取る (#1256)。
const getHistorySql = vi.fn();
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listHistory: (...args: unknown[]) => listHistory(...args),
      getHistorySql: (...args: unknown[]) => getHistorySql(...args),
    },
  };
});

import { HistoryList } from "../components/HistoryList";
import { setAiKeyPresent } from "../ai/aiKeyStore";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 1,
    profile_id: "p-test",
    driver: "mysql",
    database: "appdb",
    sql_preview: "SELECT * FROM users",
    sql_len: 19,
    rows: 3,
    rows_affected: null,
    elapsed_ms: 12,
    status: "ok",
    error: null,
    executed_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listHistory.mockResolvedValue([]);
  getHistorySql.mockReset();
});

describe("HistoryList render smoke (#604)", () => {
  it("mounts with a search box and shows the empty state when there is no history", async () => {
    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={() => {}}
        onOpenInNewTab={() => {}}
      />,
    );
    expect(
      screen.getByPlaceholderText(t("historySearchPlaceholder")),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(t("historyEmptyTitle"))).toBeInTheDocument(),
    );
  });

  it("mounts without an active profile", async () => {
    renderWithProviders(
      <HistoryList
        activeProfile={null}
        sessionId={null}
        reloadKey={0}
        onRestore={() => {}}
        onOpenInNewTab={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(t("historyEmptyTitle"))).toBeInTheDocument(),
    );
  });
});

describe("HistoryList の「スニペットとして保存」行アクション (#878)", () => {
  it("onSaveAsSnippet が渡されているとき、行アクションが対象エントリの SQL で呼ばれる", async () => {
    const fullSql = "SELECT id\n  FROM orders\n WHERE status = 'open'";
    const entry = makeHistoryEntry({
      id: 7,
      sql_preview: "SELECT id FROM orders WHERE status = 'open'",
      sql_len: fullSql.length,
    });
    listHistory.mockResolvedValue([entry]);
    getHistorySql.mockResolvedValue(fullSql);
    const onSaveAsSnippet = vi.fn();

    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={() => {}}
        onOpenInNewTab={() => {}}
        onSaveAsSnippet={onSaveAsSnippet}
      />,
    );

    const button = await screen.findByLabelText(t("historySaveAsSnippet"));
    fireEvent.click(button);

    // 全文は行アクションの時点で getHistorySql から取り、要約ではなく全文を渡す。
    await waitFor(() => expect(onSaveAsSnippet).toHaveBeenCalledTimes(1));
    expect(getHistorySql).toHaveBeenCalledWith(7);
    expect(onSaveAsSnippet).toHaveBeenCalledWith(fullSql);
  });

  it("行のクリック (復元) は全文を getHistorySql で取って onRestore に渡す", async () => {
    const fullSql = "SELECT *\n  FROM users";
    const entry = makeHistoryEntry({ id: 3 });
    listHistory.mockResolvedValue([entry]);
    getHistorySql.mockResolvedValue(fullSql);
    const onRestore = vi.fn();

    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={onRestore}
        onOpenInNewTab={() => {}}
      />,
    );

    fireEvent.click(await screen.findByText(entry.sql_preview));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(fullSql));
    expect(getHistorySql).toHaveBeenCalledWith(3);
  });

  it("一覧の表示は取得済みの sql_preview をそのまま使い、全文を取りに行かない", async () => {
    listHistory.mockResolvedValue([makeHistoryEntry()]);
    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={() => {}}
        onOpenInNewTab={() => {}}
      />,
    );
    await screen.findByText("SELECT * FROM users");
    expect(getHistorySql).not.toHaveBeenCalled();
  });

  it("行のクリック (復元) をトリガーせず、onRestore を呼ばない", async () => {
    const entry = makeHistoryEntry();
    listHistory.mockResolvedValue([entry]);
    getHistorySql.mockResolvedValue("SELECT * FROM users");
    const onRestore = vi.fn();
    const onSaveAsSnippet = vi.fn();

    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={onRestore}
        onOpenInNewTab={() => {}}
        onSaveAsSnippet={onSaveAsSnippet}
      />,
    );

    const button = await screen.findByLabelText(t("historySaveAsSnippet"));
    fireEvent.click(button);

    await waitFor(() => expect(onSaveAsSnippet).toHaveBeenCalledTimes(1));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("onSaveAsSnippet を渡さないとき、行アクションは表示されない (既存呼び出し元との後方互換)", async () => {
    const entry = makeHistoryEntry();
    listHistory.mockResolvedValue([entry]);

    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={() => {}}
        onOpenInNewTab={() => {}}
      />,
    );

    await screen.findByText(entry.sql_preview);
    expect(screen.queryByLabelText(t("historySaveAsSnippet"))).not.toBeInTheDocument();
  });
});

describe("HistoryList の AI 検索入口 (#699)", () => {
  const renderList = () =>
    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
        sessionId={null}
        reloadKey={0}
        onRestore={() => {}}
        onOpenInNewTab={() => {}}
      />,
    );

  it("AI 無効 / キー未設定のときはトグルを出さず、従来の検索 UI のまま", async () => {
    setAiKeyPresent(false);
    replaceAllSettings({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: false } });
    renderList();
    await waitFor(() => expect(listHistory).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: t("aiHistoryToggle") })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(t("historySearchPlaceholder"))).toBeInTheDocument();
  });

  it("AI 有効ならトグルで AI 検索パネルを開閉でき、LIKE 検索欄は残る", async () => {
    setAiKeyPresent(true);
    replaceAllSettings({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true },
    });
    renderList();
    const toggle = await screen.findByRole("button", { name: t("aiHistoryToggle") });
    expect(screen.queryByTestId("ai-history-search")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByTestId("ai-history-search")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(t("historySearchPlaceholder"))).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("ai-history-search")).not.toBeInTheDocument();
  });
});
