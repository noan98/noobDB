import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * ER 図 (#560) の失敗表示統一 (#848)。グラフ取得失敗時、裸の赤テキストではなく
 * 共有 `EmptyState` (タイトル + 再取得ボタン) で図の描画領域全体を置き換え、
 * ボタンで再取得できることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      schemaOverview: vi.fn(),
      foreignKeys: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ERDiagramView } from "../components/ERDiagramView";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ERDiagramView error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.schemaOverview).mockRejectedValueOnce(new Error("no such table"));

    renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(t("erDiagramError", { error: "Error: no such table" })),
      ).toBeInTheDocument();
    });
    expect(api.schemaOverview).toHaveBeenCalledTimes(1);

    vi.mocked(api.schemaOverview).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: t("erDiagramRetry") }));

    await waitFor(() => {
      expect(api.schemaOverview).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(t("erDiagramEmpty"))).toBeInTheDocument();
    });
  });
});
