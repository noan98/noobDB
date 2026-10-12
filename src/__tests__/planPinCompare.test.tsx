import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import type { QueryResult } from "../api/tauri";
import { ExplainViewer } from "../components/ExplainViewer";
import { PlanCompareModal } from "../components/PlanCompareModal";
import { __resetExplainPins } from "../explainPins";
import { setLocale, t } from "../i18n";

// EXPLAIN タブでの「計画を固定 → 固定と比較」 (#1539)。比較の中身は planCompare.test.ts が固定する。

function plan(table: Record<string, unknown>, cost: string): QueryResult {
  const json = JSON.stringify({ query_block: { select_id: 1, cost_info: { query_cost: cost }, table } });
  return { columns: [{ name: "EXPLAIN", type_name: "" }], rows: [[json]], rows_affected: 0, elapsed_ms: 1 };
}
const cost = { read_cost: "1.0", eval_cost: "1.0", prefix_cost: "2.0" };
const scan = plan(
  { table_name: "orders", access_type: "ALL", rows_examined_per_scan: 2_000_000, cost_info: cost },
  "400000.00",
);
const indexed = plan(
  { table_name: "orders", access_type: "ref", key: "ix_user", rows_examined_per_scan: 3, cost_info: cost },
  "1.20",
);

beforeEach(() => {
  setLocale("ja");
  __resetExplainPins();
});

describe("EXPLAIN 計画の固定と比較 (#1539)", () => {
  it("固定していないと比較ボタンは出ない", () => {
    renderWithProviders(<ExplainViewer result={scan} driver="mysql" pin={{ scope: "tab-1", sql: null }} />);
    expect(screen.getByRole("button", { name: new RegExp(t("planPin")) })).toBeEnabled();
    expect(screen.queryByRole("button", { name: t("planCompareOpen") })).toBeNull();
  });

  it("固定 → 計画が変わる → 比較で改善と判定され、アクセス方式の変化が出る", async () => {
    const { rerender } = renderWithProviders(
      <ExplainViewer result={scan} driver="mysql" pin={{ scope: "tab-1", sql: null }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("planPin") }));
    rerender(<ExplainViewer result={indexed} driver="mysql" pin={{ scope: "tab-1", sql: null }} />);
    fireEvent.click(await screen.findByRole("button", { name: t("planCompareOpen") }));
    expect(
      await screen.findByText((text) => text.startsWith("重さスコアが") && text.includes("下がりました")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t("planWatchChangeAccess", { object: "orders", before: "ALL", after: "ref" })),
    ).toBeInTheDocument();
  });

  it("別のタブ (scope) の固定は見えない", () => {
    const { rerender } = renderWithProviders(
      <ExplainViewer result={scan} driver="mysql" pin={{ scope: "tab-1", sql: null }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("planPin") }));
    rerender(<ExplainViewer result={indexed} driver="mysql" pin={{ scope: "tab-2", sql: null }} />);
    expect(screen.queryByRole("button", { name: t("planCompareOpen") })).toBeNull();
  });

  it("片方だけ実測 (ANALYZE) のときは注意を出し、同じモードなら出さない", async () => {
    const { rerender } = renderWithProviders(
      <PlanCompareModal driver="mysql" before={scan} after={indexed} beforeLabel="10:00" beforeAnalyze={false} afterAnalyze onClose={() => {}} />,
    );
    expect(await screen.findByText(t("planCompareAnalyzeMismatch"))).toBeInTheDocument();
    rerender(
      <PlanCompareModal driver="mysql" before={scan} after={indexed} beforeLabel="10:00" beforeAnalyze afterAnalyze onClose={() => {}} />,
    );
    expect(screen.queryByText(t("planCompareAnalyzeMismatch"))).toBeNull();
  });
});
