import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { BatchResultsView } from "../components/BatchResultsView";
import type { BatchStatementResult } from "../sqlScript";

const columns = [{ name: "id", type_name: "INT" }];

function render(result: BatchStatementResult) {
  renderWithProviders(
    <BatchResultsView results={[result]} running={false} onRerun={() => {}} onClose={() => {}} />,
  );
}

describe("BatchResultsView の件数表示 (#1534)", () => {
  it("切り詰めていない SELECT は返した行数だけを出す", () => {
    render({ sql: "SELECT id FROM t", status: "ok", columns, rows: [[1], [2]], totalRows: 2 });
    expect(screen.getByText(t("batchRows", { rows: 2 }), { exact: false })).toBeInTheDocument();
  });

  it("プレビュー上限で切り詰めて総数が分かるときは「先頭 N 行 / 全 M 行」", () => {
    render({
      sql: "SELECT id FROM t",
      status: "ok",
      columns,
      rows: [[1], [2]],
      truncated: true,
      totalRows: 10000,
    });
    expect(
      screen.getByText(t("batchRowsTruncatedOfTotal", { shown: 2, total: "10,000" }), {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("総数が不明なまま切り詰めたときは「先頭 N 行のみ」と注記する", () => {
    render({ sql: "SELECT id FROM t", status: "ok", columns, rows: [[1], [2]], truncated: true });
    expect(screen.getByText(t("batchRowsTruncated", { shown: 2 }), { exact: false })).toBeInTheDocument();
  });
});
