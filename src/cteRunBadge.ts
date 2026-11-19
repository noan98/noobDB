import { CTE_TITLE_PREFIX } from "./cteRun";

/**
 * 「この CTE までを実行」(#2409) の直近の結果を、エディタの CTE 名の横へ行数バッジとして出すための純ロジック (#2450)。
 *
 * 単体実行は結果を新しいタブ (タイトルは `CTE: <名前>`) へ出す。そのタブの「実行した SQL」と行数を集め、
 * エディタ側は「いまの CTE を実行したら組み立てられる SQL」と見比べる。一致すれば最新、食い違えば
 * CTE (または依存する前段) を編集したあとなので stale (薄く) とする。
 */

export interface CteRunRecord {
  /** CTE の名前 (引用符なし)。 */
  name: string;
  /** そのとき実行した SQL (`buildCteRun` の `sql`)。 */
  sql: string;
  /** 結果の行数。 */
  rows: number;
}

/** `collectCteRuns` が読むタブの最小の形 (App の `Tab` を構造的に満たす)。 */
export interface CteRunTabLike {
  kind?: string;
  title: string;
  lastExecutedSql?: string | null;
  streaming?: boolean;
  queryError?: string | null;
  result: { rows: readonly unknown[] } | null;
}

const WITH_START = /^\s*WITH\b/i;

/** 開いているタブから、CTE 単体実行の結果 (完了済み・エラーなし) を新しい順ではなくタブ順で集める。 */
export function collectCteRuns(tabs: readonly CteRunTabLike[]): CteRunRecord[] {
  const out: CteRunRecord[] = [];
  for (const tab of tabs) {
    if (tab.kind !== undefined && tab.kind !== "query") continue;
    if (!tab.title.startsWith(CTE_TITLE_PREFIX)) continue;
    if (tab.streaming || tab.queryError || !tab.result) continue;
    const sql = tab.lastExecutedSql;
    if (!sql || !WITH_START.test(sql)) continue;
    const name = tab.title.slice(CTE_TITLE_PREFIX.length);
    if (name.length === 0) continue;
    out.push({ name, sql, rows: tab.result.rows.length });
  }
  return out;
}

/** 参照が変わっても中身が同じなら同じ扱い (ストア購読で不要な再描画を避ける)。 */
export function sameCteRuns(a: readonly CteRunRecord[], b: readonly CteRunRecord[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((r, i) => r.name === b[i]?.name && r.sql === b[i]?.sql && r.rows === b[i]?.rows))
  );
}

export interface CteBadge {
  rows: number;
  /** 実行後に CTE が編集された (または今は組み立てられない)。薄く表示する。 */
  stale: boolean;
  /** 行数が行数上限 (自動 LIMIT) に達している。実際はもっと多いかもしれないので「N+」と出す。 */
  truncated: boolean;
}

/**
 * CTE `name` のバッジ。`currentSql` は「いま実行したら組み立てられる SQL」(組み立てられなければ null)。
 * 同名の実行が複数あれば最後のもの。`limit` (自動 LIMIT の行数) 以上の行数は `truncated`。一度も実行していなければ null。名前は大文字小文字を区別しない。
 */
export function cteBadge(
  runs: readonly CteRunRecord[],
  name: string,
  currentSql: string | null,
  limit?: number | null,
): CteBadge | null {
  const key = name.toLowerCase();
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i] as CteRunRecord;
    if (r.name.toLowerCase() === key) {
      return {
        rows: r.rows,
        stale: currentSql === null || r.sql !== currentSql,
        truncated: !!limit && limit > 0 && r.rows >= limit,
      };
    }
  }
  return null;
}
