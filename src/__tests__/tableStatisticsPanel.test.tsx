import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableStatistic } from "../api/tauri";

/**
 * テーブル/DB サイズ・構造統計ダッシュボード (#562/#660) の空状態統一 (#847)。
 * データベースにテーブルが 1 件もない真の空状態と、名前フィルタで 0 件になる
 * ケースの双方で、共有 `EmptyState` のタイトルが表示されることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      tableStatistics: vi.fn().mockResolvedValue([] as TableStatistic[]),
    },
  };
});

import { TableStatisticsPanel } from "../components/TableStatisticsPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TableStatisticsPanel empty state (#847)", () => {
  it("shows the shared EmptyState (illustration) title when the database has no tables", async () => {
    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(t("sizeEmpty"))).toBeInTheDocument();
    });
  });

  it("shows the shared compact EmptyState title when the name filter matches nothing", async () => {
    vi.mocked(api.tableStatistics).mockResolvedValueOnce([
      {
        name: "users",
        row_estimate: 10,
        data_bytes: 100,
        index_bytes: 10,
        total_bytes: 110,
        column_count: 1,
        index_count: 1,
        has_primary_key: true,
        foreign_key_count: 0,
        previous: null,
      },
    ]);

    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(t("sizeFilterName")), {
      target: { value: "no-such-table" },
    });

    await waitFor(() => {
      expect(screen.getByText(t("sizeNoMatch"))).toBeInTheDocument();
    });
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく共有
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.tableStatistics`
 * (等) が再度呼ばれることを固定する。
 */
describe("TableStatisticsPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.tableStatistics).mockRejectedValueOnce(new Error("connection refused"));

    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(t("sizeLoadError", { error: "Error: connection refused" })),
      ).toBeInTheDocument();
    });
    expect(api.tableStatistics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("sizeRetry") }));

    await waitFor(() => {
      expect(api.tableStatistics).toHaveBeenCalledTimes(2);
    });
  });
});

/** 前回取得からの行数・サイズの増減 (#1621)。 */
describe("TableStatisticsPanel 前回取得からの増減 (#1621)", () => {
  it("行数と合計サイズの増減を表示し、前回値が無いテーブルには出さない", async () => {
    const base = {
      index_bytes: 0,
      column_count: 1,
      index_count: 1,
      has_primary_key: true,
      foreign_key_count: 0,
    };
    vi.mocked(api.tableStatistics).mockResolvedValueOnce([
      {
        ...base,
        name: "orders",
        row_estimate: 1500,
        data_bytes: 3 * 1024 * 1024,
        total_bytes: 3 * 1024 * 1024,
        previous: { at: "2026-01-01T00:00:00Z", row_estimate: 1000, total_bytes: 1024 * 1024 },
      },
      {
        ...base,
        name: "fresh",
        row_estimate: 5,
        data_bytes: 10,
        total_bytes: 10,
        previous: null,
      },
    ]);
    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);
    await screen.findByText("orders");
    const deltas = screen.getAllByTestId("stat-delta").map((d) => d.textContent);
    expect(deltas).toEqual(["+500", "+2.0 MB"]);
    expect(screen.getByText("fresh").closest("tr")?.querySelector("[data-testid=stat-delta]")).toBeNull();
  });
});
