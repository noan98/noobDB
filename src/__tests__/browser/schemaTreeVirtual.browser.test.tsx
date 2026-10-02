// スキーマツリーの仮想化 (#1315) を実ブラウザで固定する。jsdom はレイアウトを持たず
// 窓の計算ができないため、描画行数・スクロール・窓の外の行へのキーボード移動は Chromium で測る。
import "../../App.css";
import { useState } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { ConnectionList } from "../../components/ConnectionList";
import type { ConnectionProfile, TableColumnInfo } from "../../api/tauri";
import type { TableRef } from "../../tableQuickAccess";
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

// ---- scrollMargin (リスト先頭の位置) の追従 (#1342) ----
// 位置の測定は「描画のたび」ではなく「きっかけのとき」だけ。上の層の開閉・クイックアクセスの増減・
// 密度 / フォント拡大のあとも、窓の計算 (どの行を描くか) がずれていないことを確かめる。
// 窓は overscan (12 行) ぶんだけ上下に余分な行を描く。位置が Δ ずれていると、ビューポートの上に
// ある描画行の数が 12 から Δ / 行高 だけ増減するので、それを検出する。

const OVERSCAN = 12;
const GROUP_A = "A-grp";

const mkProfile = (id: string, group: string | null): ConnectionProfile => ({ ...PROFILE, id, name: id, group });
// A-grp (上) に 4 つ、B-grp (下) にアクティブなプロファイル。A-grp の開閉でリストの位置が動く。
const GROUPED_PROFILES = [
  mkProfile("a1", GROUP_A),
  mkProfile("a2", GROUP_A),
  mkProfile("a3", GROUP_A),
  mkProfile("a4", GROUP_A),
  mkProfile("p-virtual", "B-grp"),
];

let setFavoritesExternally: (refs: TableRef[]) => void = () => {};

function Controlled({ profiles }: { profiles: ConnectionProfile[] }) {
  const [favorites, setFavorites] = useState<TableRef[]>([]);
  setFavoritesExternally = setFavorites;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "480px", width: "320px" }}>
      <ConnectionList
        profiles={profiles}
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
        favorites={favorites}
      />
    </div>
  );
}

async function renderControlled(profiles: ConnectionProfile[]) {
  await renderInBrowser(<Controlled profiles={profiles} />);
  await expect.poll(() => rowElement("profile:p-virtual")).not.toBeNull();
  await expect.poll(() => rowElement("db:appdb")).not.toBeNull();
  rowElement("db:appdb")!.click();
  await expect.poll(() => rowElement("tbl:appdb::t0001")).not.toBeNull();
}

/** 中ほどまでスクロールして、ビューポートの上に完全に隠れている描画行の数を返す。 */
async function rowsAboveViewport() {
  const box = scroller();
  box.scrollTop = box.scrollHeight / 2;
  await nextFrame();
  await nextFrame();
  await nextFrame();
  const top = box.getBoundingClientRect().top;
  // プロファイル / グループの行はリストの外 (スクロール要素の上の層) なので数えない。
  return treeItems().filter(
    (el) => el.dataset.treeKey?.startsWith("tbl:") && el.getBoundingClientRect().bottom <= top,
  ).length;
}

async function expectWindowAligned() {
  // 測り直しは ResizeObserver / rAF 経由なので、落ち着くまで待ってから測る。
  await expect.poll(async () => Math.abs((await rowsAboveViewport()) - OVERSCAN), { timeout: 3000 }).toBeLessThanOrEqual(2);
}

const toggleGroup = async (name: string) => {
  rowElement(`group:${name}`)!.click();
  await nextFrame();
};

afterEach(() => {
  const root = document.documentElement;
  root.style.removeProperty("--font-scale");
  root.removeAttribute("data-density");
});

test("上のグループを閉じて開いても、窓の位置がずれない", async () => {
  await renderControlled(GROUPED_PROFILES);
  await expectWindowAligned();
  scroller().scrollTop = 0;
  await nextFrame();
  const before = scroller().querySelector("[data-tree-key='db:appdb']")!.getBoundingClientRect().top;
  await toggleGroup(GROUP_A); // 閉じる (上の 4 行ぶんリストが上へ動く)
  await expect.poll(() => rowElement("profile:a1")).toBeNull();
  // 本当にリストが動いている (動かなければ、この試験は位置の追従を検証できない)。
  scroller().scrollTop = 0;
  await nextFrame();
  expect(before - scroller().querySelector("[data-tree-key='db:appdb']")!.getBoundingClientRect().top).toBeGreaterThan(60);
  await expectWindowAligned();
  await toggleGroup(GROUP_A); // 開く
  await expectWindowAligned();
});

test("アクティブなプロファイルを閉じて開き直しても、窓の位置がずれない", async () => {
  await renderControlled(GROUPED_PROFILES);
  await toggleGroup("B-grp");
  await toggleGroup("B-grp");
  await expect.poll(() => rowElement("db:appdb")).not.toBeNull();
  await expectWindowAligned();
});

test("クイックアクセス (お気に入り) の件数が増減しても、窓の位置がずれない", async () => {
  await renderControlled(GROUPED_PROFILES);
  setFavoritesExternally(Array.from({ length: 5 }, (_, i) => ({ database: "appdb", table: `t${String(i + 1).padStart(4, "0")}` })));
  await expect.poll(() => treeItems().some((el) => el.dataset.treeKey?.startsWith("qa:favorite:"))).toBe(true);
  await expectWindowAligned();
  setFavoritesExternally([]);
  await expect.poll(() => treeItems().some((el) => el.dataset.treeKey?.startsWith("qa:favorite:"))).toBe(false);
  await expectWindowAligned();
});

test("密度とフォント拡大を変えても、窓の位置がずれない", async () => {
  await renderControlled(GROUPED_PROFILES);
  await expectWindowAligned();
  const root = document.documentElement;
  root.style.setProperty("--font-scale", String(24 / 14));
  root.setAttribute("data-density", "spacious");
  await expectWindowAligned();
  root.style.removeProperty("--font-scale");
  root.removeAttribute("data-density");
  await expectWindowAligned();
});
