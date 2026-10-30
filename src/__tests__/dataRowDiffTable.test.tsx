import { describe, expect, it } from "vitest";
import type { DataDiff } from "../api/tauri";
import { DATA_ROW_PAGE, DataRowDiffTable, dataRowView } from "../components/DataRowDiffTable";
import { t } from "../i18n";
import { fireEvent, renderWithProviders, screen } from "./testUtils";

/**
 * 行データの差分表 (スキーマ比較の行データ同期・サンドボックスの書き戻し確認)。
 * 「更新先を基準に合わせる」向きで、変更は「更新先の現在 → 適用後 (基準)」と読む。
 */

function makeDiff(rows: DataDiff["rows"]): DataDiff {
  return {
    target_driver: "mysql",
    table: "plans",
    columns: ["id", "name", "price"],
    column_types: ["int", "varchar", "int"],
    primary_key: ["id"],
    key_kind: "primary_key",
    rows,
    truncated: false,
    source_count: 3,
    target_count: 3,
  };
}

describe("dataRowView", () => {
  it("変更行は更新先の現在値 → 基準の値の向きで並べる", () => {
    const diff = makeDiff([
      {
        status: "different",
        key: [1],
        source: [1, "Pro", 200],
        target: [1, "Pro", 100],
        changed_columns: ["price"],
      },
    ]);
    const v = dataRowView(diff, diff.rows[0]);
    expect(v.key).toBe("id=1");
    expect(v.changes).toEqual([{ column: "price", current: "100", next: "200" }]);
  });

  it("追加は基準の値、削除は更新先の値を主キー以外から見せる", () => {
    const diff = makeDiff([
      { status: "source_only", key: [2], source: [2, "Team", 300], target: null, changed_columns: [] },
      { status: "target_only", key: [3], source: null, target: [3, "Old", 50], changed_columns: [] },
    ]);
    expect(dataRowView(diff, diff.rows[0]).preview).toBe('name="Team", price=300');
    expect(dataRowView(diff, diff.rows[1]).preview).toBe('name="Old", price=50');
  });
});

describe("DataRowDiffTable", () => {
  it("操作のチップで行を絞り込める", () => {
    const diff = makeDiff([
      {
        status: "different",
        key: [1],
        source: [1, "Pro", 200],
        target: [1, "Pro", 100],
        changed_columns: ["price"],
      },
      { status: "source_only", key: [2], source: [2, "Team", 300], target: null, changed_columns: [] },
    ]);
    renderWithProviders(<DataRowDiffTable diff={diff} />);
    expect(screen.getByText("id=2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("schemaCompareOpAdd")) }));
    expect(screen.queryByText("id=2")).toBeNull();
    expect(screen.getByText("id=1")).toBeInTheDocument();
  });

  it("多い行は一度に描かず「さらに表示」で足す", () => {
    const rows = Array.from({ length: DATA_ROW_PAGE + 5 }, (_, i) => ({
      status: "source_only" as const,
      key: [i + 1],
      source: [i + 1, "n", 1],
      target: null,
      changed_columns: [],
    }));
    renderWithProviders(<DataRowDiffTable diff={makeDiff(rows)} />);
    expect(screen.queryByText(`id=${DATA_ROW_PAGE + 1}`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("dataRowDiffMore", { count: 5 }) }));
    expect(screen.getByText(`id=${DATA_ROW_PAGE + 1}`)).toBeInTheDocument();
  });

  it("先頭が同じ長いキーの行も別の行として描き、絞り込みで取り違えない", () => {
    const long = "k".repeat(80);
    const diff = makeDiff([
      {
        status: "source_only",
        key: [`${long}1`],
        source: [`${long}1`, "a", 1],
        target: null,
        changed_columns: [],
      },
      {
        status: "source_only",
        key: [`${long}2`],
        source: [`${long}2`, "b", 2],
        target: null,
        changed_columns: [],
      },
    ]);
    renderWithProviders(<DataRowDiffTable diff={diff} changeTitle="snapshot → sandbox" />);
    expect(screen.getAllByText(/追加する行|New row/)).toHaveLength(2);
    expect(screen.getByText("snapshot → sandbox")).toBeInTheDocument();
  });
});
