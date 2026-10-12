import type { IncomingFk } from "./fkNavigation";

/** DROP 対象 1 テーブルと、それを参照している (DROP されない) 子テーブルの FK。 */
export interface DropImpact {
  table: string;
  refs: IncomingFk[];
}

/**
 * DROP TABLE の確認ダイアログに出す「外部キーの参照元」を求める純関数 (#1536)。
 *
 * `fksByTable` は DROP 対象ごとの逆引き FK (`incoming_foreign_keys`)。一括 DROP では
 * 参照元が同じ DROP 対象に含まれていれば、親子とも消えるので問題にならない (自己参照も同様)。
 * そのため `dropping` に含まれる参照元は除き、**消されずに残る子**だけを返す。
 * 参照が無いテーブルは結果に含めない。
 */
export function collectDropImpacts(
  fksByTable: Record<string, IncomingFk[]>,
  dropping: readonly string[],
): DropImpact[] {
  const gone = new Set(dropping);
  const impacts: DropImpact[] = [];
  for (const table of dropping) {
    const refs = (fksByTable[table] ?? []).filter((fk) => !gone.has(fk.table));
    if (refs.length > 0) impacts.push({ table, refs });
  }
  return impacts;
}
