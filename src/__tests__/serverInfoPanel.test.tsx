import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ServerInfo } from "../api/tauri";

/**
 * サーバ情報パネル (#563) の空状態統一 (#847)。検索フィルタで 0 件になった
 * ケースは、共有 `EmptyState` (compact, icon="search") のタイトルが表示される
 * ことを固定する。`ProcessListPanel` のテストと同じ実 Tauri なしモック方式。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      serverInfo: vi.fn().mockResolvedValue({
        version: "8.0.0",
        variables: [{ name: "max_connections", value: "150" }],
      } satisfies ServerInfo),
    },
  };
});

import { ServerInfoPanel } from "../components/ServerInfoPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ServerInfoPanel render smoke", () => {
  it("mounts and shows fetched variables", async () => {
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("max_connections")).toBeInTheDocument();
    });
  });
});

describe("ServerInfoPanel empty state (#847)", () => {
  it("shows the shared EmptyState title when the search filter matches nothing", async () => {
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("max_connections")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(t("serverInfoSearch")), {
      target: { value: "no-such-variable" },
    });

    await waitFor(() => {
      expect(screen.getByText(t("serverInfoEmpty"))).toBeInTheDocument();
    });
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく共有
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.serverInfo`
 * が再度呼ばれることを固定する。
 */
describe("ServerInfoPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.serverInfo).mockRejectedValueOnce(new Error("access denied"));

    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(t("serverInfoLoadError", { error: "Error: access denied" })),
      ).toBeInTheDocument();
    });
    expect(api.serverInfo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("serverInfoRetry") }));

    await waitFor(() => {
      expect(api.serverInfo).toHaveBeenCalledTimes(2);
    });
  });
});
