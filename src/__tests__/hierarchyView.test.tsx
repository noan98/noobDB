import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, chooseListboxOption, renderWithProviders, screen, waitFor } from "./testUtils";
import { HierarchyView } from "../components/HierarchyView";
import type { QueryResult, TableColumnInfo } from "../api/tauri";
import { resultViewKey } from "../components/resultViewKey";
import { setLocale, t } from "../i18n";
import { setColumnMaskEnabled, setColumnMaskPatterns } from "../settings";
import { DEFAULT_MASK_PATTERNS, MASK_PLACEHOLDER } from "../components/columnMask";

const result: QueryResult = {
  columns: [
    { name: "id", type_name: "INT" },
    { name: "parent_id", type_name: "INT" },
    { name: "name", type_name: "VARCHAR" },
  ],
  rows: [
    [1, null, "root"],
    [2, 1, "child"],
    [3, 2, "grandchild"],
    [4, 99, "lost"],
    [5, 6, "loop-a"],
    [6, 5, "loop-b"],
  ],
  rows_affected: 6,
  elapsed_ms: 1,
};
const meta = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: true,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});
const columnMeta = [
  meta("id", { key: "PRI" }),
  meta("parent_id", { referenced_table: "cats", referenced_column: "id" }),
];

describe("HierarchyView (#2410)", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
  });
  afterEach(() => {
    setColumnMaskEnabled(false);
    setColumnMaskPatterns([...DEFAULT_MASK_PATTERNS]);
  });

  it("自己参照 FK から列を決め、孤児と循環のグループを出して展開できる", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <HierarchyView
        result={result}
        driver="sqlite"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="SELECT * FROM cats"
        onChangeView={() => {}}
      />,
    );
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.queryByText("child")).not.toBeInTheDocument();
    expect(screen.getByText(t("hierarchyGroupOrphan", { n: 1 }))).toBeInTheDocument();
    expect(screen.getByText(t("hierarchyGroupCycle", { n: 2 }))).toBeInTheDocument();
    expect(screen.getAllByText(t("hierarchyCycleBadge")).length).toBe(1);
    await user.click(screen.getByText(t("hierarchyExpandAll")));
    expect(screen.getByText("grandchild")).toBeInTheDocument();
    expect(screen.getAllByText(t("hierarchyCycleBadge")).length).toBe(2);
    await user.click(screen.getByText(t("hierarchyCollapseAll")));
    expect(screen.queryByText("grandchild")).not.toBeInTheDocument();
  });

  it("列が決められない結果では選択を促し、設定を resultViewKey で永続化する", async () => {
    const plain: QueryResult = {
      ...result,
      columns: [
        { name: "a", type_name: "INT" },
        { name: "b", type_name: "INT" },
        { name: "c", type_name: "TEXT" },
      ],
    };
    renderWithProviders(
      <HierarchyView result={plain} driver="sqlite" sourceSql="SELECT 1" onChangeView={() => {}} />,
    );
    expect(screen.getByText(t("hierarchyPickTitle"))).toBeInTheDocument();
    // 保存済みの設定があれば復元される
    localStorage.setItem(
      resultViewKey("hierarchy", "SELECT 2") ?? "",
      JSON.stringify({ idCol: "a", parentCol: "b", labelCol: "c" }),
    );
    renderWithProviders(
      <HierarchyView result={plain} driver="sqlite" sourceSql="SELECT 2" onChangeView={() => {}} />,
    );
    await waitFor(() => expect(screen.getAllByRole("tree").length).toBe(1));
  });

  it("MySQL 5.7 では部分木の取得を無効にし、8.0 では SQL を渡す", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const lookup = vi.fn(async () => ({ columns: [], rows: [["5.7.44"]], rows_affected: 1, elapsed_ms: 1 }));
    const { unmount } = renderWithProviders(
      <HierarchyView
        result={result}
        driver="mysql"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="S"
        onChangeView={() => {}}
        onOpenQuery={open}
        onRunLookup={lookup}
      />,
    );
    await user.click(screen.getByText("root"));
    const btn = screen.getByRole("button", { name: t("hierarchySubtree") });
    await waitFor(() => expect(btn).toBeDisabled());
    unmount();
    lookup.mockResolvedValue({ columns: [], rows: [["8.0.34"]], rows_affected: 1, elapsed_ms: 1 });
    renderWithProviders(
      <HierarchyView
        result={result}
        driver="mysql"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="S"
        onChangeView={() => {}}
        onOpenQuery={open}
        onRunLookup={lookup}
      />,
    );
    await user.click(screen.getByText("root"));
    const btn2 = screen.getByRole("button", { name: t("hierarchySubtree") });
    await waitFor(() => expect(btn2).toBeEnabled());
    await user.click(btn2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toContain("WITH RECURSIVE");
    expect(open.mock.calls[0][0]).toContain("`id` = 1");
  });

  it("再描画しても版の確認 (lookup) は 1 回だけ", async () => {
    const lookup = vi.fn(async (_sql: string) => ({
      columns: [],
      rows: [["8.0.34"]],
      rows_affected: 1,
      elapsed_ms: 1,
    }));
    const props = {
      result,
      driver: "mysql",
      table: "cats",
      columnMeta,
      sourceSql: "S",
      onChangeView: () => {},
    };
    const { rerender } = renderWithProviders(<HierarchyView {...props} onRunLookup={(sql) => lookup(sql)} />);
    for (let i = 0; i < 3; i++) rerender(<HierarchyView {...props} onRunLookup={(sql) => lookup(sql)} />);
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("ID 列だけ選んでも親列は黙って決まらず、両方そろうまで木を作らない。同じ列は入れ替える", async () => {
    const plain: QueryResult = {
      ...result,
      columns: [
        { name: "a", type_name: "INT" },
        { name: "b", type_name: "INT" },
        { name: "c", type_name: "TEXT" },
      ],
    };
    renderWithProviders(
      <HierarchyView result={plain} driver="sqlite" sourceSql="SELECT 9" onChangeView={() => {}} />,
    );
    chooseListboxOption(screen.getByRole("combobox", { name: t("hierarchyIdCol") }), "a");
    expect(screen.getByText(t("hierarchyPickTitle"))).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    chooseListboxOption(screen.getByRole("combobox", { name: t("hierarchyParentCol") }), "a");
    // 同じ列を親にすると ID 欄と入れ替わる (ID は空に戻り、木は作られない)。
    expect(screen.getByRole("combobox", { name: t("hierarchyParentCol") })).toHaveTextContent("a");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    chooseListboxOption(screen.getByRole("combobox", { name: t("hierarchyIdCol") }), "b");
    await waitFor(() => expect(screen.getByRole("tree")).toBeInTheDocument());
  });

  it("メタデータが後から届いたら、未操作なら自己参照の自動判定へ追従する", async () => {
    const plain: QueryResult = {
      ...result,
      columns: [
        { name: "k", type_name: "INT" },
        { name: "up", type_name: "INT" },
        { name: "name", type_name: "TEXT" },
      ],
      rows: [[1, null, "r"]],
    };
    const props = {
      result: plain,
      driver: "sqlite",
      table: "t",
      sourceSql: "SELECT m",
      onChangeView: () => {},
    };
    const { rerender } = renderWithProviders(<HierarchyView {...props} columnMeta={null} />);
    expect(screen.getByText(t("hierarchyPickTitle"))).toBeInTheDocument();
    rerender(
      <HierarchyView
        {...props}
        columnMeta={[
          meta("k", { key: "PRI" }),
          meta("up", { referenced_table: "t", referenced_column: "k" }),
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByRole("tree")).toBeInTheDocument());
  });

  it("全折りたたみで選択行が隠れても、先頭の行が Tab の入口 (tabindex=0) になり、フォーカスで選択される", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <HierarchyView
        result={result}
        driver="sqlite"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="S"
        onChangeView={() => {}}
      />,
    );
    await user.click(screen.getByText(t("hierarchyExpandAll")));
    await user.click(screen.getByText("grandchild"));
    await user.click(screen.getByText(t("hierarchyCollapseAll")));
    const items = screen.getAllByRole("treeitem");
    expect(items[0]).toHaveAttribute("tabindex", "0");
    act(() => items[0].focus());
    expect(items[0]).toHaveAttribute("aria-selected", "true");
  });

  it("ID が NULL のノードでは部分木取得を無効にする", async () => {
    const user = userEvent.setup();
    const nullId: QueryResult = { ...result, rows: [[null, null, "anon"]] };
    renderWithProviders(
      <HierarchyView
        result={nullId}
        driver="sqlite"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="S"
        onChangeView={() => {}}
        onOpenQuery={() => {}}
      />,
    );
    await user.click(screen.getByText("anon"));
    expect(screen.getByRole("button", { name: t("hierarchySubtree") })).toBeDisabled();
  });

  it("マスクされた ID 列では部分木取得を無効にする", async () => {
    const user = userEvent.setup();
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(["id"]);
    renderWithProviders(
      <HierarchyView
        result={result}
        driver="sqlite"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="S"
        onChangeView={() => {}}
        onOpenQuery={() => {}}
      />,
    );
    await user.click(screen.getByText("root"));
    expect(screen.getByRole("button", { name: t("hierarchySubtree") })).toBeDisabled();
  });

  it("マスクされたラベル列は伏せ字で表示する", () => {
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(["name"]);
    renderWithProviders(
      <HierarchyView
        result={result}
        driver="sqlite"
        table="cats"
        columnMeta={columnMeta}
        sourceSql="S"
        onChangeView={() => {}}
      />,
    );
    expect(screen.queryByText("root")).not.toBeInTheDocument();
    expect(screen.getAllByText(MASK_PLACEHOLDER).length).toBeGreaterThan(0);
  });
});
