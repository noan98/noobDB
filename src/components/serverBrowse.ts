import { isNumericParam } from "../queryParams";
import { quoteString } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/**
 * テーブル閲覧グリッド (table タブ) 向けのサーバ側ソート/フィルタの純ロジック
 * (#792)。`pagination.ts` の `buildPageSql` は base SQL に LIMIT/OFFSET を
 * 付けるだけで WHERE/ORDER BY を持たないため、ここでその手前に注入する。
 * 呼び出し順は `paginatable base SQL → applyServerBrowse → buildPageSql`。
 *
 * 識別子クオートは `sqlDialect.ts` の `quoteIdentFor`、値リテラル化は
 * `cellEdit.ts` の `quoteString` (方言別バックスラッシュ扱いを含む) を再利用する
 * ため、二重にエスケープ実装を持たない。
 */

export type ServerSortDirection = "asc" | "desc";

export interface ServerSort {
  /** 生のカラム名 (クオートなし)。`quoteIdentFor` で方言別にクオートする。 */
  column: string;
  direction: ServerSortDirection;
}

/**
 * 演算子: 等価 / 非等価 / 部分一致 (LIKE) / NULL 判定 / 比較 (`gt` `gte` `lt`
 * `lte`) / 範囲 (`between`, 両端を含む) / 集合 (`in`, #1149)。
 *
 * `ne` はセル右クリックの「この値を除外する」(#914) と列ヘッダの条件指定で使う。
 * SQL の三値論理どおり `col <> 'x'` は NULL 行にマッチしない — つまり除外の
 * 結果から NULL 行も落ちる。これはクライアント側フィルタ (`ResultGrid` の
 * `columnFilter` は値条件がある行で NULL を弾く) と同じ挙動なので、テーブル
 * ブラウズとクエリ結果のどちらで絞り込んでも見え方が揃う。
 */
export type ServerFilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "isNull"
  | "isNotNull"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in";

/** 比較演算子 → SQL 記号。 */
const COMPARE_SQL: Partial<Record<ServerFilterOp, string>> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** 値入力を 1 つ必要とする演算子 (`between` は 2 つ、`in` は複数値)。 */
export function serverFilterOpNeedsValue(op: ServerFilterOp): boolean {
  return op !== "isNull" && op !== "isNotNull";
}

/**
 * `in` の入力 (カンマまたは改行区切り) を値の配列へ分割する。各要素は前後の
 * 空白を落とし、空要素は捨てる。値自体にカンマを含めることはできない。
 */
export function splitInValues(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * 入力が演算子の要件を満たすか (UI の適用ボタン活性判定用)。`between` は両端、
 * `in` は 1 件以上、`eq` 系・`contains` は空でない値を要求しない (従来どおり)。
 */
export function isServerFilterInputValid(op: ServerFilterOp, value: string, value2?: string): boolean {
  if (op === "between") return value.trim() !== "" && (value2 ?? "").trim() !== "";
  if (op === "in") return splitInValues(value).length > 0;
  return true;
}

export interface ServerFilter {
  column: string;
  op: ServerFilterOp;
  /** ユーザ入力の生値。`isNull`/`isNotNull` では無視される。 */
  value: string;
  /** `between` の上端 (`value` が下端)。他の演算子では無視される。 */
  value2?: string;
  /**
   * 対象カラムが数値型かどうか。true かつ `value` が数値リテラルのときだけ
   * 比較系 (`eq` など) を裸の数値で埋め込む (それ以外は常に安全な文字列リテラル)。
   */
  numeric: boolean;
}

/**
 * LIKE パターン中のワイルドカード (`%` `_`) とエスケープ文字自身 (`\`) を
 * エスケープする。`buildServerFilterClause` は常に明示的な `ESCAPE '\'` を
 * 付けるため、方言のデフォルトエスケープ挙動 (SQLite はデフォルトでは
 * エスケープ文字を持たない) に依存せず全 3 方言で同じ意味になる。
 */
export function escapeLikeValue(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** 数値カラムかつ数値リテラルなら裸の数値、それ以外は方言別にクオートした文字列。 */
function filterLiteral(driver: string, filter: ServerFilter, raw: string): string {
  const trimmed = raw.trim();
  if (filter.numeric && isNumericParam(trimmed)) return trimmed;
  return quoteString(driver, raw);
}

/** 1 つの `ServerFilter` を WHERE 条件の断片 (`col = ...` 等) へ変換する。 */
export function buildServerFilterClause(driver: string, filter: ServerFilter): string {
  const ident = quoteIdentFor(driver, filter.column);
  switch (filter.op) {
    case "isNull":
      return `${ident} IS NULL`;
    case "isNotNull":
      return `${ident} IS NOT NULL`;
    case "contains": {
      const pattern = `%${escapeLikeValue(filter.value)}%`;
      return `${ident} LIKE ${quoteString(driver, pattern)} ESCAPE '\\'`;
    }
    case "between":
      return `${ident} BETWEEN ${filterLiteral(driver, filter, filter.value)} AND ${filterLiteral(driver, filter, filter.value2 ?? "")}`;
    case "in": {
      const items = splitInValues(filter.value);
      // 空集合は何にもマッチしない (`IN ()` は方言によって構文エラーになる)。
      if (items.length === 0) return "1 = 0";
      return `${ident} IN (${items.map((v) => filterLiteral(driver, filter, v)).join(", ")})`;
    }
    case "ne":
    case "eq":
    default: {
      const cmp = COMPARE_SQL[filter.op] ?? "=";
      // eq / ne は従来どおり生値 (trim しない) をクオートする。
      return `${ident} ${cmp} ${filterLiteral(driver, filter, filter.value)}`;
    }
  }
}

/** 1 つの `ServerSort` を ORDER BY 句の断片 (`col ASC` 等) へ変換する。 */
export function buildServerSortClause(driver: string, sort: ServerSort): string {
  return `${quoteIdentFor(driver, sort.column)} ${sort.direction === "desc" ? "DESC" : "ASC"}`;
}

/** `wrapBrowse` で base を包むときの派生テーブル名。 */
export const SERVER_BROWSE_WRAP_ALIAS = "noobdb_src";

/**
 * paginatable な base SQL (`SELECT * FROM ...`、WHERE/ORDER BY/LIMIT を持たない
 * 前提) に、サーバ側フィルタ/ソートを注入する。`filter`/`sort` がどちらも
 * null/undefined なら base をそのまま返す (迷ったら手を加えない、他の安全網と
 * 同じ保守的な方針)。
 *
 * `wrap` が真のときは、base が既に WHERE / ORDER BY 等を持つ (テーブルを開く
 * テンプレート #1253) ので、末尾に句を足さず派生テーブルで包んでから注入する。
 */
export function applyServerBrowse(
  base: string,
  driver: string,
  filter: ServerFilter | null | undefined,
  sort: ServerSort | null | undefined,
  wrap = false,
): string {
  let sql = base;
  if (wrap && (filter || sort)) sql = `SELECT * FROM (${base}) AS ${SERVER_BROWSE_WRAP_ALIAS}`;
  if (filter) sql += ` WHERE ${buildServerFilterClause(driver, filter)}`;
  if (sort) sql += ` ORDER BY ${buildServerSortClause(driver, sort)}`;
  return sql;
}
