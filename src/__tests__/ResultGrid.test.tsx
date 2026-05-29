import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "./testUtils";
import { ResultGrid, GRID_CSS } from "../components/ResultGrid";
import { rowEditKey } from "../components/cellEdit";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale, t } from "../i18n";

// ResultGrid の主要インタラクション (描画・全文フィルタ・列ソート・ページ読み込み
// トリガー・インラインセル編集) の退行を検出するテスト (#354)。1,577 行に渡る
// 中核コンポーネントでありながらこれまで無テストだったため、リファクタリングや
// 機能追加で表示・編集フローが壊れたことを CI で自動検出できるようにする。
//
// 文言はロケールで変わるため i18n の `t()` から期待値を引く。バックエンド (IPC) は
// 呼ばないため `api/tauri` のモックは不要 (ResultGrid は受け取った `result` を
// 描画するだけで、編集の確定はコールバック経由で親に委ねる)。

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

const FRUIT_COLUMNS: Column[] = [
  { name: "name", type_name: "VARCHAR" },
  { name: "qty", type_name: "INT" },
];

const FRUIT_RESULT = makeResult(FRUIT_COLUMNS, [
  ["banana", 2],
  ["apple", 5],
  ["cherry", 9],
]);

/** tbody の各行から、データ列のテキストを行順に取り出す (行番号セルは除く)。 */
function dataRowTexts(container: HTMLElement): string[][] {
  const bodyRows = container.querySelectorAll("tbody tr");
  return Array.from(bodyRows).map((tr) =>
    Array.from(tr.querySelectorAll("td"))
      .filter((td) => !td.classList.contains("row-index") && !td.classList.contains("col-filler"))
      .map((td) => td.textContent ?? ""),
  );
}

describe("ResultGrid", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("列ヘッダと全行のセルを描画する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // ヘッダ (ソート可能なのでボタンとして描画される)
    expect(screen.getByRole("button", { name: /^name/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^qty/ })).toBeInTheDocument();

    expect(dataRowTexts(container)).toEqual([
      ["banana", "2"],
      ["apple", "5"],
      ["cherry", "9"],
    ]);
  });

  it("空の結果セットでは資格に応じたプレースホルダを表示する", () => {
    renderWithProviders(<ResultGrid result={null} />);
    expect(screen.getByText(t("resultEmpty"))).toBeInTheDocument();
  });

  it("全文フィルタで一致行だけに絞り込み、件数サマリを表示する", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const search = screen.getByLabelText(t("gridSearchAria"));
    await user.type(search, "an");

    // "banana" のみ "an" を含む。
    expect(dataRowTexts(container)).toEqual([["banana", "2"]]);
    expect(
      screen.getByText(t("gridFilteredCount", { shown: 1, total: 3 })),
    ).toBeInTheDocument();
  });

  it("一致行が無いフィルタでは専用メッセージを表示する", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    await user.type(screen.getByLabelText(t("gridSearchAria")), "zzz");

    expect(screen.getByText(t("gridNoMatches"))).toBeInTheDocument();
  });

  it("列ヘッダのクリックで昇順 → 降順にソートする", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // 1 回目: name 昇順
    await user.click(screen.getByRole("button", { name: /^name/ }));
    expect(dataRowTexts(container).map((r) => r[0])).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);

    // 2 回目: name 降順
    await user.click(screen.getByRole("button", { name: /^name/ }));
    expect(dataRowTexts(container).map((r) => r[0])).toEqual([
      "cherry",
      "banana",
      "apple",
    ]);
  });

  it("末尾付近までスクロール可能なとき onLoadMore を発火する", async () => {
    const onLoadMore = vi.fn();
    renderWithProviders(
      <ResultGrid result={FRUIT_RESULT} canLoadMore onLoadMore={onLoadMore} />,
    );
    // jsdom ではビューポート寸法が 0 のため、初回マウント時の判定で
    // 「末尾付近」と見なされ、すぐに読み込みがトリガーされる。
    await waitFor(() => expect(onLoadMore).toHaveBeenCalled());
  });

  it("これ以上ページが無いときは onLoadMore を発火しない", () => {
    const onLoadMore = vi.fn();
    renderWithProviders(
      <ResultGrid result={FRUIT_RESULT} canLoadMore={false} onLoadMore={onLoadMore} />,
    );
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("自動 LIMIT が効いているとバッジを出し、全件取得で onFetchAllRows を呼ぶ", async () => {
    const user = userEvent.setup();
    const onFetchAllRows = vi.fn();
    // rows.length (3) >= autoLimitApplied (3) のときだけバッジが出る。
    renderWithProviders(
      <ResultGrid
        result={FRUIT_RESULT}
        autoLimitApplied={3}
        onFetchAllRows={onFetchAllRows}
      />,
    );

    expect(screen.getByText(t("autoLimitApplied", { limit: 3 }))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("autoLimitFetchAll") }));
    expect(onFetchAllRows).toHaveBeenCalledTimes(1);
  });

  describe("インラインセル編集", () => {
    const columns: Column[] = [
      { name: "id", type_name: "INT" },
      { name: "name", type_name: "VARCHAR" },
    ];
    const tableColumns: TableColumnInfo[] = [
      {
        name: "id",
        data_type: "int",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
      {
        name: "name",
        data_type: "varchar",
        nullable: true,
        key: "",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ];
    const result = makeResult(columns, [[1, "alice"]]);

    it("編集可能セルをダブルクリックして値を変更すると onSetCellEdit が呼ばれる", async () => {
      const user = userEvent.setup();
      const onSetCellEdit = vi.fn();
      const { container } = renderWithProviders(
        <ResultGrid
          result={result}
          editable
          tableColumns={tableColumns}
          onSetCellEdit={onSetCellEdit}
        />,
      );

      // 編集可能列 (name) のセル。PK 列 (id) は編集不可。
      const nameCell = container.querySelector("td.is-editable-cell") as HTMLElement;
      expect(nameCell).toBeTruthy();
      await user.dblClick(nameCell);

      const input = within(nameCell).getByRole("textbox");
      await user.clear(input);
      await user.type(input, "bob");
      // Enter で確定 → 親へ通知。
      await user.keyboard("{Enter}");

      // 行は配列インデックスではなく主キー由来の安定キーで識別される (#352)。
      expect(onSetCellEdit).toHaveBeenCalledWith(rowEditKey([1, "alice"], [0], 0), 1, "bob");
    });

    it("PK 列 (id) は編集不可セルにならない", () => {
      const { container } = renderWithProviders(
        <ResultGrid
          result={result}
          editable
          tableColumns={tableColumns}
          onSetCellEdit={() => {}}
        />,
      );
      // 編集可能セルは name の 1 つだけ (id は PK のため除外)。
      expect(container.querySelectorAll("td.is-editable-cell")).toHaveLength(1);
    });
  });
});

describe("editable-cell visual affordance (#349)", () => {
  it("GRID_CSS distinguishes editable cells with cursor + hover/active outline", () => {
    // 編集可能セルはテキストカーソル、ホバーで細いアクセントリング、編集中 (focus内)
    // で太いアクセントアウトラインを出す。読み取り専用/非編集セルは既定カーソル。
    const css = GRID_CSS as Record<string, { cursor?: string; outline?: string }>;
    expect(css["& td.is-editable-cell"]?.cursor).toBe("text");
    expect(
      css["& tbody td:not(.row-index):not(.col-filler):not(.grid-empty-cell)"]?.cursor,
    ).toBe("default");
    expect(css["& tbody tr td.is-editable-cell:hover"]?.outline).toContain("var(--accent)");
    expect(css["& td.is-editable-cell:focus-within"]?.outline).toContain("var(--accent)");
  });
});
