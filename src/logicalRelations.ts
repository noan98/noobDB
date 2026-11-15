// 論理リレーション (仮想 FK, #2356) の純ロジック。
//
// FK 制約を張らない運用の DB で、アプリ側にだけ登録した「子.列 → 親.列」を、宣言済み FK と
// 同じ形 (`ForeignKey` / `IncomingFk` / `TableColumnInfo.referenced_*`) へ変換してマージする。
// FK を使う機能 (FK ジャンプ・関連行・ER 図・JOIN 補完・クエリビルダなど) は、`api.foreignKeys` /
// `api.incomingForeignKeys` / `api.describeTable` / `api.describeDatabase` が返すこのマージ結果を
// 読むだけでよい。マージ結果の論理由来の要素には `logical: true` が付くので、UI は点線や
// 「論理」バッジで宣言 FK と見分ける。DDL・同期・ダンプには出さない (バックエンドは別経路)。
// 3 ドライバ共通 (テーブル名・列名はドライバが返す表記のまま比べる)。副作用なし。

import type { ForeignKey, LogicalRelation, LogicalRelationInput, TableColumnInfo } from "./api/tauri";
import type { IncomingFk } from "./fkNavigation";

/** 論理リレーション 1 件の識別キー (登録・削除の同一性判定に使う)。 */
export function relationKey(r: LogicalRelationInput): string {
  return JSON.stringify([r.table, r.columns, r.referenced_table, r.referenced_columns]);
}

/** 論理リレーションの識別に必要なフィールドだけを取り出す。 */
export function relationInput(r: LogicalRelationInput): LogicalRelationInput {
  return {
    table: r.table,
    columns: [...r.columns],
    referenced_table: r.referenced_table,
    referenced_columns: [...r.referenced_columns],
  };
}

/** 論理リレーションを宣言 FK と同じ形 (参照列 1 件につき 1 行) へ展開する。複合キーは同じ `constraint_name` を共有する。 */
export function logicalToForeignKeys(rels: readonly LogicalRelationInput[]): ForeignKey[] {
  const out: ForeignKey[] = [];
  for (const r of rels) {
    const name = `logical:${r.table}->${r.referenced_table}(${r.columns.join(",")})`;
    r.columns.forEach((column, i) => {
      out.push({
        table: r.table,
        column,
        referenced_table: r.referenced_table,
        referenced_column: r.referenced_columns[i] ?? null,
        constraint_name: name,
        logical: true,
      });
    });
  }
  return out;
}

const fkIdentity = (table: string, column: string, referencedTable: string) =>
  JSON.stringify([table, column, referencedTable]);

/** 宣言済み FK に論理 FK を足す。宣言済みと (子, 列, 親) が同じ論理 FK は重複なので落とす (宣言が優先)。 */
export function mergeForeignKeys(
  declared: readonly ForeignKey[],
  rels: readonly LogicalRelationInput[],
): ForeignKey[] {
  if (rels.length === 0) return [...declared];
  const seen = new Set(declared.map((f) => fkIdentity(f.table, f.column, f.referenced_table)));
  const extra = logicalToForeignKeys(rels).filter(
    (f) => !seen.has(fkIdentity(f.table, f.column, f.referenced_table)),
  );
  return [...declared, ...extra];
}

/** `table` を参照している論理リレーションを、逆参照 FK (`incoming_foreign_keys` と同形) として足す。 */
export function mergeIncomingForeignKeys(
  declared: readonly IncomingFk[],
  rels: readonly LogicalRelationInput[],
  table: string,
): IncomingFk[] {
  const seen = new Set(
    declared.map((f) => JSON.stringify([f.schema ?? null, f.table, f.column, f.referencedColumn])),
  );
  const extra: IncomingFk[] = [];
  for (const r of rels) {
    if (r.referenced_table !== table) continue;
    r.columns.forEach((column, i) => {
      const referencedColumn = r.referenced_columns[i];
      if (referencedColumn === undefined) return;
      if (seen.has(JSON.stringify([null, r.table, column, referencedColumn]))) return;
      extra.push({ table: r.table, column, referencedColumn, logical: true });
    });
  }
  return [...declared, ...extra];
}

/**
 * 列メタデータ (`describe_table`) に論理 FK の参照先を載せる。すでに宣言 FK を持つ列はそのまま
 * (宣言が優先)。載せた列には `logical: true` が付く。該当が無ければ同じ配列を返す。
 */
export function applyLogicalToColumns(
  table: string,
  columns: TableColumnInfo[],
  rels: readonly LogicalRelationInput[],
): TableColumnInfo[] {
  const mine = rels.filter((r) => r.table === table);
  if (mine.length === 0) return columns;
  const target = new Map<string, { table: string; column: string | null }>();
  for (const r of mine) {
    r.columns.forEach((c, i) => {
      if (!target.has(c))
        target.set(c, { table: r.referenced_table, column: r.referenced_columns[i] ?? null });
    });
  }
  return columns.map((c) => {
    const t = target.get(c.name);
    if (!t || c.referenced_table !== null) return c;
    return { ...c, referenced_table: t.table, referenced_column: t.column, logical: true };
  });
}

// ---------- 命名規約からの推定 ----------

/** 推定された候補 1 件 (単一列)。`via` は一致のしかた (`exact` = 列名の語幹がそのまま表名、`suffix` = 末尾の語だけ一致)。 */
export interface LogicalRelationCandidate extends LogicalRelationInput {
  via: "exact" | "suffix";
}

export interface SuggestTable {
  name: string;
  columns: readonly TableColumnInfo[];
}

/** 型の同一視用の族 (整数・文字列・UUID・それ以外は基本型名)。長さ・符号・別名の違いは無視する。 */
export function typeFamily(dataType: string): string {
  const base = dataType
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\bunsigned\b|\bzerofill\b/g, "")
    .trim();
  if (/int|serial/.test(base)) return "int";
  if (/char|text|string|citext/.test(base)) return "text";
  if (/uuid|uniqueidentifier/.test(base)) return "uuid";
  return base.split(/\s+/)[0] ?? base;
}

/** 列名から `<名前>_id` / `<名前>Id` の語幹を取り出す (該当しなければ null)。 */
export function idStem(column: string): string | null {
  const snake = /^(.+?)_id$/i.exec(column);
  if (snake?.[1]) return snake[1];
  const camel = /^(.+?[a-z0-9])(?:Id|ID)$/.exec(column);
  return camel?.[1] ?? null;
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[_\s]/g, "");

/** 語幹 `stem` に対応しうる表名 (正規化済み) の候補。単数 / 複数のゆれ (s / es / y→ies) を許す。 */
function stemForms(stem: string): string[] {
  const n = normalizeName(stem);
  const forms = [n, `${n}s`, `${n}es`];
  if (n.endsWith("y")) forms.push(`${n.slice(0, -1)}ies`);
  return forms;
}

/**
 * 命名規約 (`user_id` / `userId` ↔ `user` / `users` テーブルの主キー) と型の一致から、論理リレーションの
 * 候補を推定する。すでに FK (宣言・論理とも) を持つ列、主キーが単一列でない親、型が一致しない組、
 * 自分自身への参照は出さない。結果は子テーブル名順、同じテーブル内は列の宣言順。
 */
export function suggestLogicalRelations(
  tables: readonly SuggestTable[],
  existing: readonly { table: string; column: string }[],
): LogicalRelationCandidate[] {
  const covered = new Set(existing.map((f) => JSON.stringify([f.table, f.column])));
  // 親の候補: 正規化した表名 → (表名, 単一の主キー列)。主キーが 1 列でなければ `id` 列で代用する。
  const parents = new Map<string, { table: string; column: TableColumnInfo }>();
  for (const t of tables) {
    const pks = t.columns.filter((c) => c.key.toUpperCase() === "PRI");
    const pk =
      pks.length === 1
        ? pks[0]
        : pks.length === 0
          ? t.columns.find((c) => c.name.toLowerCase() === "id")
          : undefined;
    if (pk) parents.set(normalizeName(t.name), { table: t.name, column: pk });
  }
  const out: LogicalRelationCandidate[] = [];
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of sorted) {
    for (const col of t.columns) {
      if (covered.has(JSON.stringify([t.name, col.name])) || col.referenced_table !== null) continue;
      const stem = idStem(col.name);
      if (!stem) continue;
      const tail = stem.split(/_/).filter(Boolean).pop();
      const attempts: { stem: string; via: "exact" | "suffix" }[] = [{ stem, via: "exact" }];
      if (tail && tail !== stem) attempts.push({ stem: tail, via: "suffix" });
      for (const a of attempts) {
        const parent = stemForms(a.stem)
          .map((f) => parents.get(f))
          .find(
            (p) =>
              p !== undefined &&
              p.table !== t.name &&
              typeFamily(p.column.data_type) === typeFamily(col.data_type),
          );
        if (!parent) continue;
        out.push({
          table: t.name,
          columns: [col.name],
          referenced_table: parent.table,
          referenced_columns: [parent.column.name],
          via: a.via,
        });
        break;
      }
    }
  }
  return out;
}
