// DB 全体からの値検索の **TS オラクル** (#1261)。
//
// 走査 SQL の生成 (`buildTableScanSql`) などは Rust (`src-tauri/src/db/data_search.rs`) へ
// 移植済みで、製品コードにこの実装は無い。移植前の実装 (旧 `components/dataSearch.ts`) を
// そのままテスト資産として残し、共有ゴールデン `fixtures/dataSearchVectors.json` の期待値が
// この実装の出力と一致することを `dataSearchGolden.test.ts` で固定する (Rust 側は同じ
// ベクタを `tests/data_search_golden.rs` が検証する)。
//
// 以下は移植前のコメント。
//
import { classifyTypeName, type CellKind } from "../../components/cellTypeMeta";
import { quoteString } from "../../components/cellEdit";
import { quoteIdentFor } from "../../components/sqlDialect";
import { qualifiedTable } from "../../fkNavigation";

/** 一致モード: 完全一致 / 部分一致 (contains) / 前方一致。 */
export type MatchMode = "exact" | "contains" | "prefix";

/** 走査対象として describeTable の結果から最低限必要な情報。 */
export interface ScanColumn {
  name: string;
  /** `TableColumnInfo.data_type` / `Column.type_name` と同じ語彙の生の型名。 */
  dataType: string;
}

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

/** {@link buildTableScanSql} の戻り値。 */
export interface TableScanSql {
  /** テーブル 1 つを 1 回のクエリで走査する SQL。 */
  sql: string;
  /** SELECT リストと同じ順序の列名 (結果行を位置で対応付けるため名前解決に頼らない)。 */
  columns: string[];
}

/**
 * テーブル 1 つぶんの走査 SQL を生成する。列ごとに `SUM(CASE WHEN <述語> THEN 1
 * ELSE 0 END)` を並べた単一クエリで、1 回のフルスキャンで列ごとのヒット件数を
 * まとめて取得する (列ごとに別クエリを発行しない)。走査対象の列が 1 つもなければ
 * `null` を返す (呼び出し側はテーブルをスキップ扱いにする)。
 */
export function buildTableScanSql(
  driver: string,
  database: string | null | undefined,
  table: string,
  columns: ScanColumn[],
  term: string,
  mode: MatchMode,
): TableScanSql | null {
  const parts: { name: string; predicate: string }[] = [];
  for (const c of columns) {
    const predicate = buildColumnPredicate(driver, c.name, classifyTypeName(c.dataType), term, mode);
    if (predicate) parts.push({ name: c.name, predicate });
  }
  if (parts.length === 0) return null;
  const selectList = parts
    .map(
      ({ name, predicate }) =>
        `SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END) AS ${quoteIdentFor(driver, name)}`,
    )
    .join(", ");
  const sql = `SELECT ${selectList} FROM ${qualifiedTable(driver, database, table)}`;
  return { sql, columns: parts.map((p) => p.name) };
}

/**
 * 概算行数がしきい値を超えるテーブルをスキャン対象から除外すべきかどうか。
 * 推定値が取れない (`null`。SQLite や統計未収集など) 場合は保守的に「除外しない」
 * — 巨大テーブルを誤って弾かないよう、判断材料が無ければ通す。
 */
export function shouldSkipTableForScan(
  estimate: number | null,
  thresholdRows: number,
): boolean {
  if (estimate === null) return false;
  return estimate > thresholdRows;
}

/**
 * `buildTableScanSql` が返した列順の 1 行 (`SUM(CASE...)` の結果) を、列ごとの
 * ヒット件数配列へ変換する。`SUM` は対象行が 0 件だと `NULL` を返すドライバがある
 * ため、`null`/`undefined` は 0 件として扱う。件数 0 の列は除外する。
 */
export function parseScanRow(
  columns: string[],
  row: (number | string | boolean | null)[],
): { column: string; count: number }[] {
  const hits: { column: string; count: number }[] = [];
  for (let i = 0; i < columns.length; i++) {
    const raw = row[i];
    const count = raw === null || raw === undefined ? 0 : Number(raw);
    if (Number.isFinite(count) && count > 0) hits.push({ column: columns[i], count });
  }
  return hits;
}
