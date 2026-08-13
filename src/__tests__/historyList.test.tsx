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
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listHistory: (...args: unknown[]) => listHistory(...args),
    },
  };
});

import { HistoryList } from "../components/HistoryList";

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 1,
    profile_id: "p-test",
    driver: "mysql",
    database: "appdb",
    sql: "SELECT * FROM users",
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
    const entry = makeHistoryEntry({ sql: "SELECT id FROM orders WHERE status = 'open'" });
    listHistory.mockResolvedValue([entry]);
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

    expect(onSaveAsSnippet).toHaveBeenCalledTimes(1);
    expect(onSaveAsSnippet).toHaveBeenCalledWith(entry.sql);
  });

  it("行のクリック (復元) をトリガーせず、onRestore を呼ばない", async () => {
    const entry = makeHistoryEntry();
    listHistory.mockResolvedValue([entry]);
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

    expect(onSaveAsSnippet).toHaveBeenCalledTimes(1);
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

    await screen.findByText(entry.sql);
    expect(screen.queryByLabelText(t("historySaveAsSnippet"))).not.toBeInTheDocument();
  });
});
