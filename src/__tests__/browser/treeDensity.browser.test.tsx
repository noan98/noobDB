// スキーマツリー行 (`TreeRow`) の縦余白が表示密度設定 (`data-density`) に追従する
// ことを実ブラウザで固定する (#1188)。jsdom はレイアウトを計算しないため、cell
// padding と同じく実 Chromium のブラウザモードで行高を測る。
import "../../App.css";
import { afterEach, expect, test } from "vitest";
import { Tree, TreeLabel, TreeRow } from "../../components/tree";
import { renderInBrowser } from "./render";

afterEach(() => {
  document.documentElement.removeAttribute("data-density");
});

function renderRow() {
  return renderInBrowser(
    <Tree role="tree">
      <TreeRow role="treeitem" tabIndex={0} data-testid="tree-row">
        <TreeLabel>dummy_table</TreeLabel>
      </TreeRow>
    </Tree>,
  );
}

async function rowHeight() {
  const screen = await renderRow();
  const row = screen.container.querySelector('[data-testid="tree-row"]');
  expect(row).not.toBeNull();
  return (row as HTMLElement).getBoundingClientRect().height;
}

test("compact 密度ではツリー行が既定より縮む", async () => {
  const normalHeight = await rowHeight();
  document.documentElement.setAttribute("data-density", "compact");
  const compactHeight = await rowHeight();
  expect(compactHeight).toBeLessThan(normalHeight);
});

test("spacious 密度ではツリー行が既定より広がる", async () => {
  const normalHeight = await rowHeight();
  document.documentElement.setAttribute("data-density", "spacious");
  const spaciousHeight = await rowHeight();
  expect(spaciousHeight).toBeGreaterThan(normalHeight);
});
