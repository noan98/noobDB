// CREATE TABLE ウィザードの「テーブルオプション」(#2161) の純ロジック。
//
// ドライバごとの表レベルのオプションを SQL にする:
// - MySQL: ENGINE / DEFAULT CHARSET / COLLATE と PARTITION BY (RANGE / LIST / HASH / KEY)
// - PostgreSQL: UNLOGGED と PARTITION BY (RANGE / LIST / HASH)。最初の子パーティションは
//   親の後ろに `CREATE TABLE ... PARTITION OF ...` として並べる
// - SQLite: STRICT / WITHOUT ROWID
// 方言ごとの境界ケース (STRICT で使えない型・WITHOUT ROWID に要る主キー・パーティションキーを
// 含まない主キー・COLLATE と文字セットの食い違い) は `tableOptionProblems` が返し、UI が止める。
// 副作用が無いので Vitest で単体テストする。

import type { ColumnDef } from "./createTable";
import { quoteIdentFor, qualifiedTableName } from "./sqlDialect";
import { isCompleteForeignKey, type ForeignKeyDef } from "./tableConstraints";
import {
  buildPartitionBoundClause,
  parseListValues,
  partitionKeyColumns,
  validateAttachBound,
  type AttachBoundError,
  type AttachBoundSpec,
} from "./tablePartitions";

export type PartitionMethod = "RANGE" | "LIST" | "HASH" | "KEY";

/** ドライバごとに選べる分割方式 (SQLite はパーティションが無い)。 */
export function partitionMethods(driver: string): PartitionMethod[] {
  if (driver === "mysql") return ["RANGE", "LIST", "HASH", "KEY"];
  if (driver === "postgres") return ["RANGE", "LIST", "HASH"];
  return [];
}

/** パーティションの指定。`key` はカンマ区切りの列名 (PostgreSQL / MySQL は式も書ける)。 */
export interface PartitionSpec {
  method: PartitionMethod;
  key: string;
  /**
   * 最初のパーティションの名前。空なら作らない (PostgreSQL は親だけ作って後から子を付ける)。
   * MySQL の RANGE / LIST は定義時に 1 つ以上のパーティションが要るので必須。
   */
  firstName: string;
  /** RANGE の下限 (PostgreSQL のみ。カンマ区切り)。 */
  from: string;
  /** RANGE の上限 (MySQL は `VALUES LESS THAN` の値)。 */
  to: string;
  /** LIST の値 (カンマ区切り)。 */
  values: string;
  /** HASH の MODULUS (MySQL の HASH / KEY は PARTITIONS の数)。 */
  modulus: string;
  /** HASH の REMAINDER (PostgreSQL のみ)。 */
  remainder: string;
}

export interface TableOptions {
  /** MySQL の ENGINE (空なら付けない)。 */
  engine: string;
  /** MySQL の DEFAULT CHARSET。 */
  charset: string;
  /** MySQL の COLLATE。 */
  collation: string;
  /** PostgreSQL の UNLOGGED (パーティション表には付けられない)。 */
  unlogged: boolean;
  /** SQLite の STRICT。 */
  strict: boolean;
  /** SQLite の WITHOUT ROWID。 */
  withoutRowid: boolean;
  /** パーティション表にするときの指定。null ならしない。 */
  partition: PartitionSpec | null;
}

export function emptyPartitionSpec(driver: string): PartitionSpec {
  return {
    method: "RANGE",
    key: "",
    firstName: "",
    from: "",
    to: "",
    values: "",
    modulus: driver === "mysql" ? "4" : "2",
    remainder: "0",
  };
}

export function emptyTableOptions(): TableOptions {
  return {
    engine: "",
    charset: "",
    collation: "",
    unlogged: false,
    strict: false,
    withoutRowid: false,
    partition: null,
  };
}

/** いずれかのオプションがそのドライバで有効になっているか (折りたたみの見出しの印に使う)。 */
export function hasTableOptions(driver: string, o: TableOptions): boolean {
  switch (driver) {
    case "mysql":
      return (
        o.engine.trim() !== "" || o.charset.trim() !== "" || o.collation.trim() !== "" || o.partition !== null
      );
    case "postgres":
      return o.unlogged || o.partition !== null;
    default:
      return o.strict || o.withoutRowid;
  }
}

/** SQLite の STRICT 表で使える型 (大文字小文字は問わない)。 */
export const SQLITE_STRICT_TYPES = ["INT", "INTEGER", "REAL", "TEXT", "BLOB", "ANY"] as const;

export function isSqliteStrictType(type: string): boolean {
  const ty = type.trim().toUpperCase();
  return (SQLITE_STRICT_TYPES as readonly string[]).includes(ty);
}

/** ENGINE / CHARSET / COLLATE の値に使える文字 (SQL に直接書くので識別子の範囲に絞る)。 */
const OPTION_TOKEN_RE = /^[A-Za-z0-9_]+$/;

export type TableOptionProblem =
  | { code: "token"; field: "engine" | "charset" | "collation" }
  | { code: "collationMismatch" }
  | { code: "strictType"; columns: string[] }
  | { code: "withoutRowidNoPrimaryKey" }
  | { code: "withoutRowidAutoIncrement" }
  | { code: "partitionKeyEmpty" }
  | { code: "partitionKeyUnknown"; columns: string[] }
  | { code: "partitionKeyUnique"; columns: string[] }
  | { code: "partitionNeedsFirst" }
  | { code: "partitionBound"; error: AttachBoundError }
  | { code: "partitionCount" }
  | { code: "partitionForeignKey" };

/** パーティションキーの 1 要素が素の識別子か (引用符つきも含む)。式 (`YEAR(d)` など) は false。 */
function plainIdentifier(part: string): string | null {
  const p = part.trim();
  const m = /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([A-Za-z_][A-Za-z0-9_$]*))$/.exec(p);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/""/g, '"');
  if (m[2] !== undefined) return m[2].replace(/``/g, "`");
  return m[3] ?? null;
}

interface KeyPart {
  /** 入力のまま。 */
  raw: string;
  /** 定義済みの列に解決できた素の識別子なら、その列名。 */
  column: string | null;
  /** 素の識別子だが、定義済みの列に無い。 */
  unknown: boolean;
}

function parseKey(driver: string, key: string, columns: readonly ColumnDef[]): KeyPart[] {
  const names = columns.map((c) => c.name.trim()).filter((n) => n !== "");
  return partitionKeyColumns(key)
    .filter((p) => p.trim() !== "")
    .map((raw) => {
      const id = plainIdentifier(raw);
      if (id === null) return { raw, column: null, unknown: false };
      // MySQL の列名は大文字小文字を区別しない。PostgreSQL は引用して作る列名なので厳密に照合する。
      const hit =
        names.find((n) => n === id) ??
        (driver === "mysql" ? names.find((n) => n.toLowerCase() === id.toLowerCase()) : undefined);
      return hit !== undefined ? { raw, column: hit, unknown: false } : { raw, column: null, unknown: true };
    });
}

/** 一意になる列の集合 (主キーと単一列 UNIQUE)。生成列は主キーにできない。 */
function uniqueSets(columns: readonly ColumnDef[]): Set<string>[] {
  const named = columns.filter((c) => c.name.trim() !== "");
  const pk = named.filter((c) => c.primaryKey && !(c.generated && c.generated.expression.trim() !== ""));
  const sets: Set<string>[] = [];
  if (pk.length > 0) sets.push(new Set(pk.map((c) => c.name.trim())));
  for (const c of named) if (c.unique && !c.primaryKey) sets.push(new Set([c.name.trim()]));
  return sets;
}

function boundSpecOf(p: PartitionSpec): AttachBoundSpec | null {
  switch (p.method) {
    case "RANGE":
      return { kind: "range", from: parseListValues(p.from), to: parseListValues(p.to) };
    case "LIST":
      return { kind: "list", values: parseListValues(p.values) };
    case "HASH":
      return { kind: "hash", modulus: p.modulus, remainder: p.remainder };
    case "KEY":
      return null;
  }
}

/**
 * 入力の不備。空なら SQL を組み立てられる。UI は直すまで実行を止める。
 * ドライバに関係の無いオプションの値は無視する (切り替えで残った値が影響しない)。
 */
export function tableOptionProblems(
  driver: string,
  columns: readonly ColumnDef[],
  o: TableOptions,
  /** 完成済みの外部キー。MySQL (InnoDB) はパーティション表に外部キーを付けられない (ER 1506)。 */
  foreignKeys: readonly ForeignKeyDef[] = [],
): TableOptionProblem[] {
  const out: TableOptionProblem[] = [];
  if (driver === "mysql") {
    for (const field of ["engine", "charset", "collation"] as const) {
      const v = o[field].trim();
      if (v !== "" && !OPTION_TOKEN_RE.test(v)) out.push({ code: "token", field });
    }
    const cs = o.charset.trim();
    const co = o.collation.trim();
    if (cs !== "" && co !== "" && OPTION_TOKEN_RE.test(cs) && OPTION_TOKEN_RE.test(co)) {
      if (!co.toLowerCase().startsWith(`${cs.toLowerCase()}_`)) out.push({ code: "collationMismatch" });
    }
  }
  if (driver === "sqlite") {
    if (o.strict) {
      const bad = columns
        .filter((c) => c.name.trim() !== "" && c.type.trim() !== "" && !isSqliteStrictType(c.type))
        .map((c) => c.name.trim());
      if (bad.length > 0) out.push({ code: "strictType", columns: bad });
    }
    if (o.withoutRowid) {
      const pk = columns.filter(
        (c) => c.primaryKey && !(c.generated && c.generated.expression.trim() !== ""),
      );
      if (pk.length === 0) out.push({ code: "withoutRowidNoPrimaryKey" });
      if (pk.some((c) => c.autoIncrement)) out.push({ code: "withoutRowidAutoIncrement" });
    }
  }
  const p = driver === "sqlite" ? null : o.partition;
  if (p) {
    const parts = parseKey(driver, p.key, columns);
    if (parts.length === 0) {
      out.push({ code: "partitionKeyEmpty" });
    } else {
      const unknown = parts.filter((k) => k.unknown).map((k) => k.raw.trim());
      if (unknown.length > 0) out.push({ code: "partitionKeyUnknown", columns: unknown });
      // 主キー・UNIQUE は、パーティションキーの列をすべて含む必要がある (PostgreSQL / MySQL 共通の制約)。
      const keyColumns = parts.map((k) => k.column).filter((c): c is string => c !== null);
      if (keyColumns.length > 0) {
        const missing = new Set<string>();
        for (const set of uniqueSets(columns)) for (const k of keyColumns) if (!set.has(k)) missing.add(k);
        if (missing.size > 0) out.push({ code: "partitionKeyUnique", columns: [...missing] });
      }
    }
    const spec = boundSpecOf(p);
    if (driver === "postgres") {
      // 最初の子パーティションは名前を入れたときだけ作る。作るなら境界が要る。
      if (p.firstName.trim() !== "" && spec) {
        // RANGE は FROM / TO の値の数がキーの列の数と合う必要がある (`validateAttachBound` は空の入力を通すので先に見る)。
        const keyCount = parts.length;
        const rangeShort =
          spec.kind === "range" &&
          (spec.from.length === 0 ||
            spec.to.length === 0 ||
            (keyCount > 0 && (spec.from.length !== keyCount || spec.to.length !== keyCount)));
        const error = rangeShort ? "rangeEmpty" : validateAttachBound(spec);
        if (error) out.push({ code: "partitionBound", error });
      }
    } else if (driver === "mysql") {
      if (p.method === "RANGE" || p.method === "LIST") {
        if (p.firstName.trim() === "") out.push({ code: "partitionNeedsFirst" });
        else if (p.method === "RANGE" && parseListValues(p.to).length === 0) {
          out.push({ code: "partitionBound", error: "rangeEmpty" });
        } else if (
          p.method === "RANGE" &&
          parseListValues(p.to).length !==
            (parts.length > 1 && parts.every((k) => k.column !== null) ? parts.length : 1)
        ) {
          // RANGE COLUMNS (素の列 2 つ以上) は境界の値の数がキーの列の数と一致し、
          // それ以外 (1 列・式) は LESS THAN の値が 1 つでなければならない。
          out.push({ code: "partitionBound", error: "rangeEmpty" });
        } else if (p.method === "LIST" && parseListValues(p.values).length === 0) {
          out.push({ code: "partitionBound", error: "listEmpty" });
        } else if (
          p.method === "LIST" &&
          parts.length > 1 &&
          !parseListValues(p.values).every((v) => /^\(.*\)$/s.test(v.trim()))
        ) {
          // 複数列の LIST COLUMNS は値をタプル `(1, 'a'), (2, 'b')` で書く必要がある (平坦だと ER 1653)。
          out.push({ code: "partitionBound", error: "listEmpty" });
        }
      } else if (!/^\d+$/.test(p.modulus.trim()) || Number(p.modulus) < 1) {
        out.push({ code: "partitionCount" });
      }
      if (foreignKeys.some(isCompleteForeignKey)) out.push({ code: "partitionForeignKey" });
    }
  }
  return out;
}

/** パーティションキーの SQL。定義済みの列は引用し、式は PostgreSQL では括弧で包む。 */
function renderKey(driver: string, key: string, columns: readonly ColumnDef[]): string {
  return parseKey(driver, key, columns)
    .map((k) => {
      if (k.column !== null) return quoteIdentFor(driver, k.column);
      return driver === "postgres" && plainIdentifier(k.raw) === null ? `(${k.raw.trim()})` : k.raw.trim();
    })
    .join(", ");
}

/** MySQL の境界の値。数値・MAXVALUE・式はそのまま、`'...'` の文字列リテラルもそのまま使う (式として評価される)。 */
function mysqlValues(raw: string): string {
  return parseListValues(raw)
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .join(", ");
}

function mysqlPartitionBy(columns: readonly ColumnDef[], p: PartitionSpec): string {
  const key = renderKey("mysql", p.key, columns);
  if (p.method === "HASH" || p.method === "KEY") {
    return `PARTITION BY ${p.method} (${key}) PARTITIONS ${Number(p.modulus)}`;
  }
  const values = p.method === "RANGE" ? mysqlValues(p.to) : mysqlValues(p.values);
  // 文字列の境界値や複数列のキーは COLUMNS 形式でしか書けない。素の列名だけのキーのときに自動で切り替える。
  const parts = parseKey("mysql", p.key, columns);
  const allColumns = parts.length > 0 && parts.every((k) => k.column !== null);
  const usesString = parseListValues(p.method === "RANGE" ? p.to : p.values).some((v) =>
    v.trim().startsWith("'"),
  );
  const useColumns = allColumns && (parts.length > 1 || usesString);
  const head = `PARTITION BY ${p.method}${useColumns ? " COLUMNS" : ""} (${key})`;
  const name = quoteIdentFor("mysql", p.firstName.trim());
  // RANGE の上限の MAXVALUE は括弧なしで書く (`LESS THAN MAXVALUE`)。
  const def =
    p.method === "RANGE"
      ? `PARTITION ${name} VALUES LESS THAN ${values.toUpperCase() === "MAXVALUE" ? "MAXVALUE" : `(${values})`}`
      : `PARTITION ${name} VALUES IN (${values})`;
  return `${head} (\n  ${def}\n)`;
}

/**
 * `CREATE TABLE ... (...)` の閉じ括弧の後ろに付ける句 (先頭の空白つき。無ければ空文字)。
 * 不備のある入力 (`tableOptionProblems` が返すもの) は、UI が実行を止める前提でできる範囲で出力する。
 */
export function tableOptionSuffix(driver: string, columns: readonly ColumnDef[], o: TableOptions): string {
  switch (driver) {
    case "mysql": {
      const parts: string[] = [];
      if (o.engine.trim()) parts.push(`ENGINE=${o.engine.trim()}`);
      if (o.charset.trim()) parts.push(`DEFAULT CHARSET=${o.charset.trim()}`);
      if (o.collation.trim()) parts.push(`COLLATE=${o.collation.trim()}`);
      let out = parts.length > 0 ? ` ${parts.join(" ")}` : "";
      if (o.partition && o.partition.key.trim() !== "") out += `\n${mysqlPartitionBy(columns, o.partition)}`;
      return out;
    }
    case "postgres": {
      const p = o.partition;
      if (!p || p.key.trim() === "") return "";
      return ` PARTITION BY ${p.method} (${renderKey("postgres", p.key, columns)})`;
    }
    default: {
      const parts: string[] = [];
      if (o.strict) parts.push("STRICT");
      if (o.withoutRowid) parts.push("WITHOUT ROWID");
      return parts.length > 0 ? ` ${parts.join(", ")}` : "";
    }
  }
}

/** PostgreSQL の UNLOGGED を `CREATE` の後ろに入れるか。パーティション表は UNLOGGED にできない。 */
export function usesUnlogged(driver: string, o: TableOptions): boolean {
  return driver === "postgres" && o.unlogged && o.partition === null;
}

/**
 * 親表の後ろに続ける文 (PostgreSQL の最初の子パーティション)。名前が空・境界が不正なら出さない。
 * 子は親と同じスキーマに作る。
 */
export function tableOptionExtraStatements(
  driver: string,
  database: string | null | undefined,
  parentTable: string,
  o: TableOptions,
): string[] {
  const p = o.partition;
  if (driver !== "postgres" || !p || p.firstName.trim() === "") return [];
  const spec = boundSpecOf(p);
  if (!spec) return [];
  const bound = buildPartitionBoundClause(spec);
  if (bound === "") return [];
  const child = qualifiedTableName(driver, database, p.firstName.trim());
  const parent = qualifiedTableName(driver, database, parentTable);
  return [`CREATE TABLE ${child} PARTITION OF ${parent} ${bound};`];
}
