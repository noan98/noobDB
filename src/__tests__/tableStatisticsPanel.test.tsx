import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableSchema, TableSizeInfo } from "../api/tauri";

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
      tableSizes: vi.fn().mockResolvedValue([] as TableSizeInfo[]),
      schemaOverview: vi.fn().mockResolvedValue([] as TableSchema[]),
      foreignKeys: vi.fn().mockResolvedValue([]),
      listIndexes: vi.fn().mockResolvedValue([]),
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
    renderWithProviders(
      <TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("sizeEmpty"))).toBeInTheDocument();
    });
  });

  it("shows the shared compact EmptyState title when the name filter matches nothing", async () => {
    vi.mocked(api.tableSizes).mockResolvedValueOnce([
      { name: "users", row_estimate: 10, data_bytes: 100, index_bytes: 10, total_bytes: 110 },
    ]);
    vi.mocked(api.schemaOverview).mockResolvedValueOnce([{ name: "users", columns: ["id"] }]);

    renderWithProviders(
      <TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />,
    );
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
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.tableSizes`
 * (等) が再度呼ばれることを固定する。
 */
describe("TableStatisticsPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.tableSizes).mockRejectedValueOnce(new Error("connection refused"));

    renderWithProviders(
      <TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(t("sizeLoadError", { error: "Error: connection refused" })),
      ).toBeInTheDocument();
    });
    expect(api.tableSizes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("sizeRetry") }));

    await waitFor(() => {
      expect(api.tableSizes).toHaveBeenCalledTimes(2);
    });
  });
});
