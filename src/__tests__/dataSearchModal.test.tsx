import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { QueryResult, TableColumnInfo, TableRowEstimate } from "../api/tauri";

/**
 * DB 全体からの値検索 (#748) の空状態統一 (#847)。全テーブルを走査してもヒットが
 * 1 件もなかったケースで、共有 `EmptyState` (compact, icon="search") のタイトルが
 * 表示されることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTables: vi.fn().mockResolvedValue(["orders"]),
      tableRowEstimates: vi.fn().mockResolvedValue([
        { name: "orders", estimate: 10 },
      ] as TableRowEstimate[]),
      describeTable: vi.fn().mockResolvedValue([
        { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "", referenced_table: null, referenced_column: null },
        { name: "note", data_type: "varchar", nullable: true, key: "", default: null, extra: "", referenced_table: null, referenced_column: null },
      ] as TableColumnInfo[]),
      runQuery: vi.fn().mockResolvedValue({
        columns: [{ name: "note", type_name: "int" }],
        rows: [[0]],
        rows_affected: 0,
        elapsed_ms: 1,
      } as unknown as QueryResult),
    },
  };
});

import { DataSearchModal } from "../components/DataSearchModal";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DataSearchModal empty state (#847)", () => {
  it("shows the shared EmptyState title when the scan finds no hits", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DataSearchModal
        sessionId="s1"
        database="testdb"
        driver="mysql"
        isProduction={false}
        profileName="local"
        onOpenHit={() => {}}
        onClose={() => {}}
      />,
    );

    const termInput = await screen.findByLabelText(t("dataSearchTermLabel"));
    await user.type(termInput, "needle");
    await user.click(screen.getByRole("button", { name: t("dataSearchStart") }));

    // 実行前確認ダイアログ (常時表示) を承認する。フッタの「開始」ボタンと
    // 同じラベルが確認ダイアログ側にも出るため、後から追加される (= 一覧の
    // 末尾) 方が確認ダイアログのボタンになる。
    const startButtons = await screen.findAllByRole("button", { name: t("dataSearchStart") });
    await user.click(startButtons[startButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText(t("dataSearchNoHits"))).toBeInTheDocument();
    });
  });
});
