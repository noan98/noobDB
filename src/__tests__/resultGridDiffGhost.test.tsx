import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { CellValue, Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { setColumnMaskEnabled } from "../settings";
import { MASK_PLACEHOLDER } from "../components/columnMask";

// 再実行差分の「消えた行」ゴーストと「変化のみ」(#1628) の結線。

const COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "user_email", type_name: "VARCHAR" },
  { name: "plan", type_name: "VARCHAR" },
];
const TABLE_COLUMNS: TableColumnInfo[] = COLUMNS.map((c, i) => ({
  name: c.name,
  data_type: c.type_name.toLowerCase(),
  nullable: i !== 0,
  key: i === 0 ? "PRI" : "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
}));

function make(rows: CellValue[][]): QueryResult {
  return { columns: COLUMNS, rows, rows_affected: 0, elapsed_ms: 1 };
}

const PREV: CellValue[][] = [
  [1, "a@example.com", "free"],
  [2, "secret@example.com", "pro"],
];

function grid(rows: CellValue[][]) {
  return (
    <ResultGrid
      result={make(rows)}
      tableColumns={TABLE_COLUMNS}
      diffHighlightEnabled
      diffComparable
      diffPrevRows={PREV}
      onToggleDiffHighlight={() => {}}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  setColumnMaskEnabled(true);
});

describe("再実行差分 (#1628)", () => {
  it("消えた行のゴーストでも機微カラムはマスクされる", () => {
    renderWithProviders(grid([[1, "a@example.com", "free"]]));
    const ghost = screen.getByTestId("removed-rows-ghost");
    expect(ghost).not.toHaveTextContent("secret@example.com");
    expect(ghost).toHaveTextContent(MASK_PLACEHOLDER);
    expect(ghost).toHaveTextContent("pro");
  });

  it("「変化のみ」を入れたまま変化なしで再実行しても、全行が隠れたままにならない", async () => {
    const { container, rerender } = renderWithProviders(grid([[1, "a@example.com", "paid"], PREV[1]]));
    fireEvent.click(screen.getByRole("checkbox", { name: t("diffChangedOnlyAria") }));
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));
    // 前回と同じ内容で再実行 (差分なし)。
    rerender(grid(PREV.map((r) => [...r])));
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(screen.queryByRole("checkbox", { name: t("diffChangedOnlyAria") })).toBeNull();
  });
});
