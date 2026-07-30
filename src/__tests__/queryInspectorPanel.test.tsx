import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { QueryStatsSupport } from "../api/tauri";

/**
 * ライブクエリ・インスペクタ (#746) の空状態統一 (#847)。記録開始前 (idle) は
 * 共有 `EmptyState` の「記録開始待ち」タイトルが、ライブテール/ステートメント
 * 統計の双方のタブで表示されることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      queryStatsSupport: vi.fn().mockResolvedValue({
        live_tail: true,
        statements: true,
        live_tail_reason: null,
        statements_reason: null,
      } satisfies QueryStatsSupport),
      sampleLiveQueries: vi.fn().mockResolvedValue([]),
      sampleStatementStats: vi.fn().mockResolvedValue([]),
    },
  };
});

import { QueryInspectorPanel } from "../components/QueryInspectorPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QueryInspectorPanel empty state (#847)", () => {
  it("shows the shared EmptyState idle title on the live-tail tab before recording starts", async () => {
    renderWithProviders(
      <QueryInspectorPanel sessionId="s1" driver="mysql" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("inspectorTailIdle"))).toBeInTheDocument();
    });
  });

  it("shows the shared EmptyState idle title on the statement-stats tab before recording starts", async () => {
    renderWithProviders(
      <QueryInspectorPanel sessionId="s1" driver="mysql" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("inspectorTailIdle"))).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(t("inspectorTabStats")));
    await waitFor(() => {
      expect(screen.getByText(t("inspectorStatsIdle"))).toBeInTheDocument();
    });
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。前提可否プローブの失敗は
 * パネル全体を置き換えるリッチな共有 `EmptyState` で、記録中のポーリング失敗は
 * compact な共有 `EmptyState` で表示され、どちらも再取得ボタンで復旧できることを
 * 固定する。
 */
describe("QueryInspectorPanel error state (#848)", () => {
  it("shows the shared EmptyState title when the support probe fails, and retries on click", async () => {
    vi.mocked(api.queryStatsSupport).mockRejectedValueOnce(new Error("connection refused"));

    renderWithProviders(
      <QueryInspectorPanel sessionId="s1" driver="mysql" onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(t("inspectorLoadError", { error: "Error: connection refused" })),
      ).toBeInTheDocument();
    });
    expect(api.queryStatsSupport).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("inspectorRetry") }));

    await waitFor(() => {
      expect(api.queryStatsSupport).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(t("inspectorStart"))).toBeInTheDocument();
    });
  });

  it("shows a compact shared EmptyState title on a polling failure while recording, and retries on click", async () => {
    vi.mocked(api.sampleLiveQueries).mockRejectedValueOnce(new Error("lost connection"));

    renderWithProviders(
      <QueryInspectorPanel sessionId="s1" driver="mysql" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("inspectorStart"))).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(t("inspectorStart")));

    await waitFor(() => {
      expect(
        screen.getByText(t("inspectorLoadError", { error: "Error: lost connection" })),
      ).toBeInTheDocument();
    });
    expect(api.sampleLiveQueries).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("inspectorRetry") }));

    await waitFor(() => {
      expect(api.sampleLiveQueries).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.queryByText(t("inspectorLoadError", { error: "Error: lost connection" })),
      ).not.toBeInTheDocument();
    });
  });
});
