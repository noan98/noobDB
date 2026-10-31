import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
  chooseListboxOption,
} from "./testUtils";
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
      .mockImplementationOnce(
        () =>
          new Promise<ServerMetrics>((r) => {
            resolveOld = r;
          }),
      )
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

describe("ServerMetricsPanel 手動の再取得 (#1617)", () => {
  it("再取得ボタンで即時に取り直し、自動更新を ON に戻したときも即時取得する", async () => {
    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    await waitFor(() => expect(api.serverMetrics).toHaveBeenCalledTimes(1));
    // 取得の finally (loading 解除) まで流してから押す。ボタンは取得中も押せる (二重実行は busyRef が防ぐ)。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(screen.getByRole("button", { name: t("metricsRefresh") }));
    await waitFor(() => expect(api.serverMetrics).toHaveBeenCalledTimes(2));

    const auto = screen.getByLabelText(t("autoRefreshAria"));
    // 取得の finally (loading 解除) まで流してから押す。ボタンは取得中も押せる (二重実行は busyRef が防ぐ)。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(auto); // OFF
    expect(api.serverMetrics).toHaveBeenCalledTimes(2);
    fireEvent.click(auto); // ON
    await waitFor(() => expect(api.serverMetrics).toHaveBeenCalledTimes(3));
  });
});

describe("ServerMetricsPanel 期間切替・接続数の余裕 (#1622)", () => {
  it("上限に近い接続数を警告で示し、期間の選択肢を出す", async () => {
    vi.mocked(api.serverMetrics).mockResolvedValue({
      connections: 85,
      active: 1,
      idle_in_transaction: null,
      lock_waiting: null,
      questions: null,
      slow_queries: null,
      lock_waits: null,
      max_connections: 100,
    } satisfies ServerMetrics);
    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    const note = await screen.findByTestId("metrics-connection-headroom");
    expect(note).toHaveTextContent("85");
    expect(note).toHaveTextContent("100");
    const select = screen.getByLabelText(t("metricsWindowAria"));
    fireEvent.click(select);
    const listbox = document.getElementById(select.getAttribute("aria-controls") ?? "");
    expect(
      [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].map((o) => o.dataset.value),
    ).toEqual(["300", "900", "3600"]);
    fireEvent.keyDown(select, { key: "Escape" });
    const callsBefore = vi.mocked(api.serverMetrics).mock.calls.length;
    chooseListboxOption(select, "900");
    expect(select).toHaveTextContent(t("metricsWindowOption", { mins: 15 }));
    // 期間の切替ではバッファを捨てず、取得し直しもしない (表示側で切る)。
    expect(vi.mocked(api.serverMetrics).mock.calls.length).toBe(callsBefore);
  });

  it("上限が不明なら余裕の帯を出さない", async () => {
    vi.mocked(api.serverMetrics).mockResolvedValue({
      connections: 5,
      active: null,
      idle_in_transaction: null,
      lock_waiting: null,
      questions: null,
      slow_queries: null,
      lock_waits: null,
    } satisfies ServerMetrics);
    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    await waitFor(() => expect(api.serverMetrics).toHaveBeenCalled());
    expect(screen.queryByTestId("metrics-connection-headroom")).not.toBeInTheDocument();
  });
});

describe("ServerMetricsPanel 要約タイル (#1833)", () => {
  it("2 回取得すると前回比のデルタと推移 sparkline が要約タイルに出る", async () => {
    const m = (connections: number, lock_waiting: number): ServerMetrics => ({
      connections,
      active: null,
      idle_in_transaction: null,
      lock_waiting,
      questions: null,
      slow_queries: null,
      lock_waits: null,
    });
    vi.mocked(api.serverMetrics).mockResolvedValueOnce(m(5, 1)).mockResolvedValue(m(8, 0));
    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    await waitFor(() => expect(screen.getByTestId("metrics-summary-tiles")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: t("metricsRefresh") }));
    await waitFor(() => expect(screen.getAllByTestId("stat-delta").length).toBe(2));
    const [conn, lock] = screen.getAllByTestId("stat-delta");
    expect(conn).toHaveAttribute("data-direction", "up");
    expect(conn).toHaveAttribute("data-verdict", "none");
    // ロック待ちは減少が良い指標。
    expect(lock).toHaveAttribute("data-direction", "down");
    expect(lock).toHaveAttribute("data-verdict", "good");
    expect(screen.getAllByTestId("neutral-sparkline").length).toBe(2);
  });

  it("リセットでレートが null を挟んだ直後はタイルを出さず、次の回復では前回比を出さない", async () => {
    const m = (questions: number): ServerMetrics => ({
      connections: 5,
      active: null,
      idle_in_transaction: null,
      lock_waiting: null,
      questions,
      slow_queries: null,
      lock_waits: null,
    });
    // 同一ミリ秒だと dtMs=0 でレートが出ないので、時刻を 1 秒ずつ進めて固定する。
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // 100 → 200 (レート 100/s) → 50 (リセット: レート null) → 150 (レート 100/s、直前は null)
    vi.mocked(api.serverMetrics)
      .mockResolvedValueOnce(m(100))
      .mockResolvedValueOnce(m(200))
      .mockResolvedValueOnce(m(50))
      .mockResolvedValue(m(150));
    renderWithProviders(<ServerMetricsPanel sessionId="s1" driver="postgres" />);
    await waitFor(() => expect(screen.getByTestId("metrics-summary-tiles")).toBeInTheDocument());
    const tiles = () => screen.getByTestId("metrics-summary-tiles");
    const refresh = async (calls: number) => {
      now += 1000;
      fireEvent.click(screen.getByRole("button", { name: t("metricsRefresh") }));
      await waitFor(() => expect(api.serverMetrics).toHaveBeenCalledTimes(calls));
    };

    await refresh(2);
    // レートが算出できた時点ではスループットのタイルが出ている (空振り防止)。
    await waitFor(() => expect(tiles().textContent).toContain(t("metricsSeriesThroughput")));

    await refresh(3);
    // リセット直後は最新レートが null なのでタイルごと消え、接続数のタイルだけが残る。
    await waitFor(() => {
      expect(tiles().textContent).not.toContain(t("metricsSeriesThroughput"));
      expect(tiles().textContent).toContain(t("metricsSeriesConnections"));
    });

    await refresh(4);
    // 最新は有限・直前は null: タイルは出るが、離れた点との差(デルタ)は出さない。
    await waitFor(() => expect(tiles().textContent).toContain(t("metricsSeriesThroughput")));
    const throughputTile = within(tiles()).getByText(t("metricsSeriesThroughput"))
      .parentElement as HTMLElement;
    expect(within(throughputTile).queryByTestId("stat-delta")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
