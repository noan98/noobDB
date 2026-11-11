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

/**
 * `table` と外部キーでつながる表を、列の組つきで構造化して返す (#2242)。クエリビルダの
 * 「表を追加」の候補と、ON 句の自動生成に使う。`fkJoinSnippets` と同じ規則で、同じ制約名の
 * 列を 1 組にまとめ、列対応を復元できない (参照先列が無い・列が重複する) 制約は出さない。
 *
 * - `outgoing`: `table` が参照する側。`own` は `table` の列、`other` は参照先 (`otherTable`) の列。
 * - `incoming`: `table` が参照される側。`own` は `table` の列 (参照先)、`other` は参照元
 *   (`otherTable`) の列。自己参照は両方向を返す (上司 / 部下のように使い分けられる)。
 */
export interface FkRelation {
  direction: "outgoing" | "incoming";
  otherTable: string;
  pairs: { own: string; other: string }[];
}

export function fkRelations(table: string, fks: readonly ForeignKey[]): FkRelation[] {
  const groups = new Map<string, ForeignKey[]>();
  fks.forEach((fk, idx) => {
    if (!eq(fk.table, table) && !eq(fk.referenced_table, table)) return;
    const name = fk.constraint_name;
    const id = name !== null && name !== "" ? `c:${fk.table.toLowerCase()}|${name}` : `i:${idx}`;
    const g = groups.get(id);
    if (g) g.push(fk);
    else groups.set(id, [fk]);
  });
  const out: FkRelation[] = [];
  const seen = new Set<string>();
  const push = (r: FkRelation) => {
    const key = `${r.direction}|${r.otherTable}|${r.pairs.map((p) => `${p.own}=${p.other}`).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  for (const group of groups.values()) {
    if (group.some((x) => x.referenced_column === null)) continue;
    const cols = group.map((x) => x.column.toLowerCase());
    const refs = group.map((x) => (x.referenced_column ?? "").toLowerCase());
    if (new Set(cols).size !== cols.length || new Set(refs).size !== refs.length) continue;
    const first = group[0];
    if (eq(first.table, table)) {
      push({
        direction: "outgoing",
        otherTable: first.referenced_table,
        pairs: group.map((x) => ({ own: x.column, other: x.referenced_column ?? "" })),
      });
    }
    if (eq(first.referenced_table, table)) {
      push({
        direction: "incoming",
        otherTable: first.table,
        pairs: group.map((x) => ({ own: x.referenced_column ?? "", other: x.column })),
      });
    }
  }
  return out;
}
