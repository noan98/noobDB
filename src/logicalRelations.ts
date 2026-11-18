// 論理リレーション (仮想 FK, #2356) の純ロジック。
//
// FK 制約を張らない運用の DB で、アプリ側にだけ登録した「子.列 → 親.列」を、宣言済み FK と
// 同じ形 (`ForeignKey` / `IncomingFk` / `TableColumnInfo.referenced_*`) へ変換してマージする。
// FK を使う機能 (FK ジャンプ・関連行・ER 図・JOIN 補完・クエリビルダなど) は、`api.foreignKeys` /
// `api.incomingForeignKeys` / `api.describeTable` / `api.describeDatabase` が返すこのマージ結果を
// 読むだけでよい。マージ結果の論理由来の要素には `logical: true` が付くので、UI は点線や
// 「論理」バッジで宣言 FK と見分ける。DDL・同期・ダンプには出さない (バックエンドは別経路)。
// 3 ドライバ共通 (テーブル名・列名はドライバが返す表記のまま比べる)。副作用なし。

import type { ForeignKey, LogicalRelationInput, TableColumnInfo } from "./api/tauri";
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
    const name = `logical:${r.table}(${r.columns.join(",")})->${r.referenced_table}(${r.referenced_columns.join(",")})`;
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

/** 関係 1 件の同一性キー。子・親と、列の対応 (子列→親列) の集合で比べる (列の並び順は問わない)。 */
const relationIdentity = (
  table: string,
  referencedTable: string,
  pairs: readonly (readonly [string, string | null])[],
) => JSON.stringify([table, referencedTable, pairs.map(([c, r]) => JSON.stringify([c, r])).sort()]);

/** 宣言 FK を制約単位 (複合キーは同じ `constraint_name` の行をまとめる) の同一性キーにする。 */
function declaredRelationKeys(declared: readonly ForeignKey[]): Set<string> {
  const groups = new Map<string, { table: string; referenced: string; pairs: [string, string | null][] }>();
  declared.forEach((f, i) => {
    // 制約名が取れない行は 1 行 = 1 関係として扱う。
    const g = JSON.stringify([f.table, f.referenced_table, f.constraint_name ?? `#${i}`]);
    const cur = groups.get(g) ?? { table: f.table, referenced: f.referenced_table, pairs: [] };
    cur.pairs.push([f.column, f.referenced_column]);
    groups.set(g, cur);
  });
  return new Set([...groups.values()].map((g) => relationIdentity(g.table, g.referenced, g.pairs)));
}

/**
 * 宣言済み FK に論理 FK を足す。宣言済みとまったく同じ関係 (子・親・列の対応がすべて一致) の論理
 * リレーションは重複なので落とす (宣言が優先)。比較と取捨は関係単位で行い、複合キーの一部の列だけを
 * 落とすことはしない (一部だけ残すと `user_id = id` だけの JOIN になり、テナントなどの絞り込みが外れる)。
 */
export function mergeForeignKeys(
  declared: readonly ForeignKey[],
  rels: readonly LogicalRelationInput[],
): ForeignKey[] {
  if (rels.length === 0) return [...declared];
  const seen = declaredRelationKeys(declared);
  const kept = rels.filter(
    (r) =>
      !seen.has(
        relationIdentity(
          r.table,
          r.referenced_table,
          r.columns.map((c, i) => [c, r.referenced_columns[i] ?? null] as const),
        ),
      ),
  );
  return [...declared, ...logicalToForeignKeys(kept)];
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

/** `applyLogicalToColumns` で載せた論理 FK の参照先を外す (登録の削除を、取得済みの列へ反映し直すため)。 */
export function stripLogicalFromColumns(columns: TableColumnInfo[]): TableColumnInfo[] {
  if (!columns.some((c) => c.logical)) return columns;
  return columns.map((c) => {
    if (!c.logical) return c;
    const { logical: _logical, ...rest } = c;
    return { ...rest, referenced_table: null, referenced_column: null };
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

/** 取り込み候補が接続先に適用できない理由。 */
export type ImportBlockReason =
  | { kind: "missingTable"; table: string }
  | { kind: "missingColumn"; table: string; column: string }
  | { kind: "duplicateColumn"; table: string; column: string };

/** 取り込みファイルの関係を、接続先のスキーマ・登録済みの一覧と照合した結果 (#2423)。 */
export interface ImportClassification {
  /** 接続先に新しく登録できるもの (大文字小文字だけ違う名前は接続先の表記へ直してある)。 */
  addable: LogicalRelationInput[];
  /**
   * すでに登録済みの同じ関係。表・列が今の接続先に無くても、登録済みなら (消えても関係を保持する
   * 設計のため) ここに入る。上書きでもこれは残る。
   */
  existing: LogicalRelationInput[];
  /** 接続先に存在しない表・列を参照していて適用できないもの (未登録のもの)。 */
  blocked: { relation: LogicalRelationInput; reason: ImportBlockReason }[];
  /** 上書きで削除される登録済みの件数 (登録済みのうちファイルに無いもの)。 */
  removedCount: number;
}

type Schema = ReadonlyMap<string, ReadonlySet<string>>;

/** 完全一致を優先し、無ければ (大文字小文字を無視するときに限り) 一意に定まる表記を返す。 */
function resolveName(name: string, names: Iterable<string>, fold: boolean): string | null {
  const all = [...names];
  if (all.includes(name)) return name;
  if (!fold) return null;
  const lower = name.toLowerCase();
  const hits = all.filter((n) => n.toLowerCase() === lower);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** 配列内で 2 回目に現れた最初の要素 (重複が無ければ null)。 */
function firstDuplicate(names: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
}

/** 接続先の表記へ解決した関係か、最初の適用できない理由を返す。 */
function resolveRelation(
  r: LogicalRelationInput,
  schema: Schema,
  fold: boolean,
): { relation: LogicalRelationInput } | { reason: ImportBlockReason } {
  const child = resolveName(r.table, schema.keys(), fold);
  if (child === null) return { reason: { kind: "missingTable", table: r.table } };
  const parent = resolveName(r.referenced_table, schema.keys(), fold);
  if (parent === null) return { reason: { kind: "missingTable", table: r.referenced_table } };
  const childCols = schema.get(child) ?? new Set<string>();
  const parentCols = schema.get(parent) ?? new Set<string>();
  const columns: string[] = [];
  for (const c of r.columns) {
    const hit = resolveName(c, childCols, fold);
    if (hit === null) return { reason: { kind: "missingColumn", table: child, column: c } };
    columns.push(hit);
  }
  const referencedColumns: string[] = [];
  for (const c of r.referenced_columns) {
    const hit = resolveName(c, parentCols, fold);
    if (hit === null) return { reason: { kind: "missingColumn", table: parent, column: c } };
    referencedColumns.push(hit);
  }
  // 大文字小文字を無視した読み替えで別の列が同じ列に潰れると、Rust の validate が重複として拒否し
  // 一括取り込みごと失敗する。その関係だけを適用できない扱いにする。
  const dupChild = firstDuplicate(columns);
  if (dupChild !== null) return { reason: { kind: "duplicateColumn", table: child, column: dupChild } };
  const dupParent = firstDuplicate(referencedColumns);
  if (dupParent !== null) return { reason: { kind: "duplicateColumn", table: parent, column: dupParent } };
  return {
    relation: { table: child, columns, referenced_table: parent, referenced_columns: referencedColumns },
  };
}

/**
 * 取り込む関係を「追加できる / 登録済み / 適用できない (存在しない表・列)」に分ける。純関数。
 * 登録済みと同じ関係は、接続先に表・列が無くても `existing` にする。`caseInsensitive` (MySQL / SQLite) の
 * ときは、完全一致が無い名前に限り、大文字小文字を無視して一意に定まる接続先の表記へ読み替える
 * (複数候補があるものは適用できない扱いのまま)。PostgreSQL は完全一致のみ。
 */
export function classifyImport(
  incoming: readonly LogicalRelationInput[],
  tables: readonly SuggestTable[],
  registered: readonly LogicalRelationInput[],
  caseInsensitive = false,
): ImportClassification {
  const schema: Schema = new Map(tables.map((tb) => [tb.name, new Set(tb.columns.map((c) => c.name))]));
  const have = new Set(registered.map(relationKey));
  const out: ImportClassification = { addable: [], existing: [], blocked: [], removedCount: 0 };
  const kept = new Set<string>();
  const seenAdd = new Set<string>();
  for (const r of incoming) {
    const key = relationKey(r);
    if (have.has(key)) {
      if (!kept.has(key)) {
        kept.add(key);
        out.existing.push(r);
      }
      continue;
    }
    const res = resolveRelation(r, schema, caseInsensitive);
    if ("reason" in res) {
      out.blocked.push({ relation: r, reason: res.reason });
      continue;
    }
    const k = relationKey(res.relation);
    if (have.has(k)) {
      if (!kept.has(k)) {
        kept.add(k);
        out.existing.push(res.relation);
      }
    } else if (!seenAdd.has(k)) {
      seenAdd.add(k);
      out.addable.push(res.relation);
    }
  }
  out.removedCount = have.size - kept.size;
  return out;
}
