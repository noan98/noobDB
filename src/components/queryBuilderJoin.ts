import type { ForeignKey } from "../api/tauri";
import { fkRelations } from "./fkJoin";

/**
 * クエリビルダの JOIN / 集計 / HAVING の純ロジック (#2242)。SQL そのものの生成は
 * `QueryBuilder.tsx` の `buildSql` (WHERE の描画と共通) が担い、ここは次を持つ。
 *
 * - 結合・集計・HAVING のデータ型 (スナップショットに保存される形)
 * - 外部キーからの「表を追加」候補と ON 句の自動生成 (`fkJoin.ts` の `fkRelations` を再利用)
 * - 結合先の別名 (自己結合・同じ表の複数回結合)
 * - 以前の形式のスナップショットを新形式へ読み替える移行
 *
 * 表の指し方は「別名」で、`undefined` / 空文字は基点の表 (FROM 側) を表す。基点の表は
 * 表名そのものが別名になる。
 */

export const AGGREGATE_FNS = ["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export function isAggregateFn(v: unknown): v is AggregateFn {
  return typeof v === "string" && (AGGREGATE_FNS as readonly string[]).includes(v);
}

/** HAVING で使える比較演算子。 */
export const HAVING_OPERATORS = ["=", "!=", "<", "<=", ">", ">="] as const;

/** ON 句の 1 組。左は結合済みの表 (`leftTable` が別名、省略は基点)、右は結合する表の列。 */
export interface QbJoinOn {
  leftTable?: string;
  leftColumn: string;
  rightColumn: string;
}

export interface QbJoin {
  /** 結合する表名。 */
  table: string;
  /** SQL 中の別名。同じ表を 2 回以上結合する・自己結合のときは `<表>_2` のようになる。 */
  alias: string;
  type: "INNER" | "LEFT";
  on: QbJoinOn[];
}

/**
 * SELECT の 1 項目。`agg` があれば集計、`as` があれば別名。`column: "*"` は `COUNT(*)` 専用。
 * `table` は別名 (省略 = 基点の表)。
 */
export interface QbSelectItem {
  table?: string;
  column: string;
  agg?: AggregateFn;
  as?: string;
}

/** HAVING の 1 条件 (集計結果への条件。AND でのみ結ぶ)。 */
export interface QbHaving {
  table?: string;
  column: string;
  agg: AggregateFn;
  operator: string;
  value: string;
}

/** 基点の表または結合済みの表の別名の一覧 (基点は表名)。 */
export function knownAliases(baseTable: string, joins: readonly QbJoin[]): string[] {
  return [baseTable, ...joins.map((j) => j.alias)];
}

/** `table` の別名として、`used` と衝突しない名前を返す。最初は表名そのもの、次から `_2` `_3`…。 */
export function uniqueJoinAlias(table: string, used: readonly string[]): string {
  const taken = new Set(used.map((u) => u.toLowerCase()));
  if (!taken.has(table.toLowerCase())) return table;
  for (let n = 2; ; n++) {
    const cand = `${table}_${n}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

export interface FkJoinCandidate {
  /** 追加する表。 */
  table: string;
  /** どの表 (別名、省略 = 基点) から外部キーでつながっているか。 */
  fromAlias?: string;
  /** 候補を区別するキー (UI の選択肢の値)。 */
  key: string;
  on: QbJoinOn[];
  direction: "outgoing" | "incoming";
}

/**
 * 基点の表と結合済みの表のそれぞれから外部キーでつながる表を、追加の候補として返す。
 * ON 句は外部キーの列対応から組む (複合キーは AND でまとめる)。
 */
export function fkJoinCandidates(opts: {
  baseTable: string;
  joins: readonly QbJoin[];
  fks: readonly ForeignKey[];
}): FkJoinCandidate[] {
  const { baseTable, joins, fks } = opts;
  const sources: { alias: string | undefined; table: string }[] = [
    { alias: undefined, table: baseTable },
    ...joins.map((j) => ({ alias: j.alias, table: j.table })),
  ];
  const out: FkJoinCandidate[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src.table) continue;
    for (const rel of fkRelations(src.table, fks)) {
      const on = rel.pairs.map((p) => ({ leftTable: src.alias, leftColumn: p.own, rightColumn: p.other }));
      const key = `${src.alias ?? ""}|${rel.otherTable}|${on.map((o) => `${o.leftColumn}=${o.rightColumn}`).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ table: rel.otherTable, fromAlias: src.alias, key, on, direction: rel.direction });
    }
  }
  return out;
}

/** 候補から結合を作る。別名は既存の別名と衝突しないよう振る。 */
export function joinFromCandidate(
  baseTable: string,
  joins: readonly QbJoin[],
  c: FkJoinCandidate,
  type: "INNER" | "LEFT" = "INNER",
): QbJoin {
  return {
    table: c.table,
    alias: uniqueJoinAlias(c.table, knownAliases(baseTable, joins)),
    type,
    on: c.on.map((o) => ({ ...o })),
  };
}

/** 外部キーなしで表を足すときの結合 (ON は空の 1 組から始める)。 */
export function manualJoin(baseTable: string, joins: readonly QbJoin[], table: string): QbJoin {
  return {
    table,
    alias: uniqueJoinAlias(table, knownAliases(baseTable, joins)),
    type: "INNER",
    on: [{ leftColumn: "", rightColumn: "" }],
  };
}

/** ON 句の組として完成しているもの (左右の列が両方入っている)。 */
export function completeOn(j: QbJoin): QbJoinOn[] {
  return j.on.filter((o) => o.leftColumn.trim() !== "" && o.rightColumn.trim() !== "");
}

/**
 * 結合として未完成か (表が空・完成した ON の組が 0・片側だけ入力された組がある)。
 * 両側とも空の組は無視するが、片側だけの組を黙って落とすと複合 FK が弱い結合になるので止める。
 */
export function isJoinIncomplete(j: QbJoin): boolean {
  if (j.table.trim() === "" || completeOn(j).length === 0) return true;
  return j.on.some((o) => (o.leftColumn.trim() === "") !== (o.rightColumn.trim() === ""));
}

/** HAVING (COUNT / SUM / AVG) の値として受け付ける数値の文法。検証と SQL 生成で共有する。 */
export function isHavingNumber(raw: string): boolean {
  return /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw.trim());
}

/** 集計の SQL 式に使う関数名と DISTINCT の有無。 */
export function aggregateParts(fn: AggregateFn): { name: string; distinct: boolean } {
  return fn === "COUNT_DISTINCT" ? { name: "COUNT", distinct: true } : { name: fn, distinct: false };
}

/** 画面に出す表示ラベル (`COUNT(DISTINCT orders.id)` / `COUNT(*)`)。 */
export function aggregateLabel(fn: AggregateFn, qualifiedColumn: string): string {
  const { name, distinct } = aggregateParts(fn);
  return `${name}(${distinct ? "DISTINCT " : ""}${qualifiedColumn})`;
}

/** スナップショットのうち、移行の対象になる項目。 */
export interface BuilderSnapshotJoinFields {
  selectColumns: string[];
  selectItems?: QbSelectItem[];
  aggColumns?: QbSelectItem[];
  joins?: QbJoin[];
  having?: QbHaving[];
}

/**
 * スナップショットから JOIN / 集計の入力を復元する。以前の形式 (`selectColumns` だけで、
 * `joins` / `selectItems` / `aggColumns` / `having` が無い) は、基点の表の素の列として読み替える。
 */
export function restoreJoinFields(snap: BuilderSnapshotJoinFields | null | undefined): {
  selectItems: QbSelectItem[];
  aggColumns: QbSelectItem[];
  joins: QbJoin[];
  having: QbHaving[];
} {
  if (!snap) return { selectItems: [], aggColumns: [], joins: [], having: [] };
  return {
    selectItems: snap.selectItems
      ? snap.selectItems.map((i) => ({ ...i }))
      : snap.selectColumns.map((column) => ({ column })),
    aggColumns: (snap.aggColumns ?? []).map((i) => ({ ...i })),
    joins: (snap.joins ?? []).map((j) => ({ ...j, on: j.on.map((o) => ({ ...o })) })),
    having: (snap.having ?? []).map((h) => ({ ...h })),
  };
}

/** 保存時の `selectColumns` (以前の形式の読み手向け)。基点の表の素の列だけを残す。 */
export function legacySelectColumns(items: readonly QbSelectItem[]): string[] {
  return items.filter((i) => !i.table && !i.agg && !i.as).map((i) => i.column);
}
