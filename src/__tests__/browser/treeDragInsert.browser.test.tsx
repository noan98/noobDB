// スキーマツリー行 → SQL エディタのポインタ操作ドラッグ挿入 (#1414) を実 Chromium で通す。
// HTML5 の D&D は Windows の WebView2 (OS ファイルのドロップ処理と排他) で動かないため使わない。
// jsdom では (1) framer-motion の並べ替えドラッグがテーブル行から起動しないこと、
// (2) 1 回だけ挿入されること、(3) 座標 → キャレット位置の変換 (posAtCoords /
// elementFromPoint) を確かめられないため、実ブラウザで pointerdown → move → up を通す。
import "../../App.css";
import { expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { ConnectionList } from "../../components/ConnectionList";
import { QueryEditor } from "../../components/QueryEditor";
import { makeProfile } from "../fixtures/componentFixtures";
import { renderInBrowser } from "./render";

vi.mock("../../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      loadSchemaTree: vi.fn(async (_sid: string, openDbs: string[], openKeys: string[]) => ({
        databases: ["db1"],
        open: openDbs.map((database) => ({
          database,
          tables: ["tbl1"],
          row_estimates: [],
          objects: [],
          comments: [],
        })),
        tables: openKeys.map((key) => ({ key, columns: [], indexes: [] })),
      })),
      listDatabases: vi.fn().mockResolvedValue(["db1"]),
      listTables: vi.fn().mockResolvedValue(["tbl1"]),
      tableRowEstimates: vi.fn().mockResolvedValue([]),
      listSchemaObjects: vi.fn().mockResolvedValue([]),
      describeTable: vi.fn().mockResolvedValue([]),
      listIndexes: vi.fn().mockResolvedValue([]),
    },
  };
});

const noop = () => {};

function setup(onReorderProfiles: () => void) {
  // 前のテストで開いた DB の展開状態 (schemaTreeState) を持ち越さない。
  try {
    localStorage.clear();
  } catch {
    // 無くても動く
  }
  // 並べ替えが起きないことを確かめるため、下に別の接続を置いておく。
  const profiles = [makeProfile({ id: "p-a", name: "Alpha DB" }), makeProfile({ id: "p-b", name: "Beta DB" })];
  return renderInBrowser(
    <div style={{ display: "flex", gap: "8px", height: "480px" }}>
      <div style={{ width: "280px" }}>
        <ConnectionList
          profiles={profiles}
          activeProfileId="p-a"
          sessionId="s1"
          connectingId={null}
          errorProfileId={null}
          onConnect={noop}
          onCreate={noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
          onPickTable={noop}
          onImportTable={noop}
          onDumpDatabase={noop}
          onRunTableSelect={noop}
          onInsertTableSelect={noop}
          onReorderProfiles={onReorderProfiles}
          selectLimit={200}
        />
      </div>
      <div style={{ flex: 1 }}>
        <QueryEditor onRun={noop} initialSql="" driver="mysql" />
      </div>
    </div>,
  );
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: 1,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    ...init,
  });
}

function center(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

test("テーブル行をポインタ操作でエディタへドラッグすると SELECT 雛形が 1 回だけ入り、並べ替えは起動しない", async () => {
  const onReorderProfiles = vi.fn();
  const screen = await setup(onReorderProfiles);
  await screen.getByRole("treeitem", { name: "db1" }).click();
  const rowLocator = screen.getByRole("treeitem", { name: "tbl1" });
  await expect.element(rowLocator).toBeVisible();
  const row = rowLocator.element();
  const editorEl = document.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(editorEl);
  const from = center(row);
  const to = center(editorEl);

  row.dispatchEvent(pointer("pointerdown", from.x, from.y));
  window.dispatchEvent(pointer("pointermove", from.x + 20, from.y));
  window.dispatchEvent(pointer("pointermove", to.x, to.y));
  // ドラッグ中はゴーストと挿入位置マーカーが出る。
  await expect.poll(() => document.querySelector('[data-testid="tree-drag-ghost"]') !== null).toBe(true);
  expect(document.querySelector(".cm-tree-drop-caret")).not.toBeNull();
  window.dispatchEvent(pointer("pointerup", to.x, to.y));

  await expect.poll(() => view?.state.doc.toString()).toBe("SELECT * FROM `db1`.`tbl1`");
  await expect.poll(() => document.querySelector('[data-testid="tree-drag-ghost"]')).toBeNull();
  expect(document.querySelector(".cm-tree-drop-caret")).toBeNull();
  expect(onReorderProfiles).not.toHaveBeenCalled();
});

test("エディタの外で離す / Esc でキャンセルすると何も挿入されない", async () => {
  const screen = await setup(vi.fn());
  await screen.getByRole("treeitem", { name: "db1" }).click();
  const rowLocator = screen.getByRole("treeitem", { name: "tbl1" });
  await expect.element(rowLocator).toBeVisible();
  const row = rowLocator.element();
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  const from = center(row);
  const to = center(document.querySelector(".cm-editor") as HTMLElement);

  // エディタ外 (ツリー上) で離す。
  row.dispatchEvent(pointer("pointerdown", from.x, from.y));
  window.dispatchEvent(pointer("pointermove", from.x + 30, from.y));
  window.dispatchEvent(pointer("pointerup", from.x + 30, from.y));
  // エディタ上まで運んだあと Esc。
  row.dispatchEvent(pointer("pointerdown", from.x, from.y));
  window.dispatchEvent(pointer("pointermove", to.x, to.y));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  window.dispatchEvent(pointer("pointerup", to.x, to.y));

  expect(view?.state.doc.toString()).toBe("");
});

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// framer-motion の Reorder は move を同期的に連続で送ると起動しないため、
// 各 move の前に 1 フレーム待つ。移動先は Beta 行の中心より 60px 下 (Alpha ノード全体が Beta を越える距離)。
async function dragToBelowBeta(source: Element, betaRow: Element) {
  const from = center(source);
  const to = center(betaRow);
  const dest = { x: to.x, y: to.y + 60 };
  source.dispatchEvent(pointer("pointerdown", from.x, from.y));
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await nextFrame();
    const x = from.x + ((dest.x - from.x) * i) / steps;
    const y = from.y + ((dest.y - from.y) * i) / steps;
    window.dispatchEvent(pointer("pointermove", x, y));
  }
  await nextFrame();
  window.dispatchEvent(pointer("pointerup", dest.x, dest.y));
  await nextFrame();
}

test("陽性対照: 接続行そのものを下へドラッグすると並べ替えが呼ばれる (テスト手段が有効であることの固定)", async () => {
  const onReorderProfiles = vi.fn();
  const screen = await setup(onReorderProfiles);
  const alpha = screen.getByText("Alpha DB").element();
  const betaRow = screen.getByText("Beta DB").element();
  await dragToBelowBeta(alpha, betaRow);
  expect(onReorderProfiles).toHaveBeenCalledTimes(1);
});

test("テーブル行を下の接続行までドラッグして離しても、接続の並べ替えは起きない", async () => {
  const onReorderProfiles = vi.fn();
  const screen = await setup(onReorderProfiles);
  await screen.getByRole("treeitem", { name: "db1" }).click();
  const rowLocator = screen.getByRole("treeitem", { name: "tbl1" });
  await expect.element(rowLocator).toBeVisible();
  const row = rowLocator.element();
  const editorEl = document.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(editorEl);
  const betaRow = screen.getByText("Beta DB").element();

  await dragToBelowBeta(row, betaRow);

  await expect.poll(() => document.querySelector('[data-testid="tree-drag-ghost"]')).toBeNull();
  expect(onReorderProfiles).not.toHaveBeenCalled();
  expect(view?.state.doc.toString()).toBe("");
});
