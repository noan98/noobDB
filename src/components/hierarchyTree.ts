// 結果ビューの「階層」表示 (#2410) の純ロジック。
//
// 自己参照 FK (論理リレーション #2356 を含む) や、任意の結果の「ID 列 / 親 ID 列」から、取得済みの行だけで
// 木を組み立てる。DOM・IPC には触れないので Vitest で境界 (孤児・循環・重複 ID・大量行) を固定できる。
//
// - 木の構築・展開順の平坦化はすべて反復 (再帰なし)。数万行・深さ数万の鎖でもスタックを溢れさせない。
// - 親が結果に無い行は「範囲外」グループ、親をたどると自分に戻る行は「循環」グループに分ける。
//   循環は各サイクルの代表 1 行 (行番号が最小) を根として切り離して表示するので、無限ループにならない。
// - 部分木をサーバから取る SQL (`WITH RECURSIVE`、深さ上限・LIMIT つき) もここで作る。識別子のクオートと
//   値のリテラル化は既存の `quoteIdentFor` / `rowValueLiteral` を使う。

import type { CellValue, Column, TableColumnInfo } from "../api/tauri";
import type { ServerVersion } from "./statsAdvisor";
import { rowValueLiteral } from "./cellEdit";
import { qualifiedTableName, quoteIdentFor } from "./sqlDialect";

/** 部分木取得 SQL の既定の深さ上限 (根を 0 とした再帰の段数)。 */
export const HIERARCHY_SUBTREE_DEFAULT_DEPTH = 10;
/** 深さ上限の許容範囲。 */
export const HIERARCHY_SUBTREE_MAX_DEPTH = 100;
/** 部分木取得 SQL の LIMIT の既定値 (自動 LIMIT が無効なときに使う)。 */
export const HIERARCHY_SUBTREE_DEFAULT_LIMIT = 1000;
/** 木の行の字下げに使う最大段数。これより深い行は同じ字下げで描く (深い鎖で横にはみ出さない)。 */
export const HIERARCHY_INDENT_MAX_LEVELS = 12;
/** 1 回に描画する行数の上限。超える分は「さらに表示」で段階的に足す (全展開しても固まらない)。 */
export const HIERARCHY_RENDER_PAGE = 500;

/** 木の根の分類。 */
export type HierarchyGroup = "root" | "orphan" | "cycle";

export interface HierarchyNode {
  /** 結果の行インデックス。 */
  row: number;
  /** 親 (結果内の行インデックス)。根・孤児・循環の代表は null。 */
  parent: number | null;
  /** 直接の子 (行インデックス、結果の並び順)。 */
  children: number[];
  /** 根からの深さ (根 = 0)。 */
  depth: number;
  /** 自分を除く子孫の数。 */
  descendants: number;
  /** 親をたどると自分に戻る (自己参照を含む) 行か。 */
  inCycle: boolean;
  /** どのグループの木に属するか。 */
  group: HierarchyGroup;
}

export interface HierarchyModel {
  /** 行インデックス順のノード。 */
  nodes: HierarchyNode[];
  /** 通常の根 (親が NULL の行)。 */
  roots: number[];
  /** 親が結果に無い行 (「親が範囲外」)。 */
  orphans: number[];
  /** 循環ごとの代表 1 行。 */
  cycles: number[];
  /** 循環に含まれる行の総数。 */
  cycleRowCount: number;
  /** 子を持つ行 (展開できる行) の数。 */
  expandable: number;
}

function keyOf(v: CellValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * 行から木を組み立てる。`idIdx` が ID 列、`parentIdx` が親 ID 列の添字。
 * ID が重複するときは最初の行が親として選ばれる (後続の同 ID 行は子を持たない)。
 * ID が NULL の行は誰の親にもなれない (根・孤児・循環として扱うことは可能)。
 */
export function buildHierarchy(
  rows: readonly (readonly CellValue[])[],
  idIdx: number,
  parentIdx: number,
): HierarchyModel {
  const n = rows.length;
  const idToRow = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = keyOf(rows[i][idIdx]);
    if (k !== null && !idToRow.has(k)) idToRow.set(k, i);
  }

  // 親ポインタ: -1 = 親なし (NULL)、-2 = 親が結果に無い (孤児)、>= 0 = 親の行。
  const parentRow = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const pk = keyOf(rows[i][parentIdx]);
    if (pk === null) parentRow[i] = -1;
    else parentRow[i] = idToRow.get(pk) ?? -2;
  }

  // 循環の検出。各行の親は高々 1 つ (関数グラフ) なので、色分けしながら親をたどれば全体で O(n)。
  // state: 0 = 未訪問、1 = いまの経路上、2 = 確定。経路上の行に再び当たったらその区間が循環。
  const state = new Uint8Array(n);
  const inCycle = new Uint8Array(n);
  const path: number[] = [];
  for (let start = 0; start < n; start++) {
    if (state[start] !== 0) continue;
    path.length = 0;
    let cur = start;
    while (cur >= 0 && state[cur] === 0) {
      state[cur] = 1;
      path.push(cur);
      cur = parentRow[cur];
    }
    if (cur >= 0 && state[cur] === 1) {
      // `cur` から path の末尾までが 1 周分の循環。
      const at = path.lastIndexOf(cur);
      for (let j = at; j < path.length; j++) inCycle[path[j]] = 1;
    }
    for (const p of path) state[p] = 2;
  }

  // 循環の代表 (各サイクルの最小行) を根として切り離す。代表の親辺だけを除けば、サイクルは木になる。
  const cycleReps: number[] = [];
  const seenCycle = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inCycle[i] || seenCycle[i]) continue;
    // i は未訪問のサイクルの最小行 (昇順に走査しているので最初に当たる行が最小)。
    cycleReps.push(i);
    let cur = i;
    while (!seenCycle[cur]) {
      seenCycle[cur] = 1;
      cur = parentRow[cur];
    }
  }
  const isRep = new Uint8Array(n);
  for (const r of cycleReps) isRep[r] = 1;

  const nodes: HierarchyNode[] = new Array(n);
  for (let i = 0; i < n; i++) {
    nodes[i] = {
      row: i,
      parent: null,
      children: [],
      depth: 0,
      descendants: 0,
      inCycle: !!inCycle[i],
      group: "root",
    };
  }
  const roots: number[] = [];
  const orphans: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = parentRow[i];
    if (isRep[i]) continue;
    if (p === -1) roots.push(i);
    else if (p === -2) orphans.push(i);
    else {
      nodes[i].parent = p;
      nodes[p].children.push(i);
    }
  }

  // 深さとグループを、根ごとの反復走査で決める。
  const order: number[] = [];
  const walk = (top: number, group: HierarchyGroup) => {
    const stack = [top];
    nodes[top].depth = 0;
    nodes[top].group = group;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      order.push(cur);
      for (const c of nodes[cur].children) {
        nodes[c].depth = nodes[cur].depth + 1;
        nodes[c].group = group;
        stack.push(c);
      }
    }
  };
  for (const r of roots) walk(r, "root");
  for (const o of orphans) walk(o, "orphan");
  for (const c of cycleReps) walk(c, "cycle");

  // 子孫数: 走査順の逆 (子が先) に親へ積み上げる。
  for (let k = order.length - 1; k >= 0; k--) {
    const node = nodes[order[k]];
    if (node.parent !== null) nodes[node.parent].descendants += node.descendants + 1;
  }

  let cycleRowCount = 0;
  let expandable = 0;
  for (let i = 0; i < n; i++) {
    if (inCycle[i]) cycleRowCount++;
    if (nodes[i].children.length > 0) expandable++;
  }
  return { nodes, roots, orphans, cycles: cycleReps, cycleRowCount, expandable };
}

/** 表示中の 1 行。 */
export interface HierarchyVisibleRow {
  row: number;
  depth: number;
}

/**
 * 展開状態から、画面に出す行を上から順に平坦化する。`tops` は表示する根の列 (グループごと)、`expanded`
 * は展開中の行インデックス。`limit` 行に達したら打ち切る (`truncated` を返す)。反復実装。
 */
export function flattenVisible(
  model: HierarchyModel,
  tops: readonly number[],
  expanded: ReadonlySet<number>,
  limit = Number.POSITIVE_INFINITY,
): { rows: HierarchyVisibleRow[]; truncated: boolean } {
  const out: HierarchyVisibleRow[] = [];
  const stack: number[] = [];
  for (let i = tops.length - 1; i >= 0; i--) stack.push(tops[i]);
  while (stack.length > 0) {
    if (out.length >= limit) return { rows: out, truncated: true };
    const cur = stack.pop() as number;
    const node = model.nodes[cur];
    out.push({ row: cur, depth: node.depth });
    if (expanded.has(cur)) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return { rows: out, truncated: false };
}

/** 子を持つ全行 (全展開用)。`under` を渡すとその行の部分木に限る。 */
export function expandableRows(model: HierarchyModel, under?: number): Set<number> {
  const out = new Set<number>();
  if (under === undefined) {
    for (const node of model.nodes) if (node.children.length > 0) out.add(node.row);
    return out;
  }
  const stack = [under];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const node = model.nodes[cur];
    if (node.children.length > 0) out.add(cur);
    for (const c of node.children) stack.push(c);
  }
  return out;
}

/** 行 `row` を画面に出すために開く必要のある祖先 (根側から順ではなく集合)。 */
export function ancestorsOf(model: HierarchyModel, row: number): number[] {
  const out: number[] = [];
  let cur = model.nodes[row]?.parent ?? null;
  // 親ポインタは循環を切ってあるので必ず終わるが、念のため行数で打ち切る。
  let guard = model.nodes.length;
  while (cur !== null && guard-- > 0) {
    out.push(cur);
    cur = model.nodes[cur].parent;
  }
  return out;
}

// --- 列の決定 ----------------------------------------------------------------

/** 階層の列指定。列名で持つ (結果の列順が変わっても保てる)。 */
export interface HierarchyColumns {
  idCol: string;
  parentCol: string;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `schema.table` / 引用符つきの参照を、比較用のテーブル名へ寄せる。 */
function bareTable(name: string): string {
  const last = name.split(".").pop() ?? name;
  return last.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase();
}

/**
 * 自己参照 FK から階層の列を決める。`columnMeta` の列に `referenced_table` が `table` 自身を指すものがあれば、
 * その列が親 ID 列、参照先の列 (無ければ PK 列) が ID 列。論理リレーション (#2356) は `referenced_table` に
 * マージ済みなので宣言 FK と同じに扱う。結果にその列が無ければ null。
 */
export function detectSelfReference(
  resultColumns: readonly Column[],
  columnMeta: readonly TableColumnInfo[] | null | undefined,
  table: string | null | undefined,
): HierarchyColumns | null {
  if (!table || !columnMeta) return null;
  const inResult = (name: string) => resultColumns.find((c) => sameName(c.name, name))?.name ?? null;
  const self = bareTable(table);
  const pkCols = columnMeta.filter((m) => m.key === "PRI");
  for (const m of columnMeta) {
    if (!m.referenced_table || bareTable(m.referenced_table) !== self) continue;
    const parentCol = inResult(m.name);
    if (!parentCol) continue;
    const idName = m.referenced_column ?? (pkCols.length === 1 ? pkCols[0].name : null);
    const idCol = idName ? inResult(idName) : null;
    if (idCol && !sameName(idCol, parentCol)) return { idCol, parentCol };
  }
  return null;
}

const PARENT_COLUMN_RE = /^(parent(_?id)?|.*_parent_id|parent_.*_id|parentid)$/i;

/**
 * 自己参照 FK が分からない任意の結果で、列名から ID / 親 ID を推測する (`id` + `parent_id` など)。
 * 当てにならないときは null を返し、利用者に選んでもらう。
 */
export function guessHierarchyColumns(resultColumns: readonly Column[]): HierarchyColumns | null {
  const parent = resultColumns.find((c) => PARENT_COLUMN_RE.test(c.name));
  if (!parent) return null;
  const id =
    resultColumns.find((c) => c.name.toLowerCase() === "id") ??
    resultColumns.find((c) => c.name.toLowerCase().endsWith("_id") && c.name !== parent.name);
  return id && id.name !== parent.name ? { idCol: id.name, parentCol: parent.name } : null;
}

/** 表示ラベルの既定列: 名前らしい文字列列 (`name` / `title` / `label`) を優先し、無ければ ID 列。 */
export function defaultLabelColumn(resultColumns: readonly Column[], idCol: string): string {
  const preferred = ["name", "title", "label", "subject", "display_name", "slug"];
  for (const p of preferred) {
    const hit = resultColumns.find((c) => c.name.toLowerCase() === p);
    if (hit) return hit.name;
  }
  return idCol;
}

// --- 永続化する設定 ------------------------------------------------------------

export interface HierarchyConfig extends HierarchyColumns {
  labelCol: string;
}

/** 保存値を結果の列に照らして検証する。列が見つからなければ null (呼び出し側が既定へ戻す)。 */
export function sanitizeHierarchyConfig(raw: unknown, columns: readonly Column[]): HierarchyConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const has = (v: unknown): v is string => typeof v === "string" && columns.some((c) => c.name === v);
  if (!has(o.idCol) || !has(o.parentCol) || o.idCol === o.parentCol) return null;
  return { idCol: o.idCol, parentCol: o.parentCol, labelCol: has(o.labelCol) ? o.labelCol : o.idCol };
}

/** 保存済みの階層設定を読む。キーが無い / 壊れている / 列が合わないときは null (private mode にも耐える)。 */
export function readStoredHierarchyConfig(
  key: string | undefined,
  columns: readonly Column[],
): HierarchyConfig | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : sanitizeHierarchyConfig(JSON.parse(raw), columns);
  } catch {
    return null;
  }
}

/** 階層設定を保存する。キー無し (SQL 未実行) のときは何もしない。 */
export function writeStoredHierarchyConfig(key: string | undefined, config: HierarchyConfig): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(config));
  } catch {
    // ignore (private mode, quota)
  }
}

// --- 部分木の取得 SQL ------------------------------------------------------------

/** 深さ上限を許容範囲へ丸める。 */
export function clampSubtreeDepth(n: number): number {
  if (!Number.isFinite(n)) return HIERARCHY_SUBTREE_DEFAULT_DEPTH;
  return Math.min(HIERARCHY_SUBTREE_MAX_DEPTH, Math.max(1, Math.trunc(n)));
}

/**
 * 部分木取得 (`WITH RECURSIVE`) が使えるか。MySQL は 8.0 以降 (MariaDB は 10.2 以降)。版が分からないときは塞がない
 * (非対応ならサーバがエラーを返す)。PostgreSQL / SQLite は常に使える。
 */
export function supportsRecursiveCte(driver: string, version: ServerVersion | null): boolean {
  if (driver !== "mysql") return true;
  if (!version) return true;
  return version.mariadb
    ? version.major > 10 || (version.major === 10 && version.minor >= 2)
    : version.major >= 8;
}

export interface SubtreeSqlParams {
  driver: string;
  database?: string | null;
  table: string;
  idCol: string;
  parentCol: string;
  /** 部分木の根の ID 値。 */
  rootValue: CellValue;
  /** ID 列の型 (`Column.type_name`)。型付きリテラルにする。 */
  idType?: string;
  /** 再帰の深さ上限。 */
  maxDepth?: number;
  /** 返す行数の上限 (自動 LIMIT)。 */
  limit?: number;
}

/** 深さを入れる追加列名。テーブルの列と衝突しにくい名前にする。 */
export const SUBTREE_DEPTH_COLUMN = "__depth";

/**
 * 根の ID から子孫をたどる再帰 CTE。深さ上限 (`maxDepth`) で循環していても必ず止まり、末尾の LIMIT で行数も抑える。
 * 結果は元のテーブルの列 + 深さ (`__depth`)。
 */
export function buildSubtreeSql(p: SubtreeSqlParams): string {
  const q = (s: string) => quoteIdentFor(p.driver, s);
  const depth = clampSubtreeDepth(p.maxDepth ?? HIERARCHY_SUBTREE_DEFAULT_DEPTH);
  const limit = Math.max(1, Math.trunc(p.limit ?? HIERARCHY_SUBTREE_DEFAULT_LIMIT));
  const tbl = qualifiedTableName(p.driver, p.database, p.table);
  const rootLit = rowValueLiteral(p.driver, p.rootValue, { name: p.idCol, type_name: p.idType ?? "" });
  const d = q(SUBTREE_DEPTH_COLUMN);
  return [
    "WITH RECURSIVE subtree AS (",
    `  SELECT t.*, 0 AS ${d} FROM ${tbl} t WHERE t.${q(p.idCol)} = ${rootLit}`,
    "  UNION ALL",
    `  SELECT c.*, subtree.${d} + 1 FROM ${tbl} c JOIN subtree ON c.${q(p.parentCol)} = subtree.${q(p.idCol)}`,
    `  WHERE subtree.${d} < ${depth}`,
    ")",
    `SELECT * FROM subtree ORDER BY ${d} LIMIT ${limit}`,
  ].join("\n");
}
