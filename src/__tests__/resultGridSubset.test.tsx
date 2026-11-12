import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { setColumnMaskEnabled, setColumnMaskPatterns } from "../settings";
import { DEFAULT_MASK_PATTERNS } from "../components/columnMask";

// 右クリックメニューの「選択した行を起点にサブセット抽出」(#2265) の出し分け。
// 条件文字列そのものは subsetExtract.test.ts が固定する。

vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn().mockResolvedValue("/home/user/Downloads/export.csv"),
}));

const COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
];
const RESULT: QueryResult = {
  columns: COLUMNS,
  rows: [
    [1, "alice"],
    [2, "bob"],
  ],
  rows_affected: 0,
  elapsed_ms: 1,
};
const tableColumns = (pk: boolean): TableColumnInfo[] =>
  COLUMNS.map((c, i) => ({
    name: c.name,
    data_type: c.type_name.toLowerCase(),
    nullable: i !== 0,
    key: pk && i === 0 ? "PRI" : "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  }));

function openMenu(container: HTMLElement) {
  const cell = container.querySelectorAll("tbody tr")[0]?.querySelectorAll("td[role='gridcell']")[1];
  if (!cell) throw new Error("no cell");
  fireEvent.contextMenu(cell);
}

// 無効項目の理由は Tooltip (フォーカスで出る) で見せている。
async function expectReason(item: HTMLElement, text: string) {
  const wrapper = item.parentElement ?? item;
  fireEvent.focus(wrapper);
  fireEvent.mouseEnter(wrapper);
  expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
}

describe("ResultGrid のサブセット抽出メニュー (#2265)", () => {
  beforeEach(() => {
    setLocale("en");
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(DEFAULT_MASK_PATTERNS);
    localStorage.clear();
  });

  it("主キーのある表では有効で、選ぶと主キーの IN 条件を渡す", async () => {
    const onExtractSubset = vi.fn();
    const { container } = renderWithProviders(
      <ResultGrid
        result={RESULT}
        driver="postgres"
        database="db"
        table="users"
        tableColumns={tableColumns(true)}
        onExtractSubset={onExtractSubset}
      />,
    );
    openMenu(container);
    const item = await screen.findByRole("menuitem", { name: t("gridExtractSubset", { count: 1 }) });
    expect(item).not.toBeDisabled();
    fireEvent.click(item);
    expect(onExtractSubset).toHaveBeenCalledWith({
      database: "db",
      table: "users",
      whereClause: '"id" IN (1)',
      rootLimit: 1,
    });
  });

  it("主キーが無い表では理由つきで無効になる", async () => {
    const { container } = renderWithProviders(
      <ResultGrid
        result={RESULT}
        database="db"
        table="users"
        tableColumns={tableColumns(false)}
        onExtractSubset={vi.fn()}
      />,
    );
    openMenu(container);
    const item = await screen.findByRole("menuitem", { name: t("gridExtractSubset", { count: 1 }) });
    expect(item).toBeDisabled();
    await expectReason(item, t("gridExtractSubsetNoPk"));
  });

  it("クエリ結果タブ (表が特定できない) では理由つきで無効になる", async () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} onExtractSubset={vi.fn()} />);
    openMenu(container);
    const item = await screen.findByRole("menuitem", { name: t("gridExtractSubset", { count: 1 }) });
    expect(item).toBeDisabled();
    await expectReason(item, t("gridExtractSubsetNoTable"));
  });

  it("主キー列がマスク中なら理由つきで無効になる", async () => {
    setColumnMaskPatterns(["id"]);
    const { container } = renderWithProviders(
      <ResultGrid
        result={RESULT}
        database="db"
        table="users"
        tableColumns={tableColumns(true)}
        onExtractSubset={vi.fn()}
      />,
    );
    openMenu(container);
    const item = await screen.findByRole("menuitem", { name: t("gridExtractSubset", { count: 1 }) });
    expect(item).toBeDisabled();
    await expectReason(item, t("gridExtractSubsetMasked"));
  });
});
