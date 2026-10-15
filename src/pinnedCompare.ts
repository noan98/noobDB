// 結果セットのピン留め / 並列比較 (#622) の純ロジック。
//
// 任意の結果セットを破棄せず保持し (メモリ・上限あり)、2 つを並べて見比べる。
// 同一カラム構成の 2 結果は `resultDiff.ts` の PK ペアリングで行差分をハイライト
// できる (比較ビューがキー列を選んで再利用する)。ここは保持・比較可否判定の
// 副作用なし純ロジックで、UI (`PinnedComparisonView.tsx`) と分離してテストする。

import type { CellValue, Column } from "./api/tauri";

/** メモリに保持するピン留め結果 1 件 (結果セットのスナップショット)。 */
export interface PinnedResult {
  id: string;
  /** ピン留め時のタブタイトル等 (一覧での識別用)。 */
  title: string;
  /** 実行した SQL (比較時のコンテキスト表示用)。 */
  sql: string;
  columns: Column[];
  rows: CellValue[][];
  rowsAffected: number;
  elapsedMs: number;
  /** ピン留めした時刻 (ms)。古い順の破棄に使う。 */
  pinnedAt: number;
}

/** メモリ肥大を防ぐ保持上限。超過分は古いものから破棄する。 */
export const MAX_PINNED = 6;

/**
 * 行差分の既定キー列を選ぶ。両方の結果で「全行の値が非 NULL かつ重複なし」の最初の列。
 * 一意でない列をキーにすると重複キーの行が同じ前回行とペアリングされ、同一データでも
 * 変更・削除が出てしまう。一意な列が無ければ先頭列 (ユーザーが手動で選び直す前提)。
 */
export function defaultKeyColumn(
  left: { columns: Column[]; rows: CellValue[][] },
  right: { rows: CellValue[][] },
): string | null {
  const unique = (rows: CellValue[][], idx: number): boolean => {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = r[idx];
      if (v === null || v === undefined) return false;
      const k = String(v);
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  };
  for (let i = 0; i < left.columns.length; i++) {
    if (unique(left.rows, i) && unique(right.rows, i)) return left.columns[i].name;
  }
  return left.columns[0]?.name ?? null;
}

/**
 * 2 つの結果が行差分を取れる「同一カラム構成」か。列数とすべての列名 (順序込み) が
 * 一致するときだけ true。空 (列なし) は比較不能として false。
 */
export function resultsComparable(a: { columns: Column[] }, b: { columns: Column[] }): boolean {
  if (a.columns.length === 0 || a.columns.length !== b.columns.length) return false;
  return a.columns.every((c, i) => c.name === b.columns[i].name);
}

/**
 * ピン留め一覧に 1 件追加する。上限 `max` を超えたら**古いものから**破棄する
 * (一覧は古い→新しいの順)。元配列は変更しない。
 */
export function addPinned(list: PinnedResult[], item: PinnedResult, max = MAX_PINNED): PinnedResult[] {
  return addPinnedWithEvicted(list, item, max).list;
}

/**
 * {@link addPinned} と同じ追加を行い、上限超過で外れた項目も返す (#1532)。
 * どの結果が消えたかをトーストで明示するために使う。
 */
export function addPinnedWithEvicted(
  list: PinnedResult[],
  item: PinnedResult,
  max = MAX_PINNED,
): { list: PinnedResult[]; evicted: PinnedResult[] } {
  const next = [...list, item];
  if (next.length <= max) return { list: next, evicted: [] };
  const cut = next.length - max;
  return { list: next.slice(cut), evicted: next.slice(0, cut) };
}

/** ピン直後のトーストの内容 (#1277)。 */
export interface PinToastPlan {
  messageKey: "pinToastCompare" | "pinToastNeedOneMore";
  /** 「比較を開く」アクションを付けるか。 */
  showOpenAction: boolean;
}

/**
 * ピン留め後のトーストを決める。比較は 2 件そろって初めて成立するので、
 * 2 件未満はアクションを出さず「もう 1 件ピンすると比較できます」と案内する。
 */
export function pinToastPlan(pinnedCount: number): PinToastPlan {
  return pinnedCount >= 2
    ? { messageKey: "pinToastCompare", showOpenAction: true }
    : { messageKey: "pinToastNeedOneMore", showOpenAction: false };
}

/** 2 つの結果の列を列名で対応づけた結果 (#1625)。 */
export interface ColumnMapping {
  /** 両側にある列の名前。左の列順。 */
  shared: string[];
  /** `shared` と同じ順の、左の列位置。 */
  leftIndices: number[];
  /** `shared` と同じ順の、右の列位置。 */
  rightIndices: number[];
  /** 左にだけある列名 (比較の対象外)。 */
  leftOnly: string[];
  /** 右にだけある列名 (比較の対象外)。 */
  rightOnly: string[];
  /** 同じ名前の列が片側に複数あり、対応づけられない列名 (比較の対象外)。 */
  ambiguous: string[];
  /** 列の数・名前・順序が完全に一致する (射影しなくてよい)。 */
  exact: boolean;
}

/**
 * 列名で 2 つの結果の列を対応づける (#1625)。SELECT の列順を変えた、あるいは片方に
 * 列が増減した結果同士でも比べられるようにするための対応表。
 *
 * - 同じ名前が片側に複数ある列 (JOIN の `a.id, b.id` など) は、どれと対応するか決められない
 *   ので `ambiguous` に回して対象外にする (誤って組むより外す)。
 * - 比較は `shared` の列だけで行う。片方にだけある列は差分表示の対象外 (`leftOnly` / `rightOnly`)。
 */
export function mapColumnsByName(a: { columns: Column[] }, b: { columns: Column[] }): ColumnMapping {
  const countNames = (cols: Column[]) => {
    const m = new Map<string, number>();
    for (const c of cols) m.set(c.name, (m.get(c.name) ?? 0) + 1);
    return m;
  };
  const ca = countNames(a.columns);
  const cb = countNames(b.columns);
  const ambiguous = new Set<string>();
  for (const [n, k] of ca) if (k > 1) ambiguous.add(n);
  for (const [n, k] of cb) if (k > 1) ambiguous.add(n);

  const shared: string[] = [];
  const leftIndices: number[] = [];
  const rightIndices: number[] = [];
  const leftOnly: string[] = [];
  a.columns.forEach((c, i) => {
    if (ambiguous.has(c.name)) return;
    const j = b.columns.findIndex((d) => d.name === c.name);
    if (j < 0) {
      leftOnly.push(c.name);
      return;
    }
    shared.push(c.name);
    leftIndices.push(i);
    rightIndices.push(j);
  });
  const rightOnly = b.columns.filter((c) => !ambiguous.has(c.name) && !ca.has(c.name)).map((c) => c.name);
  const exact =
    ambiguous.size === 0 &&
    a.columns.length > 0 &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => c.name === b.columns[i].name);
  return { shared, leftIndices, rightIndices, leftOnly, rightOnly, ambiguous: [...ambiguous], exact };
}

/**
 * 列名で対応づけて比較できるか (#1625)。対応づけられる列が 1 つ以上あれば true。
 * 列順や列の集合が違っても比べられるので、{@link resultsComparable} (列数・列名・順序が
 * 完全一致) より広い。
 */
export function resultsComparableByName(a: { columns: Column[] }, b: { columns: Column[] }): boolean {
  return mapColumnsByName(a, b).shared.length > 0;
}

/**
 * 対応表に従って、左右の結果を共通の列だけ・同じ列順 (左の列順) へ射影する (#1625)。
 * 完全一致 (`exact`) のときは何もせず元のまま返す。
 */
export function alignResultsByName<T extends { columns: Column[]; rows: CellValue[][] }>(
  left: T,
  right: T,
  mapping: ColumnMapping,
): { left: T; right: T } {
  if (mapping.exact) return { left, right };
  const project = (r: T, indices: number[]): T => ({
    ...r,
    columns: indices.map((i) => r.columns[i]),
    rows: r.rows.map((row) => indices.map((i) => row[i] ?? null)),
  });
  return {
    left: project(left, mapping.leftIndices),
    right: project(right, mapping.rightIndices),
  };
}

/**
 * キー列で行を特定できるか (#1625)。`rows` の中で、キー (複数列なら組) の値が他の行と
 * 重なっている行の数と、NULL を含むキーの行数を返す。重複キーのまま差分を取ると、
 * 同じキーの行が同じ相手とペアリングされ、実際には差が無くても差分が出る (または見逃す)。
 */
export function keyUniqueness(
  rows: CellValue[][],
  keyIndices: number[],
): { duplicateRows: number; nullKeyRows: number } {
  if (keyIndices.length === 0) return { duplicateRows: 0, nullKeyRows: 0 };
  const counts = new Map<string, number>();
  let nullKeyRows = 0;
  const keys = rows.map((row) => {
    const vals = keyIndices.map((i) => row[i] ?? null);
    if (vals.some((v) => v === null)) nullKeyRows++;
    return JSON.stringify(vals.map((v) => (v === null ? null : String(v))));
  });
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  let duplicateRows = 0;
  for (const k of keys) if ((counts.get(k) ?? 0) > 1) duplicateRows++;
  return { duplicateRows, nullKeyRows };
}
