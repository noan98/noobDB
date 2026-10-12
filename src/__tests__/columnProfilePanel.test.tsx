import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * 列プロファイル (「列を探索」) の実行中表示 (#1211)。素の Spinner 単独ではなく、
 * 結果の形 (統計タイル + ヒストグラム + 上位値表) を模した共通スケルトンを出し、
 * 完了で実データに差し替わることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn(),
      profileColumn: vi.fn(),
    },
  };
});

import { ColumnProfilePanel } from "../components/ColumnProfilePanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.describeTable).mockResolvedValue([]);
});

describe("ColumnProfilePanel running skeleton (#1211)", () => {
  it("実行中はスケルトンを出し、完了で統計に差し替える", async () => {
    let resolve: (p: Awaited<ReturnType<typeof api.profileColumn>>) => void = () => {};
    vi.mocked(api.profileColumn).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    renderWithProviders(
      <ColumnProfilePanel
        sessionId="s1"
        driver="mysql"
        target={{ database: "app", table: "orders", column: "id" }}
        onSelectColumn={() => {}}
      />,
    );

    const skeleton = await screen.findByTestId("profile-skeleton");
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(t("profileRunning"))).toBeInTheDocument();
    expect(screen.queryByText(t("profileTotal"))).not.toBeInTheDocument();

    resolve({
      data_type: "int",
      total_count: 10,
      null_count: 0,
      distinct_count: 10,
      distinct_approximate: false,
      min_value: null,
      max_value: null,
      top_values: [],
      histogram: [],
      notes: [],
    } as never);

    await waitFor(() => {
      expect(screen.queryByTestId("profile-skeleton")).not.toBeInTheDocument();
    });
    expect(screen.getByText(t("profileTotal"))).toBeInTheDocument();
  });
});

describe("ColumnProfilePanel 列切替の debounce", () => {
  it("素早く列を切り替えても、最後の列の集計だけを発行する", async () => {
    vi.mocked(api.profileColumn).mockResolvedValue({
      data_type: "int", total_count: 1, null_count: 0, distinct_count: 1, distinct_approximate: false,
      min_value: null, max_value: null, top_values: [], histogram: [], notes: [],
    } as never);
    const mk = (column: string) => (
      <ColumnProfilePanel sessionId="s1" driver="mysql" target={{ database: "app", table: "orders", column }} onSelectColumn={() => {}} />
    );
    const { rerender } = renderWithProviders(mk("a"));
    rerender(mk("b"));
    rerender(mk("c"));
    await waitFor(() => expect(api.profileColumn).toHaveBeenCalledTimes(1));
    expect(api.profileColumn).toHaveBeenCalledWith("s1", "app", "orders", "c", false);
  });
});

describe("ColumnProfilePanel StatTile (#1238)", () => {
  const base = {
    data_type: "bigint",
    null_count: 0,
    distinct_count: 0,
    distinct_approximate: false,
    min_value: null,
    max_value: null,
    top_values: [],
    histogram: [],
    notes: [],
  };
  const renderPanel = () =>
    renderWithProviders(
      <ColumnProfilePanel
        sessionId="s1"
        driver="mysql"
        target={{ database: "app", table: "orders", column: "id" }}
        onSelectColumn={() => {}}
      />,
    );

  it("2^53 超の件数 (文字列) は丸めず桁区切りだけで出す", async () => {
    vi.mocked(api.profileColumn).mockResolvedValueOnce({
      ...base,
      total_count: "9007199254740993",
    } as never);
    renderPanel();
    expect((await screen.findAllByText("9,007,199,254,740,993")).length).toBeGreaterThan(0);
  });

  it("総数 0 のとき NULL 率は「—」になる", async () => {
    vi.mocked(api.profileColumn).mockResolvedValueOnce({ ...base, total_count: 0 } as never);
    renderPanel();
    expect((await screen.findAllByText("—")).length).toBeGreaterThan(0);
  });
});
