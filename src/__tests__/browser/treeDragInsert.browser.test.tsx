// スキーマツリー行 → SQL エディタの HTML5 ドラッグ&ドロップ挿入 (#1414) を実 Chromium で通す。
// jsdom では (1) framer-motion の並べ替えドラッグ (pointer) とネイティブ dragstart が
// 干渉しないこと、(2) CodeMirror の既定ドロップと二重挿入にならないこと、
// (3) 座標 → キャレット位置の変換 (posAtCoords) を確かめられないため。
import "../../App.css";
import { expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
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

test("テーブル行をエディタへドラッグ&ドロップすると SELECT 雛形が 1 回だけ入る", async () => {
  const onReorderProfiles = vi.fn();
  const profile = makeProfile({ id: "p-a", name: "Alpha DB" });
  const screen = await renderInBrowser(
    <div style={{ display: "flex", gap: "8px", height: "480px" }}>
      <div style={{ width: "280px" }}>
        <ConnectionList
          profiles={[profile]}
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
  await screen.getByRole("treeitem", { name: "db1" }).click();
  const row = screen.getByRole("treeitem", { name: "tbl1" });
  await expect.element(row).toBeVisible();
  const content = document.querySelector(".cm-content") as HTMLElement;
  await userEvent.dragAndDrop(row, screen.getByRole("textbox").first());
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  await expect.poll(() => view?.state.doc.toString()).toBe("SELECT * FROM `db1`.`tbl1`");
  expect(content).toBeTruthy();
  expect(onReorderProfiles).not.toHaveBeenCalled();
});
