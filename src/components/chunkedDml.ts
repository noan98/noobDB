// 大規模 DML のチャンク分割実行 (#2020) の純ロジック。
//
// PostgreSQL は ctid が子表ごとに独立なので (tableoid, ctid) の組で指す。
// SQL 生成は Rust の `db::chunked_dml` をミラーし、共有ゴールデン
// (`__tests__/fixtures/chunkedDmlVectors.json`) で両者を固定する。実行時の SQL は Rust が
// 組み立てる (`run_chunked_dml_batch`) ので、ここの生成はプレビュー表示と対象件数の取得用。

import { qualifiedTableName } from "./sqlDialect";

export const MAX_BATCH_SIZE = 100_000;

export type ChunkedOp = { kind: "delete" } | { kind: "update"; setClause: string };

export type ChunkedDmlErrorCode =
  | "emptyTable"
  | "emptyWhere"
  | "emptySet"
  | "badBatchSize"
  | "stackedStatement"
  | "comment"
  | "unbalanced"
  | "unsupported";

export type ChunkedResult<T> = { ok: true; sql: T } | { ok: false; code: ChunkedDmlErrorCode };

const isIdentChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);

/** WHERE / SET の断片が 1 つの式として括弧に入れられるか (Rust `validate_fragment` と同じ判定)。 */
export function validateFragment(driver: string, frag: string): ChunkedDmlErrorCode | null {
  const chars = Array.from(frag);
  const mysql = driver === "mysql";
  const pg = driver === "postgres";
  const sqlite = driver === "sqlite";
  let depth = 0;
  let i = 0;
  // Stryker disable next-line EqualityOperator: `<=` でも chars[length] は undefined でどの分岐にも入らず、結果が同じ (同値変異)
  while (i < chars.length) {
    const c = chars[i];
    // SQLite の [ident] は ] で閉じる (二重化なし)。
    if (c === "[" && sqlite) {
      const close = chars.indexOf("]", i + 1);
      if (close === -1) return "unbalanced";
      i = close + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      // Stryker disable next-line ConditionalExpression,EqualityOperator: i === 0 では prev が undefined で E 判定に入らず結果が同じ (同値変異)
      if (c === "'" && pg && i > 0) {
        const prev = chars[i - 1];
        const beforeOk = i < 2 || !isIdentChar(chars[i - 2]);
        if ((prev === "e" || prev === "E") && beforeOk) return "unsupported";
      }
      let j = i + 1;
      let closed = false;
      // Stryker disable next-line EqualityOperator: `<=` でも chars[length] は undefined で閉じ判定に入らず結果が同じ (同値変異)
      while (j < chars.length) {
        if (mysql && chars[j] === "\\" && c !== "`") {
          j += 2;
          continue;
        }
        if (chars[j] === c) {
          // Stryker disable next-line ConditionalExpression,BlockStatement: 二重化を無視しても隣接する 2 つのリテラルとして走査され、閉じ忘れ・断片内の記号の判定が変わらない (同値変異)
          if (chars[j + 1] === c) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return "unbalanced";
      i = j + 1;
      continue;
    }
    if (c === ";") return "stackedStatement";
    // Stryker disable next-line ArithmeticOperator: `--` の 2 文字目で必ず検出されるので、前後どちらを見ても結果が同じ (同値変異)
    if (c === "-" && chars[i + 1] === "-") return "comment";
    if (c === "/" && chars[i + 1] === "*") return "comment";
    if (c === "#" && mysql) return "comment";
    if (c === "$" && pg) return "unsupported";
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth < 0) return "unbalanced";
    }
    i += 1;
  }
  return depth === 0 ? null : "unbalanced";
}

function checkCommon(
  driver: string,
  table: string,
  where: string,
  batchSize: number,
): ChunkedDmlErrorCode | null {
  if (table.trim() === "") return "emptyTable";
  if (where.trim() === "") return "emptyWhere";
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) return "badBatchSize";
  return validateFragment(driver, where);
}

/** 1 バッチ分の DML (Rust `build_chunk_sql` のミラー)。 */
export function buildChunkSql(params: {
  driver: string;
  database: string | null;
  table: string;
  op: ChunkedOp;
  where: string;
  batchSize: number;
  /** SQLite のみ: rowid / _rowid_ / oid のうち実列に隠されていないもの。既定 rowid。 */
  rowKey?: string;
}): ChunkedResult<string> {
  const { driver, database, table, op, where, batchSize } = params;
  const bad = checkCommon(driver, table, where, batchSize);
  if (bad) return { ok: false, code: bad };
  let set = "";
  if (op.kind === "update") {
    if (op.setClause.trim() === "") return { ok: false, code: "emptySet" };
    const badSet = validateFragment(driver, op.setClause);
    if (badSet) return { ok: false, code: badSet };
    set = ` SET ${op.setClause.trim()}`;
  }
  const head = op.kind === "delete" ? "DELETE FROM " : "UPDATE ";
  const name = qualifiedTableName(driver, database, table);
  const cond = where.trim();
  if (driver === "mysql") {
    return { ok: true, sql: `${head}${name}${set} WHERE (${cond}) LIMIT ${batchSize}` };
  }
  if (driver === "postgres") {
    return {
      ok: true,
      sql: `${head}${name}${set} WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM ${name} WHERE (${cond}) LIMIT ${batchSize})`,
    };
  }
  const key = params.rowKey ?? "rowid";
  return {
    ok: true,
    sql: `${head}${name}${set} WHERE ${key} IN (SELECT ${key} FROM ${name} WHERE (${cond}) LIMIT ${batchSize})`,
  };
}

/** 対象件数を数える SELECT (Rust `build_count_sql` のミラー)。 */
export function buildCountSql(params: {
  driver: string;
  database: string | null;
  table: string;
  where: string;
}): ChunkedResult<string> {
  const bad = checkCommon(params.driver, params.table, params.where, 1);
  if (bad) return { ok: false, code: bad };
  return {
    ok: true,
    sql: `SELECT COUNT(*) FROM ${qualifiedTableName(params.driver, params.database, params.table)} WHERE (${params.where.trim()})`,
  };
}

/**
 * 実行ループの最大バッチ数。「0 行になったら終了」とは別の安全弁で、UPDATE の WHERE が更新後も
 * 真のままだと同じ行を延々と更新し続けるため、対象件数から見込まれるバッチ数の 2 倍 + 3 を超えたら止める。
 */
export function maxBatchesFor(totalRows: number, batchSize: number): number {
  const expected = Math.ceil(Math.max(0, totalRows) / Math.max(1, batchSize));
  return expected * 2 + 3;
}

/** SQLite で行を指す別名 (Rust `pick_sqlite_row_key`)。実列に隠されていない最初のもの。全部隠されていれば null。 */
export function pickSqliteRowKey(columnNames: readonly string[]): string | null {
  const lower = columnNames.map((c) => c.toLowerCase());
  return ["rowid", "_rowid_", "oid"].find((k) => !lower.includes(k)) ?? null;
}
