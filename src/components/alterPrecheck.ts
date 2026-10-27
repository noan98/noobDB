import { quoteIdentFor } from "./sqlDialect";
import {
  supportsConstraintAlter,
  type ExistingColumnBaseline,
  type ExistingColumnEdit,
  type IndexDef,
} from "./alterTable";
import { isCompleteCheck, isCompleteForeignKey, type CheckDef, type ForeignKeyDef } from "./tableConstraints";

/**
 * ALTER TABLE の事前検査 (#1536)。列の型を縮小する / NOT NULL を付けると、既存行が
 * 新しい定義に収まらず ALTER が途中で失敗する。失敗してから気付くのではなく、収まらない行数を
 * 読み取り専用の `SELECT COUNT(*)` で先に数えて警告するための SQL を組み立てる純ロジック。
 *
 * #1757 で制約の追加 (ADD FOREIGN KEY / UNIQUE インデックス / ADD CHECK) で違反する既存行の検査
 * (`buildConstraintPrechecks`) も加えた。
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
  | { kind: "decimal"; integerDigits: number | null; scale: number | null }
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
      return { kind: "decimal", integerDigits: Math.max(p - s, 0), scale: s };
    // 引数なし: MySQL は DECIMAL(10,0)、PostgreSQL は精度無制限。
    return {
      kind: "decimal",
      integerDigits: driver === "mysql" ? 10 : null,
      scale: driver === "mysql" ? 0 : null,
    };
  }
  if (["float", "double", "double precision", "real", "float4", "float8"].includes(name))
    return { kind: "float" };
  return { kind: "other" };
}

export type PrecheckKind =
  | "length"
  | "range"
  | "decimal"
  | "scale"
  | "notNull"
  // 制約の追加で既存データが違反する行 (#1757)。
  | "orphanFk"
  | "duplicateUnique"
  | "checkViolation";

/** 制約追加 (FK / UNIQUE / CHECK) 由来の事前検査か (#1757)。`from` / `to` の意味が列の型検査と違う。 */
export function isConstraintPrecheck(kind: PrecheckKind): boolean {
  return kind === "orphanFk" || kind === "duplicateUnique" || kind === "checkViolation";
}

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
  // SQLite は接続あたり 1 つの名前空間なので DB 修飾を付けない (`qualifiedTableName` と同じ規則)。
  return database && driver !== "sqlite"
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

    // 小数桁だけの縮小 (decimal(10,4) → decimal(10,2) など) は、MySQL / PostgreSQL とも値を
    // 無言で丸める。丸めると値が変わる行数を数える。旧型が無制限 numeric (scale=null) なら
    // 新しい scale 以下に収まる保証がないので同様に検査する。float 由来は丸め誤差で
    // 偽陽性が出るため対象外。
    if (
      oldSpec.kind === "decimal" &&
      newSpec.kind === "decimal" &&
      newSpec.scale !== null &&
      (oldSpec.scale === null || oldSpec.scale > newSpec.scale)
    ) {
      out.push({
        id: `scale:${edit.original}`,
        kind: "scale",
        column: edit.original,
        from: base.type,
        to: edit.type,
        sql: count(`${col} IS NOT NULL AND ROUND(${col}, ${newSpec.scale}) <> ${col}`),
      });
    }
  }
  return out;
}

/** 制約追加の事前検査の入力 (#1757)。 */
export interface ConstraintPrecheckInput {
  /** 追加する外部キー。不完全な行は無視する。 */
  addedForeignKeys?: readonly ForeignKeyDef[];
  /** 追加する CHECK。式が空の行は無視する。 */
  addedChecks?: readonly CheckDef[];
  /** 追加するインデックス。`unique` のものだけ重複検査する。 */
  indexes?: readonly IndexDef[];
  /**
   * 検査できる (= ALTER 前から DB に存在する) 列名。UNIQUE / FK の対象列がここに無い
   * (同じ ALTER で追加・リネームする列) 場合、現状のテーブルに列が無く COUNT が必ず失敗するので検査しない。
   * 省略時は絞り込まない。
   */
  knownColumns?: ReadonlySet<string>;
  /**
   * 同じ ALTER で追加・リネーム後の名前になる列。CHECK の式がこれらの名前を (単語単位で) 含むときは、
   * 現状のテーブルに無い列を参照して COUNT が失敗するので検査しない。
   */
  pendingColumns?: ReadonlySet<string>;
}

/**
 * 制約の追加 (ADD FOREIGN KEY / UNIQUE インデックス / ADD CHECK) で、既存データが違反する行数を数える
 * 読み取り専用の事前検査を作る (#1757)。判定は assertions.rs (referential / unique) と同じ:
 *  - FK: 参照列がすべて非 NULL で、参照先に対応行が無い行 (NULL を含む行は FK の対象外)
 *  - UNIQUE: NULL を含まないキーが重複している行 (NULL は重複扱いにならない。3 ドライバ共通)
 *  - CHECK: `NOT (式)` が真の行 (式が NULL になる行は CHECK を満たす扱い)
 * FK / CHECK の追加と UNIQUE は 3 ドライバとも対象 (SQLite の FK / CHECK は表の再作成で行うが、既存行の検査は同じ SELECT で足りる)。
 * すべて `SELECT COUNT(*) FROM t [AS x] WHERE ...` の形なので `precheckRowsSql` で該当行の SELECT にできる。
 */
export function buildConstraintPrechecks(
  driver: string,
  database: string | null,
  table: string,
  input: ConstraintPrecheckInput,
): AlterPrecheck[] {
  const from = qualified(driver, database, table);
  const q = (n: string) => quoteIdentFor(driver, n.trim());
  const known = input.knownColumns;
  const allKnown = (cols: readonly string[]) => !known || cols.every((c) => known.has(c.trim()));
  const out: AlterPrecheck[] = [];

  if (supportsConstraintAlter(driver)) {
    (input.addedForeignKeys ?? []).filter(isCompleteForeignKey).forEach((fk, i) => {
      const cols = fk.columns.map((c) => c.trim()).filter((c) => c);
      const refs = fk.refColumns.map((c) => c.trim()).filter((c) => c);
      if (!allKnown(cols)) return;
      const target = qualified(driver, database, fk.refTable.trim());
      const notNull = cols.map((c) => `a_src.${q(c)} IS NOT NULL`).join(" AND ");
      const join = cols.map((c, k) => `a_ref.${q(refs[k])} = a_src.${q(c)}`).join(" AND ");
      out.push({
        id: `orphanFk:${i}`,
        kind: "orphanFk",
        column: fk.name.trim() || cols.join(", "),
        from: "",
        to: `FOREIGN KEY (${cols.join(", ")}) → ${fk.refTable.trim()} (${refs.join(", ")})`,
        sql: `SELECT COUNT(*) FROM ${from} AS a_src WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${target} AS a_ref WHERE ${join})`,
      });
    });
    (input.addedChecks ?? []).filter(isCompleteCheck).forEach((ck, i) => {
      const expr = ck.expression.trim();
      const words = expr.match(/[\p{L}\p{N}_$]+/gu) ?? [];
      if (words.some((w) => input.pendingColumns?.has(w))) return;
      out.push({
        id: `checkViolation:${i}`,
        kind: "checkViolation",
        column: ck.name.trim() || expr,
        from: "",
        to: `CHECK (${expr})`,
        // 末尾の `--` コメントが閉じ括弧を巻き込まないよう改行で挟む。
        sql: `SELECT COUNT(*) FROM ${from} WHERE NOT (${expr}\n)`,
      });
    });
  }

  (input.indexes ?? [])
    .filter((idx) => idx.unique)
    .forEach((idx, i) => {
      const cols = idx.columns.map((c) => c.trim()).filter((c) => c);
      if (cols.length === 0 || !allKnown(cols)) return;
      const list = cols.map(q).join(", ");
      const notNull = cols.map((c) => `${q(c)} IS NOT NULL`).join(" AND ");
      // 重複グループに属する行そのものを数える (該当行プレビューで原因の行を見られるように)。
      // 行値 IN は MySQL / PostgreSQL / SQLite (3.15+) 共通。1 列のときは括弧なし。
      const key = cols.length > 1 ? `(${list})` : list;
      out.push({
        id: `duplicateUnique:${i}`,
        kind: "duplicateUnique",
        column: idx.name.trim() || cols.join(", "),
        from: "",
        to: `UNIQUE (${cols.join(", ")})`,
        sql: `SELECT COUNT(*) FROM ${from} WHERE ${notNull} AND ${key} IN (SELECT ${list} FROM ${from} WHERE ${notNull} GROUP BY ${list} HAVING COUNT(*) > 1)`,
      });
    });
  return out;
}

const PRECHECK_COUNT_PREFIX = "SELECT COUNT(*) FROM ";
/** 該当行の確認用 SELECT の既定の行数上限。 */
export const PRECHECK_ROWS_LIMIT = 1000;

/**
 * 事前検査の件数 SQL (`SELECT COUNT(*) FROM t WHERE ...`) を、同じ条件で収まらない行そのものを返す
 * `SELECT * FROM t WHERE ... LIMIT n` に変換する (#1626)。ALTER の前に「どの行が問題か」を見て直せるようにする。
 * 件数 SQL の形でなければ null。
 */
export function precheckRowsSql(countSql: string, limit = PRECHECK_ROWS_LIMIT): string | null {
  if (!countSql.startsWith(PRECHECK_COUNT_PREFIX)) return null;
  const n = Math.max(1, Math.floor(limit));
  return `SELECT * FROM ${countSql.slice(PRECHECK_COUNT_PREFIX.length)} LIMIT ${n};`;
}
