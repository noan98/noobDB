// 行削除 / TRUNCATE の前に、子テーブルで巻き込まれる (またはブロックする) 参照行数を
// 数えるための純ロジック (#1506)。
//
// 逆方向 FK (`incoming_foreign_keys`、単一列のみ) を材料に、子テーブルごとの
// `COUNT(*)` を 1 本の `UNION ALL` にまとめて `run_lookup_query` (読み取り専用・
// read_only でも可) へ流す。書き込み経路は増やさない。

import type { CellValue, QueryResult } from "./api/tauri";
import { rowEditKey, rowValueLiteral } from "./components/cellEdit";
import { quoteIdentFor } from "./components/sqlDialect";
import { type IncomingFk, qualifiedTable } from "./fkNavigation";

/** 参照先 (削除する行側) の 1 列あたりに数える値の最大数。超えた分は数えず `partial` にする。 */
export const REF_KEY_LIMIT = 2000;
/** 1 つの `IN (...)` に入れる値の数。 */
const IN_CHUNK = 500;
/** 1 クエリに束ねる UNION の枝の最大数。 */
const BRANCHES_PER_QUERY = 100;

/** 子テーブル 1 件分の影響。 */
export interface RefImpact {
  /** 参照先 (親) テーブル。複数テーブルの一括 TRUNCATE で区別するために持つ。 */
  parentTable?: string;
  /** 子テーブルのスキーマ (PostgreSQL のスキーマをまたぐ FK のみ、#1786)。 */
  schema?: string | null;
  table: string;
  column: string;
  referencedColumn: string;
  /** 正規化済みの ON DELETE (`NO ACTION` を含む)。 */
  onDelete: OnDeleteRule;
  /** 削除対象を参照している子行数。`capped` のときは `count` 以上 (数えるのを打ち切った)。 */
  count: number;
  /** TRUNCATE の集計で上限 (`TRUNCATE_COUNT_CAP`) に達し、実際はもっと多い。 */
  capped?: boolean;
}

/** TRUNCATE の子行数の集計上限。これを超える分は数えず「N 件以上」と表示する。 */
export const TRUNCATE_COUNT_CAP = 1000;

/** 参照先の列名 → 列の型名。バイナリ列や 64bit 整数列のリテラル化を型に合わせるために持つ。 */
export type KeyTypes = ReadonlyMap<string, string>;

function keyLiteral(driver: string, v: CellValue, name: string, types: KeyTypes | undefined): string {
  return rowValueLiteral(driver, v, { name, type_name: types?.get(name) ?? "" });
}

export type OnDeleteRule = "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION";

/** バックエンドの ON DELETE (`None` = 既定の NO ACTION) を表示用に揃える。 */
export function normalizeOnDelete(raw: string | null | undefined): OnDeleteRule {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "CASCADE" || v === "SET NULL" || v === "SET DEFAULT" || v === "RESTRICT") return v;
  return "NO ACTION";
}

/** ON DELETE が削除をブロックする (エラーにする) 規則か。 */
export function blocksDelete(rule: OnDeleteRule): boolean {
  return rule === "RESTRICT" || rule === "NO ACTION";
}

/** 値を JSON で一意化したキー。 */
function valueKey(v: CellValue): string {
  return typeof v === "string" ? `s:${v}` : `${typeof v}:${String(v)}`;
}

/**
 * 削除予定の行から、参照先の各列の値 (NULL は除く・重複は除く) を集める。
 * `deleteKeys` は `rowEditKey` で表した削除予定の行。上限 `REF_KEY_LIMIT` を超えたら
 * 打ち切って `partial: true` を返す。
 */
export function collectDeletedKeyValues(input: {
  columns: { name: string; type_name?: string }[];
  rows: CellValue[][];
  pkIndices: number[];
  deleteKeys: ReadonlySet<string>;
  referencedColumns: readonly string[];
}): { keys: Map<string, CellValue[]>; types: Map<string, string>; partial: boolean; unresolved: string[] } {
  const keys = new Map<string, CellValue[]>();
  const types = new Map<string, string>();
  // 結果に無い参照先列 (UNIQUE 列を参照している・大文字小文字が違うなど) は数えられない。
  const unresolved: string[] = [];
  const seen = new Map<string, Set<string>>();
  let partial = false;
  const idx = new Map<string, number>();
  for (const name of input.referencedColumns) {
    const i = input.columns.findIndex((c) => c.name === name);
    if (i >= 0) {
      idx.set(name, i);
      keys.set(name, []);
      types.set(name, input.columns[i]?.type_name ?? "");
      seen.set(name, new Set());
    } else if (!unresolved.includes(name)) {
      unresolved.push(name);
    }
  }
  for (let r = 0; r < input.rows.length; r++) {
    const row = input.rows[r];
    if (!row || !input.deleteKeys.has(rowEditKey(row, input.pkIndices, r))) continue;
    for (const [name, i] of idx) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      const set = seen.get(name);
      const list = keys.get(name);
      if (!set || !list) continue;
      const k = valueKey(v);
      if (set.has(k)) continue;
      if (list.length >= REF_KEY_LIMIT) {
        partial = true;
        continue;
      }
      set.add(k);
      list.push(v);
    }
  }
  return { keys, types, partial: partial || unresolved.length > 0, unresolved };
}

/**
 * 子テーブルごとの参照行数を数える SQL を組む (1 本以上)。各枝は
 * `SELECT <fk 番号>, COUNT(*) FROM 子 WHERE …`。`keys` が `null` のときは TRUNCATE 用で、
 * 子の FK 列が NULL でない行 (= 親の全行が消えると孤立する行) を数える。
 * `keys` があるときは、その列の値を持つ親行を参照する子行を数える (値が無い FK は枝を作らない)。
 */
export function buildRefCountSqls(input: {
  driver: string;
  database: string | null | undefined;
  refs: readonly IncomingFk[];
  keys: ReadonlyMap<string, CellValue[]> | null;
  types?: KeyTypes;
}): string[] {
  const { driver, database, refs, keys, types } = input;
  const branches: string[] = [];
  refs.forEach((fk, fkIndex) => {
    const col = quoteIdentFor(driver, fk.column);
    const from = qualifiedTable(driver, fk.schema ?? database, fk.table);
    const wheres: string[] = [];
    if (keys === null) {
      // TRUNCATE: 全件を数えると重いので 1 件余分に拾う上限付きサブクエリにする (3 方言共通)。
      branches.push(
        `SELECT ${fkIndex} AS i, COUNT(*) AS n FROM (SELECT 1 AS o FROM ${from} WHERE ${col} IS NOT NULL LIMIT ${TRUNCATE_COUNT_CAP + 1}) AS c`,
      );
      return;
    } else {
      const vals = keys.get(fk.referencedColumn) ?? [];
      for (let i = 0; i < vals.length; i += IN_CHUNK) {
        const lits = vals
          .slice(i, i + IN_CHUNK)
          .map((v) => keyLiteral(driver, v, fk.referencedColumn, types));
        wheres.push(`${col} IN (${lits.join(", ")})`);
      }
    }
    for (const where of wheres) {
      branches.push(`SELECT ${fkIndex} AS i, COUNT(*) AS n FROM ${from} WHERE ${where}`);
    }
  });
  const out: string[] = [];
  for (let i = 0; i < branches.length; i += BRANCHES_PER_QUERY) {
    out.push(branches.slice(i, i + BRANCHES_PER_QUERY).join(" UNION ALL "));
  }
  return out;
}

/** `buildRefCountSqls` の結果行 (`i`, `n`) を FK 番号ごとの合計へ集計する。 */
export function sumRefCounts(results: readonly Pick<QueryResult, "rows">[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const res of results) {
    for (const row of res.rows) {
      const i = Number(row[0]);
      const n = Number(row[1]);
      if (!Number.isFinite(i) || !Number.isFinite(n)) continue;
      totals.set(i, (totals.get(i) ?? 0) + n);
    }
  }
  return totals;
}

/**
 * 参照行数を数えて、1 行以上あった子テーブルだけを返す。`lookup` は読み取り専用クエリの
 * 実行関数 (`api.runLookupQuery` を包む)。`keys` が `null` なら TRUNCATE 用 (全行扱い)。
 * 失敗は呼び出し側で握る (確認自体は妨げない)。
 */
export async function loadRefImpacts(input: {
  driver: string;
  database: string | null | undefined;
  refs: readonly IncomingFk[];
  keys: ReadonlyMap<string, CellValue[]> | null;
  types?: KeyTypes;
  /** 参照先 (親) テーブル名。結果の `parentTable` に入れる。 */
  parentTable?: string;
  lookup: (sql: string, rowCap: number) => Promise<Pick<QueryResult, "rows">>;
}): Promise<RefImpact[]> {
  const sqls = buildRefCountSqls(input);
  if (sqls.length === 0) return [];
  const results = await Promise.all(sqls.map((sql) => input.lookup(sql, BRANCHES_PER_QUERY + 1)));
  const totals = sumRefCounts(results);
  const impacts: RefImpact[] = [];
  input.refs.forEach((fk, i) => {
    const count = totals.get(i) ?? 0;
    if (count <= 0) return;
    impacts.push({
      parentTable: input.parentTable,
      ...(fk.schema ? { schema: fk.schema } : {}),
      table: fk.table,
      column: fk.column,
      referencedColumn: fk.referencedColumn,
      onDelete: normalizeOnDelete(fk.onDelete),
      count: input.keys === null ? Math.min(count, TRUNCATE_COUNT_CAP) : count,
      ...(input.keys === null && count > TRUNCATE_COUNT_CAP ? { capped: true } : {}),
    });
  });
  return impacts;
}

/**
 * 子行を開く SQL (`SELECT * FROM 子 WHERE 子列 IN (...)` / TRUNCATE では NULL 以外)。
 * 件数が多いと IN が肥大化するので、開く導線では先頭 `limit` 件の値に絞る。
 */
export function buildOpenChildrenSql(input: {
  driver: string;
  database: string | null | undefined;
  impact: Pick<RefImpact, "schema" | "table" | "column" | "referencedColumn">;
  keys: ReadonlyMap<string, CellValue[]> | null;
  types?: KeyTypes;
  limit?: number;
}): string {
  const { driver, database, impact, keys, types } = input;
  const col = quoteIdentFor(driver, impact.column);
  const from = qualifiedTable(driver, impact.schema ?? database, impact.table);
  if (keys === null) return `SELECT * FROM ${from} WHERE ${col} IS NOT NULL`;
  const vals = (keys.get(impact.referencedColumn) ?? []).slice(0, input.limit ?? 100);
  if (vals.length === 0) return `SELECT * FROM ${from} WHERE 1 = 0`;
  return `SELECT * FROM ${from} WHERE ${col} IN (${vals.map((v) => keyLiteral(driver, v, impact.referencedColumn, types)).join(", ")})`;
}
