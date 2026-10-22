// 行削除 / TRUNCATE の前に、子テーブルで巻き込まれる (またはブロックする) 参照行数を
// 数えるための純ロジック (#1506)。
//
// 逆方向 FK (`incoming_foreign_keys`、単一列のみ) を材料に、子テーブルごとの
// `COUNT(*)` を 1 本の `UNION ALL` にまとめて `run_lookup_query` (読み取り専用・
// read_only でも可) へ流す。書き込み経路は増やさない。

import type { CellValue, QueryResult } from "./api/tauri";
import { rowEditKey, rowValueLiteral } from "./components/cellEdit";
import { quoteIdentFor } from "./components/sqlDialect";
import { type IncomingFk, incomingFkTableName, qualifiedTable } from "./fkNavigation";

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
  /**
   * 連鎖の段数 (1 = 削除対象を直接参照する子、2 = CASCADE で消える子の子 …、#1767)。
   * 1 のときは省略してよい。
   */
  depth?: number;
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

/** CASCADE を辿る最大の段数 (子 = 1 段目)。これより深い連鎖は数えず「さらに連鎖あり」にする (#1767)。 */
export const CASCADE_MAX_DEPTH = 3;
/** 連鎖の探索で数える FK (子テーブル × 列) の総数の上限。超えたら打ち切って「さらに連鎖あり」にする。 */
export const CASCADE_MAX_EDGES = 24;

/** `loadCascadeImpacts` の結果。 */
export interface CascadeImpacts {
  /** 1 行以上あった子テーブル (段数順)。 */
  impacts: RefImpact[];
  /** 深さ / FK 数の上限で打ち切った、または循環参照で辿るのをやめた (実際にはさらに連鎖がある)。 */
  moreCascade: boolean;
  /** 集計に失敗した (またはタイムアウトした) 子テーブル名。ここに入ったテーブルの影響は不明。 */
  unverified: string[];
}

interface CascadeEdge {
  fk: IncomingFk;
  /** 子テーブル側の述語 (OR 結合ではなく枝ごとに数えて合算する。枝同士は重ならない)。 */
  preds: string[];
  /** 表示用の親テーブル名。 */
  parentName: string;
  depth: number;
}

function edgeKey(fk: IncomingFk): string {
  return `${fk.schema ?? ""}\0${fk.table}\0${fk.column}\0${fk.referencedColumn}`;
}

/** 削除対象の親行を表す、最初の段 (子 = 1 段目) の述語を作る関数。述語が無い FK は数えない。 */
export type RootPredicates = (fk: IncomingFk) => string[];

/**
 * 削除予定のキー値 (結果グリッドの行削除) から、1 段目の述語を作る。値は `rowValueLiteral` で
 * リテラル化し (64bit 整数は文字列のまま)、`IN_CHUNK` ごとに分ける。
 */
export function rootPredicatesFromKeys(input: {
  driver: string;
  keys: ReadonlyMap<string, CellValue[]>;
  types?: KeyTypes;
}): RootPredicates {
  return (fk) => {
    const col = quoteIdentFor(input.driver, fk.column);
    const vals = input.keys.get(fk.referencedColumn) ?? [];
    const preds: string[] = [];
    for (let i = 0; i < vals.length; i += IN_CHUNK) {
      const lits = vals
        .slice(i, i + IN_CHUNK)
        .map((v) => keyLiteral(input.driver, v, fk.referencedColumn, input.types));
      preds.push(`${col} IN (${lits.join(", ")})`);
    }
    return preds;
  };
}

/**
 * エディタの単一表 `DELETE FROM t [WHERE cond]` から、1 段目の述語を作る (#1767)。
 * 親行の列を副問い合わせで引くので、キー値を先に読む必要が無い。`table` / `condition` は
 * プリフライト (`buildPreflightPlan`) が元 SQL から切り出した原文で、実行しようとしている
 * DELETE と同じ対象になる。`condition` が null なら全行。
 */
export function rootPredicatesFromDelete(input: {
  driver: string;
  table: string;
  condition: string | null;
}): RootPredicates {
  return (fk) => {
    const col = quoteIdentFor(input.driver, fk.column);
    const ref = quoteIdentFor(input.driver, fk.referencedColumn);
    const where = input.condition ? ` WHERE ${input.condition}` : "";
    return [`${col} IN (SELECT ${ref} FROM ${input.table}${where})`];
  };
}

/**
 * 親行の削除が CASCADE で連鎖する先まで辿って、子行数を数える (#1767)。
 *
 * - 1 段目は `rootPredicates` で数える。CASCADE の子に行があれば、その子を参照する FK
 *   (`fetchIncoming`) を次の段として副問い合わせで数える (SET NULL / RESTRICT は子行が消えない
 *   ので辿らない)。
 * - 深さは `CASCADE_MAX_DEPTH`、FK の総数は `CASCADE_MAX_EDGES` まで (1 段目の FK は上限なしで数え、上限は 2 段目以降に掛ける)。超える分、および循環
 *   (同じ FK に再度到達) は数えず `moreCascade` を立てる。
 * - 1 段目の集計が失敗したら例外を投げる (呼び出し側が「確認できなかった」にする)。2 段目以降の
 *   失敗は、そこまでの結果を返して `unverified` に該当テーブルを入れる。
 * - すべて `lookup` (`run_lookup_query` 経由の読み取り専用) で数える。
 */
export async function loadCascadeImpacts(input: {
  driver: string;
  database: string | null | undefined;
  parentTable: string;
  refs: readonly IncomingFk[];
  rootPredicates: RootPredicates;
  fetchIncoming: (fk: IncomingFk) => Promise<readonly IncomingFk[]>;
  lookup: (sql: string, rowCap: number) => Promise<Pick<QueryResult, "rows">>;
}): Promise<CascadeImpacts> {
  const { driver, database } = input;
  const impacts: RefImpact[] = [];
  const unverified: string[] = [];
  let moreCascade = false;
  const visited = new Set<string>();
  let budget = CASCADE_MAX_EDGES;

  let level: CascadeEdge[] = [];
  for (const fk of input.refs) {
    const preds = input.rootPredicates(fk);
    if (preds.length === 0) continue;
    // 1 段目の FK は全部数える (上限は 2 段目以降の探索にだけ掛ける)。
    budget--;
    visited.add(edgeKey(fk));
    level.push({ fk, preds, parentName: input.parentTable, depth: 1 });
  }

  while (level.length > 0) {
    const branches: string[] = [];
    level.forEach((edge, i) => {
      const from = qualifiedTable(driver, edge.fk.schema ?? database, edge.fk.table);
      for (const pred of edge.preds) {
        branches.push(`SELECT ${i} AS i, COUNT(*) AS n FROM ${from} WHERE ${pred}`);
      }
    });
    const totals = new Map<number, number>();
    try {
      for (let b = 0; b < branches.length; b += BRANCHES_PER_QUERY) {
        const sql = branches.slice(b, b + BRANCHES_PER_QUERY).join(" UNION ALL ");
        const res = await input.lookup(sql, BRANCHES_PER_QUERY + 1);
        for (const [k, v] of sumRefCounts([res])) totals.set(k, (totals.get(k) ?? 0) + v);
      }
    } catch (e) {
      if (level[0]?.depth === 1) throw e;
      for (const edge of level) unverified.push(incomingFkTableName(edge.fk));
      break;
    }

    const next: CascadeEdge[] = [];
    for (const [i, edge] of level.entries()) {
      const count = totals.get(i) ?? 0;
      if (count <= 0) continue;
      const { fk } = edge;
      const onDelete = normalizeOnDelete(fk.onDelete);
      impacts.push({
        parentTable: edge.parentName,
        ...(fk.schema ? { schema: fk.schema } : {}),
        table: fk.table,
        column: fk.column,
        referencedColumn: fk.referencedColumn,
        onDelete,
        count,
        ...(edge.depth > 1 ? { depth: edge.depth } : {}),
      });
      if (onDelete !== "CASCADE") continue;
      // CASCADE で消える子を、さらに参照している FK があるか。
      let grand: readonly IncomingFk[];
      try {
        grand = await input.fetchIncoming(fk);
      } catch {
        unverified.push(incomingFkTableName(fk));
        continue;
      }
      if (grand.length === 0) continue;
      if (edge.depth >= CASCADE_MAX_DEPTH) {
        moreCascade = true;
        continue;
      }
      const childFrom = qualifiedTable(driver, fk.schema ?? database, fk.table);
      for (const g of grand) {
        const key = edgeKey(g);
        if (visited.has(key) || budget <= 0) {
          moreCascade = true;
          continue;
        }
        budget--;
        visited.add(key);
        const gcol = quoteIdentFor(driver, g.column);
        const gref = quoteIdentFor(driver, g.referencedColumn);
        next.push({
          fk: g,
          parentName: incomingFkTableName(fk),
          depth: edge.depth + 1,
          preds: edge.preds.map((pred) => `${gcol} IN (SELECT ${gref} FROM ${childFrom} WHERE ${pred})`),
        });
      }
    }
    level = next;
  }
  return { impacts, moreCascade, unverified: [...new Set(unverified)] };
}
