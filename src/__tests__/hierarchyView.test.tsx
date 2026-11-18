import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { HierarchyView } from "../components/HierarchyView";
import type { QueryResult, TableColumnInfo } from "../api/tauri";
import { resultViewKey } from "../components/resultViewKey";
import { setLocale, t } from "../i18n";

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
});
