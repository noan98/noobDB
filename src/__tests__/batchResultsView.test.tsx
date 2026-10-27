import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import userEvent from "@testing-library/user-event";
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

describe("BatchResultsView の停止ボタン (#1594)", () => {
  it("実行中だけ停止ボタンを出し、押すと onStop を呼ぶ", () => {
    const onStop = vi.fn();
    const { rerender } = renderWithProviders(
      <BatchResultsView results={[]} running onRerun={() => {}} onClose={() => {}} onStop={onStop} />,
    );
    screen.getByTestId("batch-stop").click();
    expect(onStop).toHaveBeenCalledTimes(1);
    rerender(
      <BatchResultsView results={[]} running={false} onRerun={() => {}} onClose={() => {}} onStop={onStop} />,
    );
    expect(screen.queryByTestId("batch-stop")).toBeNull();
  });
});

describe("BatchResultsView の行数上限 (#1616)", () => {
  it("100 行を超える SELECT は先頭 100 行だけ描画し、「さらに表示」で広げる", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [i]);
    render({ sql: "SELECT id FROM t", status: "ok", columns, rows, totalRows: 120 });
    expect(screen.getAllByRole("row")).toHaveLength(101); // ヘッダ + 100
    const more = screen.getByRole("button", { name: t("batchShowMore", { n: 20, remaining: 20 }) });
    await userEvent.click(more);
    expect(await screen.findAllByRole("row")).toHaveLength(121);
  });

  it("100 行以下なら「さらに表示」は出ない", () => {
    render({ sql: "SELECT id FROM t", status: "ok", columns, rows: [[1], [2]], totalRows: 2 });
    expect(screen.queryByRole("button", { name: /さらに|more rows/ })).toBeNull();
  });
});

describe("BatchResultsView の Motion (#1873)", () => {
  it("batchEnterDelay は今回増えたカードだけを順にずらす", async () => {
    const { batchEnterDelay } = await import("../components/BatchResultsView");
    const { staggerTiming } = await import("../motion");
    expect(batchEnterDelay(0, 3)).toBe(0);
    expect(batchEnterDelay(2, 3)).toBe(0);
    expect(batchEnterDelay(3, 3)).toBe(0);
    expect(batchEnterDelay(5, 3)).toBeCloseTo(2 * staggerTiming.each);
  });

  it("成否ドットが文の数だけ描かれる", () => {
    renderWithProviders(
      <BatchResultsView
        results={[
          { sql: "SELECT 1", status: "ok", rowsAffected: 0 },
          { sql: "BAD", status: "error", error: "x" },
        ]}
        running={false}
        onRerun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByTestId("batch-status-dot")).toHaveLength(2);
  });
});
