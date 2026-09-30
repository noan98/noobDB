import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { QueryStatsSupport, StatementDeltaRow } from "../api/tauri";

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
      startStatementRecording: vi.fn().mockResolvedValue(undefined),
      sampleStatementDelta: vi.fn().mockResolvedValue([]),
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
      <QueryInspectorPanel sessionId="s1" driver="mysql" />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("inspectorTailIdle"))).toBeInTheDocument();
    });
  });

  it("shows the shared EmptyState idle title on the statement-stats tab before recording starts", async () => {
    renderWithProviders(
      <QueryInspectorPanel sessionId="s1" driver="mysql" />,
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
      <QueryInspectorPanel sessionId="s1" driver="mysql" />,
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
      <QueryInspectorPanel sessionId="s1" driver="mysql" />,
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

/**
 * 前提可否プローブの初回応答待ちを bare Spinner から共通スケルトンへ揃える (#1174)。
 * `queryStatsSupport` が返るまでの間はツールバー/タブの骨格が出て、確定表示
 * (記録開始ボタンや空状態) を誤って出さないことを固定する。
 */
describe("QueryInspectorPanel initial support probe skeleton (#1174)", () => {
  it("shows a skeleton (role=status) while the support probe is pending, then the toolbar once resolved", async () => {
    let resolveSupport: (s: QueryStatsSupport) => void = () => {};
    const pending = new Promise<QueryStatsSupport>((resolve) => {
      resolveSupport = resolve;
    });
    vi.mocked(api.queryStatsSupport).mockReturnValueOnce(pending);

    renderWithProviders(<QueryInspectorPanel sessionId="s1" driver="mysql" />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(t("inspectorSupportLoading"));
    expect(screen.queryByText(t("inspectorStart"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("inspectorTailIdle"))).not.toBeInTheDocument();

    resolveSupport({
      live_tail: true,
      statements: true,
      live_tail_reason: null,
      statements_reason: null,
    });

    await waitFor(() => {
      expect(screen.getByText(t("inspectorStart"))).toBeInTheDocument();
    });
    expect(screen.queryByText(t("inspectorSupportLoading"))).not.toBeInTheDocument();
  });
});

/**
 * 差分集計のバックエンド移管 (#1259)。記録開始で `startStatementRecording` を呼び、
 * ティックごとに `sampleStatementDelta` の差分行を表示する。SQL 本文は digest の初出時
 * だけ届くので、2 回目以降 (fingerprint: null) も初回の本文を保って表示する。累積表示の
 * 切替はサーバへ取り直さず (`refresh: false`) 再計算だけを依頼する。
 */
describe("QueryInspectorPanel backend delta (#1259)", () => {
  const row = (over: Partial<StatementDeltaRow> = {}): StatementDeltaRow => ({
    digest: "d1",
    fingerprint: "select * from orders where id = ?",
    database: "shop",
    calls: 4,
    total_time_ms: 40,
    mean_time_ms: 10,
    max_time_ms: 15,
    rows: 8,
    n_plus_one: false,
    ...over,
  });

  it("本文は初出時だけ受け取り、以降の差分行にも表示し続ける", async () => {
    vi.mocked(api.sampleLiveQueries).mockResolvedValue([]);
    vi.mocked(api.sampleStatementDelta)
      .mockResolvedValueOnce([row()])
      .mockResolvedValue([row({ fingerprint: null, calls: 9, n_plus_one: true })]);

    renderWithProviders(<QueryInspectorPanel sessionId="s1" driver="mysql" />);
    await waitFor(() => expect(screen.getByText(t("inspectorStart"))).toBeInTheDocument());
    fireEvent.click(screen.getByText(t("inspectorTabStats")));
    fireEvent.click(screen.getByText(t("inspectorStart")));

    await waitFor(() => expect(api.startStatementRecording).toHaveBeenCalledWith("s1"));
    await waitFor(() =>
      expect(screen.getByText("select * from orders where id = ?")).toBeInTheDocument(),
    );
    expect(api.sampleStatementDelta).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ cumulative: false, refresh: true }),
    );

    // 累積表示の切替: refresh なしで再計算を依頼し、本文 (null で届く) はキャッシュから出る。
    fireEvent.click(screen.getByLabelText(t("inspectorCumulativeLabel")));
    await waitFor(() =>
      expect(api.sampleStatementDelta).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ cumulative: true, refresh: false }),
      ),
    );
    await waitFor(() => expect(screen.getByText("9")).toBeInTheDocument());
    expect(screen.getByText("select * from orders where id = ?")).toBeInTheDocument();
    expect(screen.getByText("N+1")).toBeInTheDocument();
  });
});
