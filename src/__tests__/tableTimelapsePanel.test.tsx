import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, chooseListboxOption } from "./testUtils";
import { t } from "../i18n";
import type { TableWatch, TimelapseGenerationDiff } from "../api/tauri";

/**
 * テーブル・タイムラプス (#739) のボトムパネル。保存済み世代の既定ペア
 * (1 つ前 → 最新) の差分が行/セル単位で描かれること、ツリーからのウォッチ登録要求で
 * 制約とプライバシーを示す確認ダイアログが出て、行数上限超過時は同意が無ければ
 * 登録しないことを固定する。
 */
const reducedRef = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("motion/react")>();
  return { ...mod, useReducedMotionConfig: () => reducedRef.value };
});
// 再生の待ち時間はテストでは極小にする。
vi.mock("../timelapsePlayback", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../timelapsePlayback")>();
  return { ...mod, PLAYBACK_DWELL_MS: 5 };
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      timelapseListWatches: vi.fn(),
      timelapseDiffGenerations: vi.fn(),
      timelapseWatchTable: vi.fn(),
      timelapseCapture: vi.fn(),
      timelapseUnwatch: vi.fn(),
      timelapseRowHistory: vi.fn(),
    },
  };
});

import { TableTimelapsePanel } from "../components/TableTimelapsePanel";
import { api } from "../api/tauri";

function watch(): TableWatch {
  return {
    id: 7,
    profile_id: "p1",
    driver: "mysql",
    database: "app",
    table: "fees",
    active: true,
    partial: false,
    created_at: "2026-01-01T00:00:00Z",
    generations: [
      { id: 12, captured_at: "2026-01-02T00:00:00Z", row_count: 2, truncated: false, bytes: 40 },
      { id: 11, captured_at: "2026-01-01T00:00:00Z", row_count: 2, truncated: false, bytes: 40 },
    ],
  };
}

function genDiff(): TimelapseGenerationDiff {
  return {
    diff: {
      target_driver: "mysql",
      table: "fees",
      columns: ["id", "price"],
      column_types: ["int", "int"],
      primary_key: ["id"],
      key_kind: "primary_key",
      rows: [
        { status: "different", key: [1], source: [1, 150], target: [1, 100], changed_columns: ["price"] },
        { status: "source_only", key: [3], source: [3, 300], target: null, changed_columns: [] },
      ],
      truncated: false,
      source_count: 2,
      target_count: 2,
    },
    key_changed: false,
    columns_added: [],
    columns_removed: [],
    partial: false,
    from_captured_at: "2026-01-01T00:00:00Z",
    to_captured_at: "2026-01-02T00:00:00Z",
  };
}

/** 件数チップ。数値部分は CountUp (表示用 + 読み上げ用) に分かれるので、完全一致で探す。 */
function chip(key: "timelapseCountAdded" | "timelapseCountChanged" | "timelapseCountRemoved", count: number) {
  return screen.getByText(chipMatcher(key, count));
}
function chipQuery(
  key: "timelapseCountAdded" | "timelapseCountChanged" | "timelapseCountRemoved",
  count: number,
) {
  return screen.queryByText(chipMatcher(key, count));
}
function chipMatcher(key: string, count: number) {
  const label = t(key as "timelapseCountAdded", { count });
  // 表示用 + 読み上げ用の 2 つの数値が続くので「ラベル (数値込み) + 読み上げ用の数値」と完全一致させる (1 と 11 を区別)。
  const full = `${label}${count}`;
  return (_: string, el: Element | null) => el?.tagName === "SPAN" && el.textContent === full;
}

function renderPanel(watchRequest: { database: string; table: string; seq: number } | null = null) {
  return renderWithProviders(
    <TableTimelapsePanel
      sessionId="s1"
      profileId="p1"
      maxGenerations={20}
      watchRequest={watchRequest}
      onRequestConsumed={() => {}}
      refreshKey={0}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TableTimelapsePanel (#739)", () => {
  it("既定で「1 つ前 → 最新」の差分を行・セル単位で表示する", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([watch()]);
    vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
    renderPanel();

    await waitFor(() => expect(api.timelapseDiffGenerations).toHaveBeenCalledWith(11, 12));
    await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
    // 変更前の値も併記し、変更セルに印が付く。
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("150").closest("td")).toHaveAttribute("data-changed", "true");
    expect(chip("timelapseCountAdded", 1)).toBeInTheDocument();
    expect(chip("timelapseCountChanged", 1)).toBeInTheDocument();
    expect(screen.getByText("300").closest("tr")).toHaveAttribute("data-kind", "added");
  });

  it("再現用 DML ボタンでプレビューを開き、既定は巻き戻し SQL (実行はしない) (#1624)", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([watch()]);
    vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: t("timelapseDmlButton") }));
    const preview = await screen.findByLabelText(t("timelapseDmlPreviewAria"));
    expect(preview.textContent).toContain("UPDATE `app`.`fees` SET `price` = 100 WHERE `id` = 1;");
    expect(preview.textContent).toContain("DELETE FROM `app`.`fees` WHERE `id` = 3;");
    chooseListboxOption(screen.getByLabelText(t("timelapseDmlDirection")), "forward");
    expect(preview.textContent).toContain("INSERT INTO `app`.`fees` (`id`, `price`) VALUES (3, 300);");
  });

  it("rowid 追跡の差分では DML ボタンを無効にして理由を出し、rowid の注記を出す (#1838)", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([watch()]);
    const d = genDiff();
    d.diff.key_kind = "rowid";
    d.diff.primary_key = ["rowid"];
    vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(d);
    renderPanel();
    const button = await screen.findByRole("button", { name: t("timelapseDmlButton") });
    expect(button).toBeDisabled();
    expect(screen.getAllByText(t("timelapseDmlRowidBlocked")).length).toBeGreaterThan(0);
    expect(screen.getByText(t("rowKeyRowid", { columns: "rowid" }))).toBeInTheDocument();
  });

  it("2 世代でキーが違う (key_changed) と注記を出す (#1838)", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([watch()]);
    const d = genDiff();
    d.key_changed = true;
    vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(d);
    renderPanel();
    expect(await screen.findByText(t("timelapseKeyChanged"))).toBeInTheDocument();
  });

  it("差分行の履歴ボタンで、その行の世代横断の推移を表示する (#1621)", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([watch()]);
    vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
    vi.mocked(api.timelapseRowHistory).mockResolvedValue({
      columns: ["id", "price"],
      primary_key: ["id"],
      key_kind: "primary_key",
      entries: [
        {
          generation_id: 10,
          captured_at: "2025-12-01T00:00:00Z",
          present: true,
          row: [1, 90],
          changed_columns: [],
        },
        {
          generation_id: 11,
          captured_at: "2026-01-01T00:00:00Z",
          present: true,
          row: [1, 100],
          changed_columns: ["price"],
        },
        {
          generation_id: 12,
          captured_at: "2026-01-02T00:00:00Z",
          present: false,
          row: null,
          changed_columns: [],
        },
      ],
      generations_scanned: 5,
      partial: false,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: t("timelapseRowHistoryOpen", { key: "[1]" }) }));
    await waitFor(() => expect(api.timelapseRowHistory).toHaveBeenCalledWith(7, [1]));
    const section = await screen.findByTestId("timelapse-row-history");
    expect(section).toHaveTextContent(t("timelapseRowHistorySummary", { changes: 3, count: 5 }));
    expect(section).toHaveTextContent("90");
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(section.querySelector("td[data-changed]")).toHaveTextContent("100");
    expect(section).toHaveTextContent(t("timelapseRowHistoryGone"));
  });

  it("ウォッチが無ければ制約を説明する空状態を出す", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText(t("timelapseEmptyTitle"))).toBeInTheDocument());
    expect(api.timelapseDiffGenerations).not.toHaveBeenCalled();
  });

  it("登録要求で確認を出し、行数上限超過で同意しなければ登録しない", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([]);
    vi.mocked(api.timelapseWatchTable).mockResolvedValue({
      watch_id: null,
      over_limit: true,
      row_limit: 5000,
      generation_added: false,
    });
    renderPanel({ database: "app", table: "big", seq: 1 });

    // 1 つ目の確認: 行数上限・PK 必須・ローカルコピーであることを明示する。
    await waitFor(() => expect(screen.getByText(t("timelapseWatchPk"))).toBeInTheDocument());
    expect(screen.getByText(t("timelapseWatchPrivacy"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("timelapseWatchConfirmOk") }));

    await waitFor(() =>
      expect(api.timelapseWatchTable).toHaveBeenCalledWith(
        expect.objectContaining({ database: "app", table: "big", allowPartial: false }),
      ),
    );
    // 2 つ目の確認 (先頭 N 行だけを記録するか) をキャンセル → 再登録しない。
    await waitFor(() =>
      expect(screen.getByText(t("timelapseOverLimitMessage", { limit: 5000 }))).toBeInTheDocument(),
    );
    // 1 つ目のダイアログが退出アニメ中で DOM に残ることがあるので、最後 (最新) の
    // ダイアログのキャンセルを押す。
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() =>
      expect(screen.getByText(t("timelapseWatchDeclined", { limit: 5000 }))).toBeInTheDocument(),
    );
    expect(api.timelapseWatchTable).toHaveBeenCalledTimes(1);
  });

  /**
   * 初回ロード中の bare Spinner を廃止し、共通スケルトンへ揃える (#1174)。
   * ウォッチ一覧の取得中は左ペインのリスト骨格が出て、「ウォッチ無し」の
   * 空状態 (実データ 0 件の確定表示) を誤って出さないことを固定する。
   */
  it("ウォッチ一覧の取得中はリストのスケルトンを出し、空状態は出さない", async () => {
    let resolveWatches: (list: TableWatch[]) => void = () => {};
    const pending = new Promise<TableWatch[]>((resolve) => {
      resolveWatches = resolve;
    });
    vi.mocked(api.timelapseListWatches).mockReturnValueOnce(pending);

    renderPanel();

    expect(await screen.findByText(t("timelapseLoading"))).toBeInTheDocument();
    expect(screen.queryByText(t("timelapseEmptyTitle"))).not.toBeInTheDocument();

    resolveWatches([]);
    await waitFor(() => expect(screen.getByText(t("timelapseEmptyTitle"))).toBeInTheDocument());
  });

  /**
   * 差分計算中も同様に bare Spinner を廃止し、列数未知の表スケルトンへ揃える (#1174)。
   */
  it("差分計算中は表のスケルトンを出し、差分結果は出さない", async () => {
    vi.mocked(api.timelapseListWatches).mockResolvedValue([watch()]);
    let resolveDiff: (d: TimelapseGenerationDiff) => void = () => {};
    const pending = new Promise<TimelapseGenerationDiff>((resolve) => {
      resolveDiff = resolve;
    });
    vi.mocked(api.timelapseDiffGenerations).mockReturnValueOnce(pending);

    renderPanel();

    expect(await screen.findByText(t("timelapseDiffLoading"))).toBeInTheDocument();
    expect(chipQuery("timelapseCountAdded", 1)).not.toBeInTheDocument();

    resolveDiff(genDiff());
    await waitFor(() => expect(chip("timelapseCountAdded", 1)).toBeInTheDocument());
  });

  /** ペアを変えたら、取得が終わるまで直前のペアの差分を新しい結果として見せない (#1534)。 */
  it("世代ペアを変えると、取得完了まで直前の差分を破棄してスケルトンを出す", async () => {
    const w = watch();
    w.generations = [
      { id: 13, captured_at: "2026-01-03T00:00:00Z", row_count: 2, truncated: false, bytes: 40 },
      ...w.generations,
    ];
    vi.mocked(api.timelapseListWatches).mockResolvedValue([w]);
    vi.mocked(api.timelapseDiffGenerations).mockResolvedValueOnce(genDiff());
    renderPanel();
    await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());

    let resolveDiff: (d: TimelapseGenerationDiff) => void = () => {};
    vi.mocked(api.timelapseDiffGenerations).mockReturnValueOnce(
      new Promise<TimelapseGenerationDiff>((resolve) => {
        resolveDiff = resolve;
      }),
    );
    chooseListboxOption(screen.getByLabelText(t("timelapseFrom")), "11");

    expect(await screen.findByText(t("timelapseDiffLoading"))).toBeInTheDocument();
    expect(screen.queryByText("150")).not.toBeInTheDocument();
    resolveDiff(genDiff());
    await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
  });

  /** 3 世代 (id 11,12,13) → 2 段のタイムライン (#2015)。 */
  function threeGenWatch(): TableWatch {
    const w = watch();
    w.generations = [
      { id: 13, captured_at: "2026-01-03T00:00:00Z", row_count: 2, truncated: false, bytes: 40 },
      ...w.generations,
    ];
    return w;
  }
  function diffWithPrice(price: number): TimelapseGenerationDiff {
    const d = genDiff();
    d.diff.rows[0] = {
      status: "different",
      key: [1],
      source: [1, price],
      target: [1, 100],
      changed_columns: ["price"],
    };
    return d;
  }

  describe("タイムライン・スクラバー / 再生 (#2015)", () => {
    beforeEach(() => {
      reducedRef.value = false;
    });

    it("スクラバーを動かすと、その段の隣接ペアの差分を取得する", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
      renderPanel();
      const slider = await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      // 既定は最新の段 (12 → 13)。
      await waitFor(() => expect(api.timelapseDiffGenerations).toHaveBeenCalledWith(12, 13));
      expect(slider).toHaveValue("2");
      fireEvent.change(slider, { target: { value: "1" } });
      await waitFor(() => expect(api.timelapseDiffGenerations).toHaveBeenCalledWith(11, 12));
      expect(screen.getByLabelText(t("timelapseFrom"))).toBeInTheDocument();
    });

    it("再生すると最初の段から終端まで順に取得して自動停止する", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
      renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
      vi.mocked(api.timelapseDiffGenerations).mockClear();

      fireEvent.click(screen.getByRole("button", { name: t("timelapsePlay") }));
      await waitFor(() => expect(api.timelapseDiffGenerations).toHaveBeenCalledTimes(2));
      expect(vi.mocked(api.timelapseDiffGenerations).mock.calls).toEqual([
        [11, 12],
        [12, 13],
      ]);
      // 終端で止まり、再生ボタンに戻る。
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("timelapsePlay") })).toBeInTheDocument(),
      );
    });

    it("取得中に別の段へ移ると、遅れて届いた古い応答は捨てる", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValueOnce(genDiff());
      renderPanel();
      const slider = await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());

      let resolveStale: (d: TimelapseGenerationDiff) => void = () => {};
      vi.mocked(api.timelapseDiffGenerations).mockReturnValueOnce(
        new Promise<TimelapseGenerationDiff>((resolve) => {
          resolveStale = resolve;
        }),
      );
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValueOnce(diffWithPrice(777));
      fireEvent.change(slider, { target: { value: "1" } }); // 取得が保留される
      fireEvent.change(slider, { target: { value: "2" } }); // すぐ別の段へ
      await waitFor(() => expect(screen.getByText("777")).toBeInTheDocument());
      resolveStale(diffWithPrice(999));
      await Promise.resolve();
      expect(screen.queryByText("999")).not.toBeInTheDocument();
      expect(screen.getByText("777")).toBeInTheDocument();
    });

    it("再生中に一時停止すると、それ以上は取得しない", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      let resolveFirst: (d: TimelapseGenerationDiff) => void = () => {};
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValueOnce(genDiff());
      renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
      vi.mocked(api.timelapseDiffGenerations).mockClear();
      vi.mocked(api.timelapseDiffGenerations).mockReturnValueOnce(
        new Promise<TimelapseGenerationDiff>((resolve) => {
          resolveFirst = resolve;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: t("timelapsePlay") }));
      fireEvent.click(await screen.findByRole("button", { name: t("timelapsePause") }));
      resolveFirst(genDiff());
      await new Promise((r) => setTimeout(r, 50));
      expect(api.timelapseDiffGenerations).toHaveBeenCalledTimes(1);
    });

    it("最終段へ進んでも差分は消えず、読み込み表示を出さない", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
      renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
      vi.mocked(api.timelapseDiffGenerations).mockClear();
      const seen: boolean[] = [];
      const obs = new MutationObserver(() => seen.push(!!screen.queryByText(t("timelapseDiffLoading"))));
      obs.observe(document.body, { childList: true, subtree: true });
      fireEvent.click(screen.getByRole("button", { name: t("timelapsePlay") }));
      await waitFor(() => expect(api.timelapseDiffGenerations).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("timelapsePlay") })).toBeInTheDocument(),
      );
      obs.disconnect();
      expect(seen.some(Boolean)).toBe(false);
      expect(screen.getByText("150")).toBeInTheDocument();
    });

    it("再生中に取得エラーが出たら止まる", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValueOnce(genDiff());
      renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
      vi.mocked(api.timelapseDiffGenerations).mockClear();
      vi.mocked(api.timelapseDiffGenerations).mockRejectedValue("boom");
      fireEvent.click(screen.getByRole("button", { name: t("timelapsePlay") }));
      expect(await screen.findByText(t("timelapseDiffError", { error: "boom" }))).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 50));
      expect(api.timelapseDiffGenerations).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: t("timelapsePlay") })).toBeDisabled();
    });

    it("ウォッチを切り替えたら再生は止まる", async () => {
      const other = { ...threeGenWatch(), id: 8, table: "other" };
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch(), other]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValueOnce(genDiff());
      renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
      vi.mocked(api.timelapseDiffGenerations).mockReturnValue(new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: t("timelapsePlay") }));
      await screen.findByRole("button", { name: t("timelapsePause") });
      fireEvent.click(screen.getByRole("button", { name: /other/ }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("timelapsePlay") })).toBeInTheDocument(),
      );
    });

    it("アンマウントすると再生の続きを取得しない", async () => {
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
      const { unmount } = renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      await waitFor(() => expect(screen.getByText("150")).toBeInTheDocument());
      vi.mocked(api.timelapseDiffGenerations).mockClear();
      fireEvent.click(screen.getByRole("button", { name: t("timelapsePlay") }));
      unmount();
      await new Promise((r) => setTimeout(r, 50));
      expect(api.timelapseDiffGenerations).toHaveBeenCalledTimes(1);
    });

    it("reduced-motion では再生を無効にし、ステップ送りだけ使える", async () => {
      reducedRef.value = true;
      vi.mocked(api.timelapseListWatches).mockResolvedValue([threeGenWatch()]);
      vi.mocked(api.timelapseDiffGenerations).mockResolvedValue(genDiff());
      renderPanel();
      await screen.findByRole("slider", { name: t("timelapseScrubAria") });
      expect(screen.getByRole("button", { name: t("timelapsePlay") })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: t("timelapseStepPrev") }));
      await waitFor(() => expect(api.timelapseDiffGenerations).toHaveBeenCalledWith(11, 12));
    });
  });
});
