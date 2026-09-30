// DB 全体からの値検索 (#748) の純ロジック。
//
// 走査 SQL の生成 (`SUM(CASE WHEN …)` のテーブル単位クエリ) と行数しきい値の判定、走査結果の
// 集計は **Rust (`src-tauri/src/db/data_search.rs`、#1261) へ移した**。ここに残るのは、
// ヒット行クリックで「その列 / そのテーブルのヒット行」を開くジャンプ SQL の生成
// (`buildColumnJumpSql` / `buildTableJumpSql`) と、それが使う列ごとの検索述語
// (`buildColumnPredicate`) だけ。述語は Rust の走査 SQL と同じ規則でなければならず、
// 共有ゴールデン `fixtures/dataSearchVectors.json` が両側で固定する。
//
// 列型による走査対象の絞り込みは `cellTypeMeta.ts` の `classifyTypeName`
// (CellKind 分類。ResultGrid のセル描画と同じ基準) を再利用し、二重定義しない。
// 識別子のクオートは `sqlDialect.ts`、文字列リテラルのエスケープは `cellEdit.ts`
// の `quoteString` (FK ジャンプ #621 と同じ関数) を、テーブル参照の DB 修飾は
// `fkNavigation.ts` の `qualifiedTable` をそれぞれ再利用する。

import { classifyTypeName, type CellKind } from "./cellTypeMeta";
import { quoteString } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";
import { qualifiedTable } from "../fkNavigation";
import type { ScanColumn } from "../api/tauri";

/** 一致モード: 完全一致 / 部分一致 (contains) / 前方一致。 */
export type MatchMode = "exact" | "contains" | "prefix";

/**
 * 走査における列の扱い。`classifyTypeName` の `CellKind` をさらに粗く分類する:
 * - `text`: LIKE / 完全一致の対象 (文字列・ENUM・JSON)。
 * - `numeric`: 検索語が数値のときだけ等価比較の対象 (整数・小数)。
 * - `excluded`: 既定で走査対象外 (BLOB・真偽値・日時)。BLOB は仕様どおり既定除外。
 */
export type SearchTarget = "text" | "numeric" | "excluded";

export function searchTargetForKind(kind: CellKind): SearchTarget {
  switch (kind) {
    case "string":
    case "enum":
    case "json":
      return "text";
    case "number":
    case "decimal":
      return "numeric";
    default:
      // bool / date / time / binary — 既定除外。
      return "excluded";
  }
}

/** 列の生の型名から直接 {@link SearchTarget} を引く便宜関数。 */
export function searchTargetForDataType(dataType: string): SearchTarget {
  return searchTargetForKind(classifyTypeName(dataType));
}

/** 検索語が数値リテラルとして解釈できるか (`cellEdit.ts` の数値判定と同じ緩さ)。 */
const NUMERIC_TERM_RE = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

export function isNumericTerm(term: string): boolean {
  return NUMERIC_TERM_RE.test(term.trim());
}

/**
 * LIKE パターン中のワイルドカード (`%` `_`) とエスケープ文字自身をエスケープする。
 * バックスラッシュを最初にエスケープしてから `%`/`_` を続けることで、ユーザが
 * 検索語に含めたバックスラッシュ自身がエスケープ記号として誤解釈されるのを防ぐ。
 * 戻り値は SQL クオート前の論理文字列 (呼び出し側で `quoteString` に通す)。
 */
export function escapeLikeWildcards(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * 1 列ぶんの検索述語 (WHERE の断片) を生成する。走査対象外の型・数値列に対する
 * 非数値検索語など、意味のない組み合わせは `null` を返す (呼び出し側で除外する)。
 *
 * - text 列: `exact` は `=`、`contains`/`prefix` は `LIKE` (ワイルドカードを
 *   エスケープし、SQLite でも効くよう常に明示的な `ESCAPE` 句を付ける — SQLite の
 *   LIKE は既定のエスケープ文字を持たないため)。
 * - numeric 列: 検索語が数値のときだけ `=` で等価比較 (一致モードは無視。
 *   部分一致/前方一致は数値の等価比較に意味を持たないため)。
 */
export function buildColumnPredicate(
  driver: string,
  columnName: string,
  kind: CellKind,
  term: string,
  mode: MatchMode,
): string | null {
  const target = searchTargetForKind(kind);
  if (target === "excluded") return null;
  const col = quoteIdentFor(driver, columnName);
  if (target === "numeric") {
    if (!isNumericTerm(term)) return null;
    // 正規表現で数値と確認済みの文字列を正規化してそのまま埋め込む (安全網
    // として Number() を経由し、想定外の表記を弾く)。
    return `${col} = ${Number(term.trim())}`;
  }
  const escapeClause = `ESCAPE ${quoteString(driver, "\\")}`;
  switch (mode) {
    case "exact":
      return `${col} = ${quoteString(driver, term)}`;
    case "prefix":
      return `${col} LIKE ${quoteString(driver, `${escapeLikeWildcards(term)}%`)} ${escapeClause}`;
    case "contains":
    default:
      return `${col} LIKE ${quoteString(driver, `%${escapeLikeWildcards(term)}%`)} ${escapeClause}`;
  }
}

/**
 * 特定 1 列に絞った `SELECT * ... WHERE <col> <op> <term>` を生成する。ヒット
 * 一覧の行クリックから、その列だけに絞った結果を新規タブで開くために使う
 * (FK ジャンプ #621 と同じ「安全なリテラル生成 → 新規タブ」の作法)。走査対象外の
 * 型、または数値列に非数値検索語の組み合わせでは `null`。
 */
export function buildColumnJumpSql(
  driver: string,
  database: string | null | undefined,
  table: string,
  columnName: string,
  dataType: string,
  term: string,
  mode: MatchMode,
): string | null {
  const predicate = buildColumnPredicate(driver, columnName, classifyTypeName(dataType), term, mode);
  if (!predicate) return null;
  return `SELECT * FROM ${qualifiedTable(driver, database, table)} WHERE ${predicate}`;
}

/**
 * テーブル内でヒットした複数列をまとめて `OR` で束ねた `SELECT * ...` を生成する
 * (「このテーブルの全ヒットを一度に見る」用途)。`hitColumns` は `columns` の
 * 部分集合 (ヒットした列名) を渡す。該当する述語が 1 つもなければ `null`。
 */
export function buildTableJumpSql(
  driver: string,
  database: string | null | undefined,
  table: string,
  columns: ScanColumn[],
  hitColumns: string[],
  term: string,
  mode: MatchMode,
): string | null {
  const hitSet = new Set(hitColumns);
  const predicates: string[] = [];
  for (const c of columns) {
    if (!hitSet.has(c.name)) continue;
    const predicate = buildColumnPredicate(driver, c.name, classifyTypeName(c.dataType), term, mode);
    if (predicate) predicates.push(predicate);
  }
  if (predicates.length === 0) return null;
  return `SELECT * FROM ${qualifiedTable(driver, database, table)} WHERE (${predicates.join(" OR ")})`;
}

/** スキャン対象を絞り込む既定の概算行数しきい値。これを超えるテーブルは既定でスキップする。 */
export const DEFAULT_SCAN_ROW_THRESHOLD = 500_000;
