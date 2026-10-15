import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { SqliteMaintenanceResult } from "../api/tauri";
import { freelistRatio, groupFkViolations, shouldSuggestVacuum } from "../components/sqliteMaintenance";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, sqliteMaintenance: vi.fn() } };
});

import { SqliteMaintenancePanel } from "../components/SqliteMaintenancePanel";
import { api } from "../api/tauri";

const result = (over: Partial<SqliteMaintenanceResult> = {}): SqliteMaintenanceResult => ({
  action: "integrity_check",
  ok: true,
  messages: [],
  fk_violations: [],
  truncated: false,
  page_count: 1000,
  freelist_count: 10,
  elapsed_ms: 3,
  ...over,
});

beforeEach(() => {
  vi.mocked(api.sqliteMaintenance).mockReset();
});

describe("sqliteMaintenance 純ロジック (#1625)", () => {
  it("空きページ率と VACUUM の目安", () => {
    expect(freelistRatio(result({ page_count: 0 }))).toBeNull();
    expect(freelistRatio(result({ page_count: 200, freelist_count: 50 }))).toBe(0.25);
    expect(shouldSuggestVacuum(result({ page_count: 200, freelist_count: 50 }))).toBe(true);
    expect(shouldSuggestVacuum(result({ page_count: 200, freelist_count: 39 }))).toBe(false);
    // 小さな DB では勧めない
    expect(shouldSuggestVacuum(result({ page_count: 50, freelist_count: 40 }))).toBe(false);
    expect(shouldSuggestVacuum(result({ page_count: null, freelist_count: null }))).toBe(false);
  });

  it("違反行を親子の表の組ごとに件数の多い順にまとめる", () => {
    const v = (table: string, parent: string, rowid: number) => ({ table, parent, rowid, fk_index: 0 });
    expect(groupFkViolations([v("a", "p", 1), v("b", "p", 1), v("b", "p", 2)])).toEqual([
      { table: "b", parent: "p", count: 2 },
      { table: "a", parent: "p", count: 1 },
    ]);
  });
});

describe("SqliteMaintenancePanel (#1625)", () => {
  it("整合性検査の成功を表示する", async () => {
    vi.mocked(api.sqliteMaintenance).mockResolvedValue(result());
    renderWithProviders(<SqliteMaintenancePanel sessionId="s1" readOnly={false} />);
    fireEvent.click(screen.getByTestId("sqlite-maint-integrity_check"));
    await waitFor(() => expect(screen.getByTestId("sqlite-maint-ok")).toBeInTheDocument());
    expect(api.sqliteMaintenance).toHaveBeenCalledWith("s1", "integrity_check");
    expect(screen.getByTestId("sqlite-maint-pages")).toHaveTextContent("1000");
  });

  it("外部キー違反を表に出し、空きが多ければ VACUUM を案内する", async () => {
    vi.mocked(api.sqliteMaintenance).mockResolvedValue(
      result({
        action: "foreign_key_check",
        ok: false,
        fk_violations: [{ table: "orders", rowid: 7, parent: "users", fk_index: 0 }],
        freelist_count: 500,
      }),
    );
    renderWithProviders(<SqliteMaintenancePanel sessionId="s1" readOnly={false} />);
    fireEvent.click(screen.getByTestId("sqlite-maint-foreign_key_check"));
    await waitFor(() => expect(screen.getByTestId("sqlite-maint-problem")).toBeInTheDocument());
    expect(screen.getByTestId("sqlite-maint-violation")).toHaveTextContent("orders");
    expect(screen.getByTestId("sqlite-maint-violation")).toHaveTextContent("7");
    expect(screen.getByTestId("sqlite-maint-vacuum")).toBeInTheDocument();
  });

  it("読み取り専用の接続では統計を更新する操作を無効にする", () => {
    renderWithProviders(<SqliteMaintenancePanel sessionId="s1" readOnly />);
    expect(screen.getByTestId("sqlite-maint-optimize")).toBeDisabled();
    expect(screen.getByTestId("sqlite-maint-analyze")).toBeDisabled();
    expect(screen.getByTestId("sqlite-maint-integrity_check")).toBeEnabled();
    expect(screen.getByText(t("sqliteMaintEmpty"))).toBeInTheDocument();
  });

  it("ANALYZE 後は実行計画の変化に注意を促す", async () => {
    vi.mocked(api.sqliteMaintenance).mockResolvedValue(result({ action: "analyze" }));
    renderWithProviders(<SqliteMaintenancePanel sessionId="s1" readOnly={false} />);
    fireEvent.click(screen.getByTestId("sqlite-maint-analyze"));
    await waitFor(() =>
      expect(screen.getByTestId("sqlite-maint-done")).toHaveTextContent(t("sqliteMaintPlanChange")),
    );
  });
});
