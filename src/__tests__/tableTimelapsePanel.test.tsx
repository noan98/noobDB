import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableWatch, TimelapseGenerationDiff } from "../api/tauri";

/**
 * テーブル・タイムラプス (#739) のボトムパネル。保存済み世代の既定ペア
 * (1 つ前 → 最新) の差分が行/セル単位で描かれること、ツリーからのウォッチ登録要求で
 * 制約とプライバシーを示す確認ダイアログが出て、行数上限超過時は同意が無ければ
 * 登録しないことを固定する。
 */
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
      rows: [
        { status: "different", key: [1], source: [1, 150], target: [1, 100], changed_columns: ["price"] },
        { status: "source_only", key: [3], source: [3, 300], target: null, changed_columns: [] },
      ],
      truncated: false,
      source_count: 2,
      target_count: 2,
    },
    columns_added: [],
    columns_removed: [],
    partial: false,
    from_captured_at: "2026-01-01T00:00:00Z",
    to_captured_at: "2026-01-02T00:00:00Z",
  };
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
    expect(screen.getByText(t("timelapseCountAdded", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(t("timelapseCountChanged", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText("300").closest("tr")).toHaveAttribute("data-kind", "added");
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
});
