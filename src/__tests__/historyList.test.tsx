import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * クエリ履歴パネル (#604)。マウント時に `api.listHistory()` を呼ぶためモックする。
 * 履歴 0 件で空状態が例外なくマウントされること、検索欄が可視であることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listHistory: vi.fn().mockResolvedValue([]),
    },
  };
});

import { HistoryList } from "../components/HistoryList";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HistoryList render smoke (#604)", () => {
  it("mounts with a search box and shows the empty state when there is no history", async () => {
    renderWithProviders(
      <HistoryList
        activeProfile={makeProfile()}
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
