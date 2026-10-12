import type { ForeignKey } from "../api/tauri";
import { quoteIfNeeded } from "./sqlJoinCompletion";
import { qualifiedTableName } from "./sqlDialect";

/**
 * 外部キー列から `JOIN <参照先> ON <参照先>.<列> = <元>.<列>` の雛形を作る純ロジック
 * (#1540)。ツリーの FK 列の右クリックと、FK 列を Shift 付きでエディタへドロップした
 * ときの挿入文字列を決める。`JOIN |` と `JOIN t ON |` のキー入力中の補完は
 * `sqlJoinCompletion.ts` (#1356) が担い、ここは「FK 列を起点に 1 手で句を入れる」側。
 *
 * - 参照先テーブルのスキーマ修飾は `qualifiedTableName` (`qualifiedTableSql` と共通)。
 *   ON 句の列修飾は FROM 側の書き方に合わせて素のテーブル名にする。
 * - 複合キーは同じ制約名の列を AND でまとめる。PostgreSQL が複合 FK を交差積で返す場合は
 *   列対応を復元できないので、`sqlJoinCompletion.ts` と同様に雛形を出さない。
 * - 自己参照 (参照先 = 元テーブル) は `<table>_2` の別名を付ける。
 */

export interface FkJoinSnippet {
  referencedTable: string;
  /** 挿入する文字列 (`JOIN ... ON ...`)。 */
  text: string;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function fkJoinSnippets(opts: {
  driver: string;
  database: string;
  table: string;
  column: string;
  fks: readonly ForeignKey[];
}): FkJoinSnippet[] {
  const { driver, database, table, column, fks } = opts;
  const out: FkJoinSnippet[] = [];
  const seen = new Set<string>();
  const done = new Set<string>();
  fks.forEach((fk, idx) => {
    if (!eq(fk.table, table) || !eq(fk.column, column) || fk.referenced_column === null) return;
    const name = fk.constraint_name;
    const groupId = name !== null && name !== "" ? `c:${name}` : `i:${idx}`;
    if (done.has(groupId)) return;
    done.add(groupId);
    const group =
      name !== null && name !== ""
        ? fks.filter((x) => eq(x.table, table) && x.constraint_name === name)
        : [fk];
    if (group.some((x) => x.referenced_column === null)) return;
    const left = group.map((x) => x.column.toLowerCase());
    const right = group.map((x) => (x.referenced_column ?? "").toLowerCase());
    if (new Set(left).size !== left.length || new Set(right).size !== right.length) return;

    const ref = fk.referenced_table;
    const self = eq(ref, table);
    const refName = qualifiedTableName(driver, database, ref);
    const refKey = self ? quoteIfNeeded(driver, `${ref}_2`) : quoteIfNeeded(driver, ref);
    const srcKey = quoteIfNeeded(driver, table);
    const cond = group
      .map(
        (x) =>
          `${refKey}.${quoteIfNeeded(driver, x.referenced_column ?? "")} = ${srcKey}.${quoteIfNeeded(driver, x.column)}`,
      )
      .join(" AND ");
    const text = `JOIN ${refName}${self ? ` ${refKey}` : ""} ON ${cond}`;
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ referencedTable: ref, text });
  });
  return out;
}
