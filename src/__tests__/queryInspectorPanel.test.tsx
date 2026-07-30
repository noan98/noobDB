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
    },
  };
});

import { QueryInspectorPanel } from "../components/QueryInspectorPanel";

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
