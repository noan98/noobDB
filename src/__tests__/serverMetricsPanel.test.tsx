import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
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
import { api } from "../api/tauri";

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

/**
 * ポーリング失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく
 * compact な共有 `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで
 * `api.serverMetrics` が再度呼ばれることを固定する。
 */
describe("ServerMetricsPanel error state (#848)", () => {
  it("shows the shared EmptyState title on poll failure, and retries on click", async () => {
    vi.mocked(api.serverMetrics).mockRejectedValueOnce(new Error("query timed out"));

    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);

    await waitFor(() => {
      expect(
        screen.getByText(t("metricsLoadError", { error: "Error: query timed out" })),
      ).toBeInTheDocument();
    });
    expect(api.serverMetrics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("metricsRetry") }));

    await waitFor(() => {
      expect(api.serverMetrics).toHaveBeenCalledTimes(2);
    });
  });
});

/** セッション切替直後でも、旧セッションの遅延応答を捨てて新セッションを即取得する。 */
describe("ServerMetricsPanel session switch", () => {
  it("fetches for the new session even while the old fetch is pending, and drops the stale reply", async () => {
    let resolveOld: (m: ServerMetrics) => void = () => {};
    const empty: ServerMetrics = {
      connections: null,
      active: null,
      idle_in_transaction: null,
      lock_waiting: null,
      questions: null,
      slow_queries: null,
      lock_waits: null,
    };
    vi.mocked(api.serverMetrics)
      .mockImplementationOnce(() => new Promise<ServerMetrics>((r) => { resolveOld = r; }))
      .mockResolvedValue(empty);

    const { rerender } = renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    expect(api.serverMetrics).toHaveBeenCalledTimes(1);

    rerender(<ServerMetricsPanel sessionId="s2" driver="postgres" />);
    await waitFor(() => {
      expect(api.serverMetrics).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(api.serverMetrics).mock.calls[1][0]).toBe("s2");

    // 旧セッションの応答が後から届いても例外なく無視される。
    resolveOld({ ...empty, connections: 99 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("99")).not.toBeInTheDocument();
  });
});

describe("ServerMetricsPanel 更新時刻のリセット (#1594)", () => {
  it("セッション切替後に新接続の取得が失敗しても、旧接続の更新時刻を表示し続けない", async () => {
    const empty: ServerMetrics = {
      connections: null,
      active: null,
      idle_in_transaction: null,
      lock_waiting: null,
      questions: null,
      slow_queries: null,
      lock_waits: null,
    };
    vi.mocked(api.serverMetrics).mockResolvedValueOnce(empty).mockRejectedValue(new Error("boom"));
    const { rerender } = renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    await waitFor(() => expect(screen.getByText(/^(更新|Updated)/)).toBeInTheDocument());

    rerender(<ServerMetricsPanel sessionId="s2" driver="postgres" />);
    await waitFor(() => expect(api.serverMetrics).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/^(更新|Updated)/)).not.toBeInTheDocument();
  });
});
