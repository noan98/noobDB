// スキーマツリーの仮想化 (#1315) を実ブラウザで固定する。jsdom はレイアウトを持たず
// 窓の計算ができないため、描画行数・スクロール・窓の外の行へのキーボード移動は Chromium で測る。
import "../../App.css";
import { beforeEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { ConnectionList } from "../../components/ConnectionList";
import type { ConnectionProfile, TableColumnInfo } from "../../api/tauri";
import { renderInBrowser } from "./render";
import { installTauriMock, onCommand } from "./tauriMock";

const TABLE_COUNT = 2000;
/** 先頭文字ジャンプの検証用: ほかの全テーブルと先頭文字が違う、末尾のテーブル。 */
const LAST_TABLE = "zz_last";
const TABLES = [
  ...Array.from({ length: TABLE_COUNT - 1 }, (_, i) => `t${String(i + 1).padStart(4, "0")}`),
  LAST_TABLE,
];

const PROFILE: ConnectionProfile = {
  id: "p-virtual",
  name: "Virtual DB",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  database: "appdb",
  ssh: null,
  group: null,
  color: null,
  is_production: false,
  confirm_writes: false,
  read_only: false,
  skip_history: false,
  file_path: null,
};

const COLUMNS: TableColumnInfo[] = ["id", "name", "created_at"].map((name, i) => ({
  name,
  data_type: i === 0 ? "INT" : "VARCHAR(64)",
  nullable: i !== 0,
  key: i === 0 ? "PRI" : "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
}));

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  onCommand("list_databases", () => ["appdb"]);
  onCommand("list_tables", () => TABLES);
  onCommand("list_tables_all", () => [{ database: "appdb", tables: TABLES }]);
  onCommand("describe_table", () => COLUMNS);
  onCommand("list_indexes", () => []);
  onCommand("list_schema_objects", () => []);
  onCommand("list_table_comments", () => []);
  onCommand("table_row_estimates", () => TABLES.map((name) => ({ name, estimate: null })));
  onCommand("load_schema_tree", () => ({ databases: ["appdb"], open: [], tables: [] }));
});

const noop = () => {};

async function renderTree() {
  const screen = await renderInBrowser(
    <div style={{ display: "flex", flexDirection: "column", height: "480px", width: "320px" }}>
      <ConnectionList
        profiles={[PROFILE]}
        activeProfileId={PROFILE.id}
        sessionId="sess-virtual"
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
        selectLimit={200}
      />
    </div>,
  );
  await expect.poll(() => rowElement("db:appdb")).not.toBeNull();
  rowElement("db:appdb")!.click();
  await expect.poll(() => rowElement("tbl:appdb::t0001")).not.toBeNull();
  return screen;
}

const treeKeyOf = (el: Element | null) => (el as HTMLElement | null)?.dataset.treeKey ?? null;
const treeItems = () => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]"));
const scroller = () => document.querySelector<HTMLElement>("[role=tree]")!;
function rowElement(key: string): HTMLElement | null {
  return treeItems().find((el) => el.dataset.treeKey === key) ?? null;
}
const focusedKey = () => treeKeyOf(document.activeElement);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

test("テーブル 2,000 件でも、描画する行は窓の分だけで、総数は aria-setsize が持つ", async () => {
  await renderTree();
  const rendered = treeItems();
  // 480px の窓 + 上下の余白 (overscan) だけ。2,000 行がそのまま DOM にあれば fail。
  expect(rendered.length).toBeGreaterThan(5);
  expect(rendered.length).toBeLessThan(80);
  const first = rowElement("tbl:appdb::t0001")!;
  expect(first.getAttribute("aria-posinset")).toBe("1");
  expect(first.getAttribute("aria-setsize")).toBe(String(TABLE_COUNT));
  // スペーサーが全体の高さを持つので、スクロール量は 2,000 行ぶんある。
  expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight * 20);
});

test("スクロールすると窓が移り、描画行数は増えない", async () => {
  await renderTree();
  scroller().scrollTop = scroller().scrollHeight / 2;
  await expect
    .poll(() => treeItems().some((el) => Number(el.getAttribute("aria-posinset")) > 500))
    .toBe(true);
  expect(treeItems().length).toBeLessThan(80);
  expect(rowElement("tbl:appdb::t0001")).toBeNull();
});

test("どこへスクロールしても、見えている範囲は行で埋まる (スペーサーの計算が合っている)", async () => {
  await renderTree();
  const box = scroller();
  for (const ratio of [0, 0.25, 0.5, 0.9, 1]) {
    box.scrollTop = (box.scrollHeight - box.clientHeight) * ratio;
    await nextFrame();
    await nextFrame();
    const view = box.getBoundingClientRect();
    const rects = treeItems().map((el) => el.getBoundingClientRect());
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    // 窓の上端・下端 (ビューポート) に空白が出ていない。8px 以内なら、スクロール要素自体の
    // 上下の余白 (py) であって、描画漏れの行 (1 行 24px 以上) ではない。
    expect(top).toBeLessThanOrEqual(view.top + 8);
    expect(bottom).toBeGreaterThanOrEqual(view.bottom - 8);
  }
});

test("↑↓ で窓の外へ出る行まで移動してもフォーカスが落ちない", async () => {
  await renderTree();
  rowElement("tbl:appdb::t0001")!.focus();
  for (let i = 0; i < 60; i++) await userEvent.keyboard("{ArrowDown}");
  await expect.poll(focusedKey).toBe("tbl:appdb::t0061");
  expect(document.activeElement).toBe(rowElement("tbl:appdb::t0061"));
  for (let i = 0; i < 5; i++) await userEvent.keyboard("{ArrowUp}");
  await expect.poll(focusedKey).toBe("tbl:appdb::t0056");
});

test("End / Home は窓の外の端の行へ移る", async () => {
  await renderTree();
  rowElement("tbl:appdb::t0001")!.focus();
  await userEvent.keyboard("{End}");
  await expect.poll(focusedKey).toBe(`tbl:appdb::${LAST_TABLE}`);
  expect(treeItems().length).toBeLessThan(80);
  await userEvent.keyboard("{ArrowUp}");
  await expect.poll(focusedKey).toBe("tbl:appdb::t1999");
  await userEvent.keyboard("{Home}");
  await expect.poll(focusedKey).toBe(`profile:${PROFILE.id}`);
});

test("先頭文字ジャンプは窓の外の行へ移り、フォーカスが残る", async () => {
  await renderTree();
  rowElement("tbl:appdb::t0001")!.focus();
  await userEvent.keyboard("z");
  await expect.poll(focusedKey).toBe(`tbl:appdb::${LAST_TABLE}`);
  expect(document.activeElement).toBe(rowElement(`tbl:appdb::${LAST_TABLE}`));
});

test("フォーカス中の行は、窓の外までスクロールしてもアンマウントされない", async () => {
  await renderTree();
  const row = rowElement("tbl:appdb::t0001")!;
  row.focus();
  scroller().scrollTop = scroller().scrollHeight;
  await expect
    .poll(() => treeItems().some((el) => treeKeyOf(el) === `tbl:appdb::${LAST_TABLE}`))
    .toBe(true);
  await nextFrame();
  expect(row.isConnected).toBe(true);
  expect(document.activeElement).toBe(row);
});

test("→ でテーブルを開くと列の行が続き、← で閉じる", async () => {
  await renderTree();
  const row = rowElement("tbl:appdb::t0001")!;
  row.focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => rowElement("col:appdb::t0001:id")).not.toBeNull();
  expect(rowElement("col:appdb::t0001:id")!.getAttribute("aria-level")).toBe("4");
  // 開いている状態の → は最初の子の列へ移る。
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(focusedKey).toBe("col:appdb::t0001:id");
  // ← は親のテーブル行へ戻り、もう一度 ← で閉じる。
  await userEvent.keyboard("{ArrowLeft}");
  await expect.poll(focusedKey).toBe("tbl:appdb::t0001");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.poll(() => rowElement("col:appdb::t0001:id")).toBeNull();
});
