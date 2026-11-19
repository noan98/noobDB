import { describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "./testUtils";
import { CellValueViewer } from "../components/CellValueViewer";
import { guideAccentLevels, treeGuideRowProps } from "../components/tree";
import { DEFAULT_TREE_GUIDES, getSettings } from "../settings";
import { t } from "../i18n";

describe("guideAccentLevels (#2452)", () => {
  // 0 a / 1 a1 / 2 a1x / 2 a1y / 1 a2 / 0 b / 1 b1
  const depths = [0, 1, 2, 2, 1, 0, 1];

  it("選択なしは全行 0", () => {
    expect(guideAccentLevels(depths, -1)).toEqual(depths.map(() => 0));
  });

  it("選択行の祖先の枝 (共有する祖先の数) だけを数える", () => {
    // a1y (index 3, 深さ 2) を選ぶ。
    expect(guideAccentLevels(depths, 3)).toEqual([0, 1, 2, 2, 1, 0, 0]);
  });

  it("別のルート配下の行や見出し (深さ -1) は枝の切れ目になる", () => {
    expect(guideAccentLevels([-1, 0, 1, 1, -1, 0, 1], 3)).toEqual([0, 0, 1, 1, 0, 0, 0]);
  });

  it("ルート行を選んだら線は無い", () => {
    expect(guideAccentLevels(depths, 0)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("treeGuideRowProps (#2452)", () => {
  it("段数とアクセント本数を CSS 変数で渡し、アクセントは段数を超えない", () => {
    const p = treeGuideRowProps(2, 5);
    expect(p.className).toBe("tree-guide-row");
    expect(p["data-guide-accent"]).toBe("");
    expect((p.style as Record<string, number>)["--tree-accent"]).toBe(2);
    expect(treeGuideRowProps(2, 0)["data-guide-accent"]).toBeUndefined();
  });
});

describe("設定 treeGuides (#2452)", () => {
  it("既定はオン", () => {
    expect(DEFAULT_TREE_GUIDES).toBe(true);
    expect(getSettings().treeGuides).toBe(true);
  });
});

describe("JSON ツリーのガイド線 (#2452)", () => {
  const DOC = '{"user":{"name":"Alice","tags":["dev"]},"n":1}';

  it("選択ノードの祖先のコンテナだけがアクセントの枝になる", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("jsonTreeExpandAll") }));
    const tree = screen.getByRole("tree");
    expect(tree.querySelectorAll(".tree-guide-group[data-guide-accent]").length).toBe(0);
    fireEvent.click(within(tree).getByText('"dev"'));
    // 選択した "dev" の祖先 (ルート / user / tags) の 3 つ。
    const accent = tree.querySelectorAll(".tree-guide-group[data-guide-accent]");
    expect(accent.length).toBe(3);
    expect(tree.querySelectorAll(".tree-guide-group").length).toBe(3);
  });
});
