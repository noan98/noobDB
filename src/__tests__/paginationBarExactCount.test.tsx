import { describe, expect, it, vi } from "vitest";
import { PaginationBar } from "../components/PaginationBar";
import { tableExactRowCount, tableTotalPagesEstimate } from "../components/PaneView";
import { t } from "../i18n";
import { exactCountKey } from "../pagination";
import { fireEvent, renderWithProviders, screen } from "./testUtils";

const baseProps = {
  page: 3,
  pageSize: 100,
  rowsOnPage: 100,
  totalPages: 3,
  loading: false,
  onGoToPage: vi.fn(),
  onSetPageSize: vi.fn(),
};

describe("PaginationBar の正確な件数 (#1627)", () => {
  it("押したときだけ onCountExact を呼ぶ (描画しただけでは呼ばない)", () => {
    const onCountExact = vi.fn();
    renderWithProviders(<PaginationBar {...baseProps} onCountExact={onCountExact} />);
    expect(onCountExact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("pageCountExact") }));
    expect(onCountExact).toHaveBeenCalledTimes(1);
  });

  it("onCountExact が無ければボタンを出さない", () => {
    renderWithProviders(<PaginationBar {...baseProps} />);
    expect(screen.queryByRole("button", { name: t("pageCountExact") })).toBeNull();
  });

  it("数えている間は無効化して待機表示にする", () => {
    renderWithProviders(<PaginationBar {...baseProps} counting onCountExact={vi.fn()} />);
    expect(screen.getByRole("button", { name: new RegExp(t("pageCounting")) })).toBeDisabled();
  });

  it("推定は「約」、確定値は「約」なしで総行数を出し、最終ページの次へは進めない", () => {
    const { unmount } = renderWithProviders(<PaginationBar {...baseProps} />);
    expect(document.body.textContent).toContain(t("pageOfTotal", { total: 3 }));
    // 推定の最終ページでも満杯なら続きがありうる。
    expect(screen.getByRole("button", { name: t("pageNext") })).toBeEnabled();
    unmount();
    renderWithProviders(
      <PaginationBar {...baseProps} totalExact exactRowCount={300} onCountExact={vi.fn()} />,
    );
    expect(document.body.textContent).toContain(t("pageOfTotalExact", { total: 3 }));
    expect(screen.getByText(t("pageTotalRowsExact", { count: 300 }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("pageNext") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("pageRecount") })).toBeInTheDocument();
  });
});

describe("tableTotalPagesEstimate / tableExactRowCount (#1627)", () => {
  const base = "SELECT * FROM t";
  const exact = { total: 250, key: exactCountKey(base, null) };

  it("確定した件数は推定より優先する", () => {
    const tab = { serverFilter: null, rowEstimateTotal: 100, paginatable: base, exactRowCount: exact };
    expect(tableTotalPagesEstimate(tab, 100)).toBe(3);
    expect(tableExactRowCount(tab)).toBe(250);
  });

  it("サーバ側フィルタが変わったら確定値は無効 (推定もフィルタ中は未知)", () => {
    const filter = { column: "a", op: "=", value: "1" } as never;
    const tab = { serverFilter: filter, rowEstimateTotal: 100, paginatable: base, exactRowCount: exact };
    expect(tableExactRowCount(tab)).toBeNull();
    expect(tableTotalPagesEstimate(tab, 100)).toBeNull();
  });

  it("フィルタ付きで数えた件数は、そのフィルタの間だけ有効", () => {
    const filter = { column: "a", op: "=", value: "1" } as never;
    const tab = {
      serverFilter: filter,
      rowEstimateTotal: 100,
      paginatable: base,
      exactRowCount: { total: 40, key: exactCountKey(base, filter) },
    };
    expect(tableTotalPagesEstimate(tab, 100)).toBe(1);
  });

  it("未取得なら従来どおり推定", () => {
    expect(tableTotalPagesEstimate({ serverFilter: null, rowEstimateTotal: 250 }, 100)).toBe(3);
  });
});
