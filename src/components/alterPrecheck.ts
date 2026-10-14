import { quoteIdentFor } from "./sqlDialect";
import type { ExistingColumnBaseline, ExistingColumnEdit } from "./alterTable";

/**
 * ALTER TABLE の事前検査 (#1536)。列の型を縮小する / NOT NULL を付けると、既存行が
 * 新しい定義に収まらず ALTER が途中で失敗する。失敗してから気付くのではなく、収まらない行数を
 * 読み取り専用の `SELECT COUNT(*)` で先に数えて警告するための SQL を組み立てる純ロジック。
 *
 * 対象は MySQL / PostgreSQL。SQLite は `ALTER COLUMN` による型変更自体を持たない
 * (`buildAlterPlan` が unsupported 扱いにする) ので検査も作らない。
 */

type NumericRange = { min: bigint; max: bigint };

/** 整数型 → 取りうる範囲。MySQL の `unsigned` は呼び出し側で別扱い。 */
const SIGNED_RANGES: Record<string, NumericRange> = {
  tinyint: { min: BigInt("-128"), max: BigInt("127") },
  smallint: { min: BigInt("-32768"), max: BigInt("32767") },
  mediumint: { min: BigInt("-8388608"), max: BigInt("8388607") },
  int: { min: BigInt("-2147483648"), max: BigInt("2147483647") },
  bigint: { min: BigInt("-9223372036854775808"), max: BigInt("9223372036854775807") },
};
const UNSIGNED_MAX: Record<string, bigint> = {
  tinyint: BigInt("255"),
  smallint: BigInt("65535"),
  mediumint: BigInt("16777215"),
  int: BigInt("4294967295"),
  bigint: BigInt("18446744073709551615"),
};
/** 型名の別名 → 正規化した整数型名。 */
const INT_ALIASES: Record<string, string> = {
  tinyint: "tinyint",
  int1: "tinyint",
  smallint: "smallint",
  int2: "smallint",
  smallserial: "smallint",
  mediumint: "mediumint",
  int: "int",
  integer: "int",
  int4: "int",
  serial: "int",
  bigint: "bigint",
  int8: "bigint",
  bigserial: "bigint",
};

export type TypeSpec =
  | { kind: "string"; length: number | null }
  | { kind: "int"; range: NumericRange }
  | { kind: "decimal"; integerDigits: number | null }
  | { kind: "float" }
  | { kind: "other" };

/** 型の表記ゆれ (大文字小文字・空白) を畳んだ比較用の文字列。 */
export function normalizeType(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 型の文字列 (MySQL の `COLUMN_TYPE` / PostgreSQL の `format_type`) を縮小判定に必要な形へ解析する。 */
export function parseTypeSpec(driver: string, raw: string): TypeSpec {
  const t = normalizeType(raw);
  const m = /^([a-z][a-z0-9 ]*?)\s*(?:\(([^)]*)\))?\s*(unsigned)?(?:\s+zerofill)?$/.exec(t);
  if (!m) return { kind: "other" };
  const name = m[1].trim();
  const args = (m[2] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const unsigned = m[3] === "unsigned";

  if (name === "varchar" || name === "character varying" || name === "char" || name === "character") {
    const n = args.length > 0 ? Number(args[0]) : NaN;
    // PostgreSQL の `character` / `char` は長さ省略で 1。`character varying` の省略は無制限。
    if (Number.isInteger(n) && n > 0) return { kind: "string", length: n };
    if (driver === "postgres" && (name === "char" || name === "character"))
      return { kind: "string", length: 1 };
    return { kind: "string", length: name.includes("var") ? null : 1 };
  }
  if (["text", "tinytext", "mediumtext", "longtext"].includes(name)) {
    const lengths: Record<string, number | null> = {
      tinytext: 255,
      text: 65535,
      mediumtext: 16777215,
      longtext: null,
    };
    return { kind: "string", length: driver === "postgres" ? null : (lengths[name] ?? null) };
  }
  const intName = INT_ALIASES[name];
  if (intName) {
    const signed = SIGNED_RANGES[intName];
    return unsigned
      ? { kind: "int", range: { min: BigInt(0), max: UNSIGNED_MAX[intName] } }
      : { kind: "int", range: signed };
  }
  if (name === "decimal" || name === "numeric" || name === "dec") {
    const p = args.length > 0 ? Number(args[0]) : NaN;
    const s = args.length > 1 ? Number(args[1]) : 0;
    if (Number.isInteger(p) && Number.isInteger(s))
      return { kind: "decimal", integerDigits: Math.max(p - s, 0) };
    // 引数なし: MySQL は DECIMAL(10,0)、PostgreSQL は精度無制限。
    return { kind: "decimal", integerDigits: driver === "mysql" ? 10 : null };
  }
  if (["float", "double", "double precision", "real", "float4", "float8"].includes(name))
    return { kind: "float" };
  return { kind: "other" };
}

export type PrecheckKind = "length" | "range" | "decimal" | "notNull";

/** 事前検査 1 件。`sql` は「収まらない行数」を返す `SELECT COUNT(*)`。 */
export interface AlterPrecheck {
  id: string;
  kind: PrecheckKind;
  /** 検査対象の現在の列名 (リネーム前)。 */
  column: string;
  from: string;
  to: string;
  sql: string;
}

function intDigitsOfRange(r: NumericRange): number {
  return (r.max > -r.min ? r.max : -r.min).toString().length;
}

function qualified(driver: string, database: string | null, table: string): string {
  return database
    ? `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`
    : quoteIdentFor(driver, table);
}

/**
 * 編集内容から事前検査の SQL を作る。型が変わっていない列・削除予定の列・縮小にならない変更は
 * 何も返さない。検査は元の列名 (`original`) に対して行う (ALTER 前のデータを数えるため)。
 */
export function buildAlterPrechecks(
  driver: string,
  database: string | null,
  table: string,
  baseline: readonly ExistingColumnBaseline[],
  existing: readonly ExistingColumnEdit[],
): AlterPrecheck[] {
  if (driver !== "mysql" && driver !== "postgres") return [];
  const baseByName = new Map(baseline.map((b) => [b.name, b]));
  const from = qualified(driver, database, table);
  const out: AlterPrecheck[] = [];
  for (const edit of existing) {
    if (edit.drop) continue;
    const base = baseByName.get(edit.original);
    if (!base) continue;
    const col = quoteIdentFor(driver, edit.original);
    const count = (where: string) => `SELECT COUNT(*) FROM ${from} WHERE ${where}`;

    if (!base.notNull && edit.notNull) {
      out.push({
        id: `notNull:${edit.original}`,
        kind: "notNull",
        column: edit.original,
        from: "NULL",
        to: "NOT NULL",
        sql: count(`${col} IS NULL`),
      });
    }

    if (normalizeType(edit.type) === normalizeType(base.type)) continue;
    const oldSpec = parseTypeSpec(driver, base.type);
    const newSpec = parseTypeSpec(driver, edit.type);

    if (oldSpec.kind === "string" && newSpec.kind === "string" && newSpec.length !== null) {
      if (oldSpec.length === null || newSpec.length < oldSpec.length) {
        out.push({
          id: `length:${edit.original}`,
          kind: "length",
          column: edit.original,
          from: base.type,
          to: edit.type,
          sql: count(`CHAR_LENGTH(${col}) > ${newSpec.length}`),
        });
      }
    } else if (oldSpec.kind === "int" && newSpec.kind === "int") {
      const narrowerMin = newSpec.range.min > oldSpec.range.min;
      const narrowerMax = newSpec.range.max < oldSpec.range.max;
      if (narrowerMin || narrowerMax) {
        const conds: string[] = [];
        if (narrowerMin) conds.push(`${col} < ${newSpec.range.min}`);
        if (narrowerMax) conds.push(`${col} > ${newSpec.range.max}`);
        out.push({
          id: `range:${edit.original}`,
          kind: "range",
          column: edit.original,
          from: base.type,
          to: edit.type,
          sql: count(conds.join(" OR ")),
        });
      }
    } else if (newSpec.kind === "decimal" && newSpec.integerDigits !== null) {
      const oldDigits =
        oldSpec.kind === "decimal"
          ? oldSpec.integerDigits
          : oldSpec.kind === "int"
            ? intDigitsOfRange(oldSpec.range)
            : oldSpec.kind === "float"
              ? null
              : undefined;
      // 旧型が数値でない (文字列→数値など) 場合は収まり判定が型変換に依存するので検査しない。
      if (oldDigits !== undefined && (oldDigits === null || oldDigits > newSpec.integerDigits)) {
        out.push({
          id: `decimal:${edit.original}`,
          kind: "decimal",
          column: edit.original,
          from: base.type,
          to: edit.type,
          sql: count(`ABS(${col}) >= 1${"0".repeat(newSpec.integerDigits)}`),
        });
      }
    }
  }
  return out;
}
