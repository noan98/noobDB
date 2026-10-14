import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ProcessInfo } from "../api/tauri";

/**
 * プロセス監視パネル (#604)。マウント時に `api.listProcesses()` を呼び (以降ポーリング)、
 * モックして実 Tauri なしでレンダリングできるようにする。
 *
 * #1112 でこのパネルはボトムパネルの中身になり、見出しと閉じるボタンはシェル
 * (`BottomPanel`) 側へ移した。ここで固定するのは「中身が実際に描画に入ること」
 * (= ツールバーの更新ボタンが出ること) までで、タイトル/閉じるの検証は
 * `bottomPanelShell.test.tsx` が持つ。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProcesses: vi.fn().mockResolvedValue([]),
      killProcesses: vi.fn(),
      getProcessQuery: vi.fn(),
    },
  };
});

import { ProcessListPanel } from "../components/ProcessListPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProcessListPanel render smoke (#604)", () => {
  it("mounts and renders its toolbar", async () => {
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("processRefresh") })).toBeInTheDocument(),
    );
  });
});

/**
 * 空状態の共有 EmptyState 化 (#847)。アクティブなプロセス/接続が 1 件もない
 * 場合、素のグレーテキストではなく共有 `EmptyState` (アイコン + タイトル) で
 * 表示されることを固定する。
 */
describe("ProcessListPanel empty state (#847)", () => {
  it("shows the shared EmptyState (with its title) when there are no processes", async () => {
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    await waitFor(() => {
      expect(screen.getByText(t("processEmpty"))).toBeInTheDocument();
    });
  });
});

/**
 * 初回ロード中のスケルトン行表示 (#846)。中央スピナーではなく行スケルトンで
 * 表構造を予兆表示し、データ到着後は実データ行へ差し替わることを確認する。
 */
describe("ProcessListPanel loading skeleton (#846)", () => {
  it("shows aria-hidden skeleton rows while the initial fetch is pending, then swaps in real rows", async () => {
    let resolveList: (value: ProcessInfo[]) => void = () => {};
    const pending = new Promise<ProcessInfo[]>((resolve) => {
      resolveList = resolve;
    });
    vi.mocked(api.listProcesses).mockReturnValueOnce(pending);

    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />,
    );

    await waitFor(() => {
      const rows = container.querySelectorAll("tbody > tr");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row.getAttribute("aria-hidden")).toBe("true"));
    });

    resolveList([
      {
        id: 42,
        user: "root",
        host: "localhost",
        database: "test",
        command: "Query",
        state: "executing",
        time_secs: 1,
        query_summary: "SELECT 1",
        query_truncated: false,
        is_self: false,
        blocked_by: [],
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
    const rows = container.querySelectorAll("tbody > tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("aria-hidden")).toBeNull();
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく共有
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.listProcesses`
 * が再度呼ばれることを固定する。
 */
describe("ProcessListPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.listProcesses).mockRejectedValueOnce(new Error("connection lost"));

    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);

    await waitFor(() => {
      expect(
        screen.getByText(t("processLoadError", { error: "Error: connection lost" })),
      ).toBeInTheDocument();
    });
    expect(api.listProcesses).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("processRetry") }));

    await waitFor(() => {
      expect(api.listProcesses).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * ライブ監視のモーション (#1022)。ポーリングで値が変わったセルだけが
 * フラッシュし (`data-live-flash`)、経過時間の単調増加は光らないこと、
 * 消えたプロセスの行が (exit 後に) 取り除かれること、接続数が表示されることを
 * 固定する。
 */
describe("ProcessListPanel live motion (#1022)", () => {
  const base: ProcessInfo = {
    id: 7,
    user: "app",
    host: "localhost",
    database: "db",
    command: "Query",
    state: "executing",
    time_secs: 10,
    query_summary: "SELECT 1",
    query_truncated: false,
    is_self: false,
    blocked_by: [],
  };

  it("変化したセルだけをフラッシュし、消えた行は取り除く", async () => {
    vi.mocked(api.listProcesses)
      .mockResolvedValueOnce([base, { ...base, id: 8 }])
      .mockResolvedValueOnce([{ ...base, state: "Sending data", time_secs: 15 }]);

    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />,
    );
    await waitFor(() => expect(screen.getByText("8")).toBeInTheDocument());
    // 初期表示では何も光らない。
    expect(container.querySelectorAll("[data-live-flash]")).toHaveLength(0);
    expect(screen.getByTestId("process-count").textContent).toContain("2");

    fireEvent.click(screen.getByRole("button", { name: t("processRefresh") }));

    await waitFor(() => expect(screen.getByText("Sending data")).toBeInTheDocument());
    const flashed = [...container.querySelectorAll("[data-live-flash]")];
    expect(flashed.map((el) => el.textContent)).toEqual(["Sending data"]);

    await waitFor(() => expect(screen.queryByText("8")).not.toBeInTheDocument());
    await waitFor(() => expect(container.querySelectorAll("tbody > tr")).toHaveLength(1));
  });
});

/**
 * 一括 kill (#1259): 選択した id を `killProcesses` 1 回で送り、結果の件数・最初のエラーを
 * 従来どおりの toast 文言にする。クエリ全文はツールチップ表示時だけ id 指定で取得する。
 */
describe("ProcessListPanel bulk kill & lazy query (#1259)", () => {
  const base: ProcessInfo = {
    id: 7,
    user: "app",
    host: "localhost",
    database: "db",
    command: "Query",
    state: "executing",
    time_secs: 10,
    query_summary: "SELECT …",
    query_truncated: true,
    is_self: false,
    blocked_by: [],
  };

  it("選択した id を killProcesses 1 回で送り、失敗件数と最初のエラーを toast に出す", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base, { ...base, id: 8 }]);
    vi.mocked(api.killProcesses).mockResolvedValue({ killed: 1, failed: 1, first_error: "denied" });
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />);
    await waitFor(() => expect(screen.getByText("8")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(t("processSelectAll")));
    fireEvent.click(screen.getByRole("button", { name: t("processKillSelected", { count: 2 }) }));
    fireEvent.click(await screen.findByRole("button", { name: t("processKillConfirmOk") }));

    await waitFor(() => expect(api.killProcesses).toHaveBeenCalledWith("s1", [7, 8], false));
    expect(api.killProcesses).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByText(t("processKillFailed", { failed: 1, count: 2, error: "denied" })),
      ).toBeInTheDocument(),
    );
  });

  it("全文はセルにポインタが乗ったときだけ id 指定で取得する", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base]);
    vi.mocked(api.getProcessQuery).mockResolvedValue("SELECT * FROM big_table WHERE x = 1");
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    const cell = await screen.findByText("SELECT …");
    expect(api.getProcessQuery).not.toHaveBeenCalled();
    fireEvent.mouseEnter(cell.closest("td") as HTMLElement);
    await waitFor(() => expect(api.getProcessQuery).toHaveBeenCalledWith("s1", 7));
  });
});

/** ロック待ちの連鎖 (#1417): 待機ツリーを描き、根のブロッカーを確認付きで kill する。 */
describe("ProcessListPanel blocking tree (#1417)", () => {
  const base: ProcessInfo = {
    id: 1,
    user: "app",
    host: "localhost",
    database: "db",
    command: "Query",
    state: "idle in transaction",
    time_secs: 10,
    query_summary: "UPDATE t SET a = 1",
    query_truncated: false,
    is_self: false,
    blocked_by: [],
  };

  it("待機が無ければツリーを出さない", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base]);
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />);
    await waitFor(() => expect(screen.getByTestId("process-count")).toBeInTheDocument());
    expect(screen.queryByTestId("blocking-tree")).not.toBeInTheDocument();
  });

  it("根のブロッカーの Kill が確認後に killProcesses へ根の id だけを送る", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      base,
      { ...base, id: 2, blocked_by: [1] },
      { ...base, id: 3, blocked_by: [2] },
    ]);
    vi.mocked(api.killProcesses).mockResolvedValue({ killed: 1, failed: 0, first_error: null });
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />);
    await screen.findByTestId("blocking-tree");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: t("processBlockingKillAria", { id: 1 }) }));
    fireEvent.click(await screen.findByRole("button", { name: t("processKillConfirmOk") }));
    await waitFor(() => expect(api.killProcesses).toHaveBeenCalledWith("s1", [1], false));
  });

  it("read_only ではブロッカーの Kill を無効化する", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base, { ...base, id: 2, blocked_by: [1] }]);
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="postgres" readOnly />);
    await screen.findByTestId("blocking-tree");
    expect(screen.getByRole("button", { name: t("processBlockingKillAria", { id: 1 }) })).toBeDisabled();
  });

  it("一覧外のブロッカーは Kill 不可の根、自アプリ接続はバッジ、循環は別ラベルで出す", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      { ...base, id: 2, blocked_by: [99] },
      { ...base, id: 10, blocked_by: [11], is_self: true },
      { ...base, id: 11, blocked_by: [10] },
    ]);
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />);
    await screen.findByTestId("blocking-tree");
    expect(screen.getByText(t("processBlockingExternal", { id: 99, count: 1 }))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: t("processBlockingKillAria", { id: 99 }) }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(t("processBlockingDeadlock"))).toBeInTheDocument();
    const tree = screen.getByTestId("blocking-tree");
    expect(tree.textContent).toContain(t("processSelfBadge"));
    expect(screen.getByRole("button", { name: t("processBlockingKillAria", { id: 10 }) })).toBeEnabled();
  });
});

/** 絞り込み・並べ替え (#1538) と、文のみ停止 (#1538)。 */
describe("ProcessListPanel filter, sort and statement-only stop (#1538)", () => {
  const base: ProcessInfo = {
    id: 1,
    user: "app",
    host: "localhost",
    database: "db",
    command: "Query",
    state: null,
    time_secs: 10,
    query_summary: "SELECT 1",
    query_truncated: false,
    is_self: false,
    blocked_by: [],
  };

  it("描画上限を超える一覧でも、絞り込みで 501 件目以降のプロセスが見つかる", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      ...base,
      id: i + 1,
      user: i === 500 ? "needle" : "app",
    }));
    vi.mocked(api.listProcesses).mockResolvedValue(many);
    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="postgres" readOnly={false} />,
    );
    await screen.findByTestId("process-truncated", {}, { timeout: 15000 });
    expect(container.querySelector("#process-row-s1-501")).toBeNull();

    fireEvent.change(screen.getByLabelText(t("processFilterUserAria")), {
      target: { value: "needle" },
    });
    await waitFor(() => expect(container.querySelector("#process-row-s1-501")).not.toBeNull(), {
      timeout: 15000,
    });
    expect(screen.queryByTestId("process-truncated")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-filter-count").textContent).toBe(
      t("processFilterCount", { shown: 1, total: 501 }),
    );
    // 500 行の描画は jsdom では重いため、panelRowMemo.test.tsx と同じく個別に猶予を持たせる。
  }, 30000);

  it("一致が無いときは空状態と解除ボタンを出す", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base]);
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    await screen.findByText("SELECT 1");
    fireEvent.change(screen.getByLabelText(t("processFilterTextAria")), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText(t("processFilterNoMatch"))).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: t("processFilterClear") })[0]);
    expect(await screen.findByText("SELECT 1")).toBeInTheDocument();
  });

  it("経過時間の降順に並べ替える", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      { ...base, id: 1, time_secs: 1 },
      { ...base, id: 2, time_secs: 500 },
    ]);
    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />,
    );
    await waitFor(() => expect(container.querySelector("#process-row-s1-2")).not.toBeNull());
    fireEvent.change(screen.getByLabelText(t("processSortAria")), { target: { value: "timeDesc" } });
    await waitFor(() => {
      const first = container.querySelector("tbody > tr");
      expect(first?.id).toBe("process-row-s1-2");
    });
  });

  it("絞り込みで隠れた行の選択は停止対象に含めない", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      { ...base, id: 1, user: "app" },
      { ...base, id: 2, user: "batch" },
    ]);
    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />,
    );
    await waitFor(() => expect(container.querySelector("#process-row-s1-2")).not.toBeNull());
    fireEvent.click(screen.getByLabelText(t("processSelectAll")));
    vi.mocked(api.killProcesses).mockResolvedValue({ killed: 1, failed: 0, first_error: null });
    fireEvent.change(screen.getByLabelText(t("processFilterUserAria")), { target: { value: "app" } });
    fireEvent.click(await screen.findByRole("button", { name: t("processKillSelected", { count: 1 }) }));
    fireEvent.click(await screen.findByRole("button", { name: t("processKillConfirmOk") }));
    // 隠れている id 2 は含めず、見えている id 1 だけを送る。
    await waitFor(() => expect(api.killProcesses).toHaveBeenCalledWith("s1", [1], false));
  });

  it("セッションを切り替えると絞り込みと並べ替えが初期化される", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      { ...base, id: 1, user: "app" },
      { ...base, id: 2, user: "batch" },
    ]);
    const { rerender } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />,
    );
    await screen.findByLabelText(t("processFilterUserAria"));
    fireEvent.change(screen.getByLabelText(t("processFilterUserAria")), { target: { value: "batch" } });
    fireEvent.change(screen.getByLabelText(t("processSortAria")), { target: { value: "timeDesc" } });
    rerender(<ProcessListPanel sessionId="s2" driver="mysql" readOnly={false} />);
    await waitFor(() =>
      expect((screen.getByLabelText(t("processFilterUserAria")) as HTMLSelectElement).value).toBe(""),
    );
    expect((screen.getByLabelText(t("processSortAria")) as HTMLSelectElement).value).toBe("default");
  });

  it("選択中のユーザが一覧から消えても選択肢に残り、表示が空欄にならない", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([
      { ...base, id: 1, user: "app" },
      { ...base, id: 2, user: "batch" },
    ]);
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    const sel = (await screen.findByLabelText(t("processFilterUserAria"))) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "batch" } });
    vi.mocked(api.listProcesses).mockResolvedValue([{ ...base, id: 1, user: "app" }]);
    fireEvent.click(screen.getByRole("button", { name: t("processRefresh") }));
    await waitFor(() => expect(api.listProcesses).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        Array.from((screen.getByLabelText(t("processFilterUserAria")) as HTMLSelectElement).options).some(
          (o) => o.value === "batch",
        ),
      ).toBe(true),
    );
    expect((screen.getByLabelText(t("processFilterUserAria")) as HTMLSelectElement).value).toBe("batch");
  });

  it("「文を停止」は確認後に statementOnly=true で killProcesses を呼ぶ", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base]);
    vi.mocked(api.killProcesses).mockResolvedValue({ killed: 1, failed: 0, first_error: null });
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} />);
    await screen.findByText("SELECT 1");
    fireEvent.click(screen.getByLabelText(t("processSelectAll")));
    fireEvent.click(screen.getByRole("button", { name: t("processCancelSelected", { count: 1 }) }));
    fireEvent.click(await screen.findByRole("button", { name: t("processCancelConfirmOk") }));
    await waitFor(() => expect(api.killProcesses).toHaveBeenCalledWith("s1", [1], true));
    expect(await screen.findByText(t("processCancelDone", { count: 1 }))).toBeInTheDocument();
  });

  it("read_only では「文を停止」も無効", async () => {
    vi.mocked(api.listProcesses).mockResolvedValue([base]);
    renderWithProviders(<ProcessListPanel sessionId="s1" driver="mysql" readOnly />);
    await screen.findByText("SELECT 1");
    expect(screen.getByRole("button", { name: t("processCancelSelected", { count: 0 }) })).toBeDisabled();
  });
});
