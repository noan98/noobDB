import { quoteString } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/**
 * PostgreSQL の ENUM 型に値を足す / 値の名前を変える `ALTER TYPE` の組み立て (#2127)。
 * 純関数にして、リテラルのエスケープと値の検証をテストで固定する。実行は通常のクエリ経路
 * (`run_query`) を通るので、read_only の拒否はバックエンドが行う。
 */

/** `pg_enum.enumlabel` の上限 (NAMEDATALEN - 1 = 63 バイト)。 */
export const ENUM_LABEL_MAX_BYTES = 63;

/** 新しい値を置く位置。`end` は末尾 (位置の指定なし)。 */
export type EnumValuePosition = { kind: "end" } | { kind: "before" | "after"; reference: string };

/**
 * `CREATE TYPE ... AS ENUM ('a', 'b')` (バックエンドの `object_definition` の出力) から値の並びを読む。
 * `quote_literal` が出す `'a''b'` と `E'a\\b'` を戻す。読めない形なら null。
 */
export function parseEnumLabels(ddl: string): string[] | null {
  const m = /\bAS\s+ENUM\s*\(/i.exec(ddl);
  if (!m) return null;
  const body = ddl.slice(m.index + m[0].length);
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === ")") return out;
    if (c === "," || /\s/.test(c)) {
      i++;
      continue;
    }
    let escaped = false;
    if (c === "E" || c === "e") {
      escaped = true;
      i++;
    }
    if (body[i] !== "'") return null;
    i++;
    let v = "";
    for (;;) {
      if (i >= body.length) return null;
      const ch = body[i];
      if (ch === "'") {
        if (body[i + 1] === "'") {
          v += "'";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      if (escaped && ch === "\\" && i + 1 < body.length) {
        v += body[i + 1];
        i += 2;
        continue;
      }
      v += ch;
      i++;
    }
    out.push(v);
  }
  return null;
}

/** ENUM の値を SQL リテラルにする。`\` を含むときは `E'...'` で確実に 1 文字として渡す。 */
export function enumValueLiteral(value: string): string {
  if (value.includes("\\")) return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  return quoteString("postgres", value);
}

/** 値の検証エラー。null なら適用できる。 */
export type EnumValueError = "empty" | "duplicate" | "tooLong";

export function validateEnumValue(value: string, existing: readonly string[]): EnumValueError | null {
  if (value === "") return "empty";
  if (new TextEncoder().encode(value).length > ENUM_LABEL_MAX_BYTES) return "tooLong";
  if (existing.includes(value)) return "duplicate";
  return null;
}

function typeRef(database: string, name: string): string {
  return `${quoteIdentFor("postgres", database)}.${quoteIdentFor("postgres", name)}`;
}

/** `ALTER TYPE ... ADD VALUE ... [BEFORE|AFTER ...]`。 */
export function buildAddEnumValueSql(
  database: string,
  name: string,
  value: string,
  position: EnumValuePosition,
): string {
  const where =
    position.kind === "end"
      ? ""
      : ` ${position.kind === "before" ? "BEFORE" : "AFTER"} ${enumValueLiteral(position.reference)}`;
  return `ALTER TYPE ${typeRef(database, name)} ADD VALUE ${enumValueLiteral(value)}${where};`;
}

/** `ALTER TYPE ... RENAME VALUE ... TO ...`。 */
export function buildRenameEnumValueSql(database: string, name: string, from: string, to: string): string {
  return `ALTER TYPE ${typeRef(database, name)} RENAME VALUE ${enumValueLiteral(from)} TO ${enumValueLiteral(to)};`;
}

/**
 * 新しい値が並びのどこに入るか (`existing` の何番目の前か)。`ADD VALUE ... BEFORE / AFTER` の意味と同じで、
 * 末尾は `existing.length`。基準値が見つからないときは末尾 (SQL は基準なしでは組み立てない)。
 * ゴーストチップの位置とプレビュー SQL がずれないよう、同じ `position` から計算する (#2158)。
 */
export function ghostInsertIndex(existing: readonly string[], position: EnumValuePosition): number {
  if (position.kind === "end") return existing.length;
  const i = existing.indexOf(position.reference);
  if (i < 0) return existing.length;
  return position.kind === "before" ? i : i + 1;
}

/**
 * 値チップ列 (radiogroup) の矢印キー移動。`count` 個のうち `current` 番目から `key` で動いた先を返す
 * (端で止まる。対象外のキーは null)。
 */
export function stepChipIndex(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return Math.min(count - 1, current + 1);
    case "ArrowLeft":
    case "ArrowUp":
      return Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
