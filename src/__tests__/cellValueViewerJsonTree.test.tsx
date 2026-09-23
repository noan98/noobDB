import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "./testUtils";
import { CellValueViewer } from "../components/CellValueViewer";
import { t } from "../i18n";

/**
 * セルビューアの JSON ツリービュー (#1026)。ツリー表示が既定で出ること、64bit
 * 整数を丸めずに表示すること、テキスト表示とのトグル、ノード選択でパスが出ること、
 * 検索で一致の枝だけに絞られること、編集時の整形が数値を丸めないことを固定する。
 */
const DOC = '{"id":9007199254740993,"user":{"name":"Alice","tags":["admin","dev"]},"n":null}';

describe("CellValueViewer JSON tree (#1026)", () => {
  it("shows a tree by default without rounding 64-bit integers", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    const tree = screen.getByRole("tree", { name: t("jsonTreeAria") });
    expect(within(tree).getByText("9007199254740993")).toBeInTheDocument();
    expect(within(tree).queryByText("9007199254740992")).toBeNull();
    // ルートだけ展開済みで、ネストしたオブジェクトは畳まれている。
    expect(within(tree).queryByText('"Alice"')).toBeNull();
  });

  it("toggles to the text view, which is also lossless", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: t("cellViewerViewText") }));
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByText(/"id": 9007199254740993/)).toBeInTheDocument();
  });

  it("expands nodes and shows the selected node's path", () => {
    renderWithProviders(
      <CellValueViewer columnName="doc" value={DOC} isJson driver="postgres" onClose={() => {}} />,
    );
    const tree = screen.getByRole("tree");
    fireEvent.click(within(tree).getByText('"user"'));
    fireEvent.click(within(tree).getByText('"tags"'));
    fireEvent.click(within(tree).getByText('"dev"'));
    expect(screen.getByTestId("json-tree-selected-path").textContent).toBe("$.user.tags[1]");
    expect(screen.getByRole("button", { name: t("jsonTreeCopySqlWhere") })).toBeInTheDocument();
  });

  it("filters to matching branches while searching", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox", { name: t("jsonTreeSearchPlaceholder") }), {
      target: { value: "adm" },
    });
    const tree = screen.getByRole("tree");
    expect(within(tree).getByText('"admin"')).toBeInTheDocument();
    expect(within(tree).queryByText('"dev"')).toBeNull();
    expect(within(tree).queryByText("9007199254740993")).toBeNull();
    expect(screen.getByText(t("jsonTreeSearchCount", { count: 1 }))).toBeInTheDocument();
  });

  it("keeps plain text values in the existing text view", () => {
    renderWithProviders(<CellValueViewer columnName="c" value="hello" onClose={() => {}} />);
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("edit-mode Minify does not round big integers", () => {
    const onSave = vi.fn();
    renderWithProviders(
      <CellValueViewer columnName="doc" value={DOC} isJson editable onSave={onSave} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("cellViewerEdit") }));
    fireEvent.click(screen.getByRole("button", { name: t("cellViewerMinify") }));
    fireEvent.click(screen.getByRole("button", { name: t("cellViewerSave") }));
    expect(onSave).toHaveBeenCalledWith(DOC);
  });
});
