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
 * 最小セットの演算子: 等価 / 非等価 / 部分一致 (LIKE) / NULL 判定。
 *
 * `ne` はセル右クリックの「この値を除外する」(#914) と列ヘッダの条件指定で使う。
 * SQL の三値論理どおり `col <> 'x'` は NULL 行にマッチしない — つまり除外の
 * 結果から NULL 行も落ちる。これはクライアント側フィルタ (`ResultGrid` の
 * `columnFilter` は値条件がある行で NULL を弾く) と同じ挙動なので、テーブル
 * ブラウズとクエリ結果のどちらで絞り込んでも見え方が揃う。
 */
export type ServerFilterOp = "eq" | "ne" | "contains" | "isNull" | "isNotNull";

export interface ServerFilter {
  column: string;
  op: ServerFilterOp;
  /** ユーザ入力の生値。`isNull`/`isNotNull` では無視される。 */
  value: string;
  /**
   * 対象カラムが数値型かどうか。true かつ `value` が数値リテラルのときだけ
   * `eq` を裸の数値で埋め込む (それ以外は常に安全な文字列リテラル)。
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
    case "ne":
    case "eq":
    default: {
      const cmp = filter.op === "ne" ? "<>" : "=";
      const trimmed = filter.value.trim();
      if (filter.numeric && isNumericParam(trimmed)) return `${ident} ${cmp} ${trimmed}`;
      return `${ident} ${cmp} ${quoteString(driver, filter.value)}`;
    }
  }
}

/** 1 つの `ServerSort` を ORDER BY 句の断片 (`col ASC` 等) へ変換する。 */
export function buildServerSortClause(driver: string, sort: ServerSort): string {
  return `${quoteIdentFor(driver, sort.column)} ${sort.direction === "desc" ? "DESC" : "ASC"}`;
}

/**
 * paginatable な base SQL (`SELECT * FROM ...`、WHERE/ORDER BY/LIMIT を持たない
 * 前提) に、サーバ側フィルタ/ソートを注入する。`filter`/`sort` がどちらも
 * null/undefined なら base をそのまま返す (迷ったら手を加えない、他の安全網と
 * 同じ保守的な方針)。
 */
export function applyServerBrowse(
  base: string,
  driver: string,
  filter: ServerFilter | null | undefined,
  sort: ServerSort | null | undefined,
): string {
  let sql = base;
  if (filter) sql += ` WHERE ${buildServerFilterClause(driver, filter)}`;
  if (sort) sql += ` ORDER BY ${buildServerSortClause(driver, sort)}`;
  return sql;
}
