import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ServerMetrics } from "../api/tauri";

/**
 * サーバ監視ダッシュボード (#731) の空状態統一 (#847)。系列が 1 つも報告
 * されない (ドライバ非対応 or 初回サンプルのみで差分が取れない) チャートに、
 * 共有 `EmptyState` (compact, icon="chart") のタイトルが表示されることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      serverMetrics: vi.fn().mockResolvedValue({
        connections: null,
        active: null,
        idle_in_transaction: null,
        lock_waiting: null,
        questions: null,
        slow_queries: null,
        lock_waits: null,
      } satisfies ServerMetrics),
    },
  };
});

import { ServerMetricsPanel } from "../components/ServerMetricsPanel";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ServerMetricsPanel empty state (#847)", () => {
  it("shows the shared EmptyState title for charts without series data", async () => {
    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    await waitFor(() => {
      expect(screen.getAllByText(t("metricsNoSeriesData")).length).toBeGreaterThan(0);
    });
  });
});
