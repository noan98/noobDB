import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import type { ColumnProfile, ConnectionProfile } from "../api/tauri";
import { setLocale, t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, profileColumn: vi.fn() } };
});

import { api } from "../api/tauri";
import { ColumnProfileCompareModal } from "../components/ColumnProfileCompareModal";

const prof = (id: string, name: string, production = false): ConnectionProfile =>
  ({ id, name, driver: "mysql", is_production: production, color: null }) as unknown as ConnectionProfile;

function profile(total: number, active: number): ColumnProfile {
  return {
    column: "status",
    data_type: "varchar(10)",
    numeric: false,
    total_count: total,
    non_null_count: total,
    null_count: 0,
    distinct_count: 2,
    distinct_approximate: false,
    min_value: "active",
    max_value: "closed",
    top_values: [
      { value: "active", count: active },
      { value: "closed", count: total - active },
    ],
    histogram: [],
    notes: [],
  };
}

function setup(over: { confirm?: () => Promise<boolean>; production?: boolean } = {}) {
  const confirm = vi.fn(over.confirm ?? (() => Promise.resolve(true)));
  renderWithProviders(
    <ColumnProfileCompareModal
      baseline={{ sessionId: "s-prod", profile: prof("p1", "prod") }}
      candidates={[{ sessionId: "s-stg", profile: prof("p2", "staging", over.production) }]}
      driver="mysql"
      target={{ database: "app", table: "orders", column: "status" }}
      approximate={false}
      confirm={confirm}
      onClose={() => {}}
    />,
  );
  return { confirm };
}

beforeEach(() => {
  setLocale("ja");
  vi.mocked(api.profileColumn).mockReset();
});

describe("ColumnProfileCompareModal (#1539)", () => {
  it("選んだ接続の同じ列を、接続ごとのデータベース名で集計し、基準との差を強調する", async () => {
    vi.mocked(api.profileColumn).mockImplementation((sid) =>
      Promise.resolve(sid === "s-prod" ? profile(1000, 600) : profile(100, 90)),
    );
    setup();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(t("profileCompareDatabaseAria", { name: "staging" })), {
      target: { value: "app_stg" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("profileCompareRun") }));
    await waitFor(() => expect(api.profileColumn).toHaveBeenCalledTimes(2));
    expect(api.profileColumn).toHaveBeenCalledWith("s-prod", "app", "orders", "status", false);
    expect(api.profileColumn).toHaveBeenCalledWith("s-stg", "app_stg", "orders", "status", false);
    // 差は 3 件: 総数、active の構成比 (60% → 90%)、closed の構成比 (40% → 10%)。
    expect(await screen.findByText(t("profileCompareDiffCount", { count: 3 }))).toBeInTheDocument();
    expect(screen.getByText("90 (90.0%)")).toBeInTheDocument();
  });

  it("本番接続を含むときは確認し、キャンセルなら集計しない", async () => {
    const { confirm } = setup({ production: true, confirm: () => Promise.resolve(false) });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: t("profileCompareRun") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(api.profileColumn).not.toHaveBeenCalled();
  });

  it("1 接続の失敗は他に影響せず、その接続のエラーを出す", async () => {
    vi.mocked(api.profileColumn).mockImplementation((sid) =>
      sid === "s-stg" ? Promise.reject(new Error("no such table")) : Promise.resolve(profile(10, 5)),
    );
    setup();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: t("profileCompareRun") }));
    expect(await screen.findByText(/no such table/)).toBeInTheDocument();
    expect(screen.getAllByText("varchar(10)").length).toBeGreaterThan(0);
  });
});
