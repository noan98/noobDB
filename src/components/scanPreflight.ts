// SELECT 実行前のスキャン行数 / フルスキャン警告プリフライト (#1508) の純ロジック。
//
// エディタの現在文が単純な SELECT のとき、裏で EXPLAIN を実行し、プランから
// 「推定スキャン行数」と「インデックスを使わない全表スキャンの有無」を取り出す。
// UI はこれを影響行数プリフライト (`preflight.ts`) と同じゼロ操作バッジで表示する。
//
// **保守的判定 (迷ったら何もしない / 降格する)**: `preflight.ts` と同じ方針。
// - 対象外 (SELECT 以外・複数文・`SELECT ... INTO`・ロック句付き・FROM なし) は `null`
//   (バッジ自体を出さない)。
// - SELECT でも UNION / INTERSECT / EXCEPT・サブクエリは `explainSql: null` に降格
//   (「推定不可」)。プランの葉をどう足すか一意に決まらないため。`WITH` で始まる文は
//   PostgreSQL ではデータ変更 CTE がありうるので対象外 (`null`)。
//
// **ドライバ別の EXPLAIN 出力の正規化**: 既存の `explainPlan.ts` のパーサ
// (`parseExplainForDriver`) を再利用し、プランノードから次を取り出す。
// - MySQL (`EXPLAIN FORMAT=JSON`): `table` ノードの `access_type = ALL` が全表スキャン、
//   行数は `rows_examined_per_scan` (走査する行数の推定)。
// - PostgreSQL (`EXPLAIN (FORMAT JSON)`): `Seq Scan` が全表スキャン、行数は走査ノードの
//   `Plan Rows` (**フィルタ適用後にそのノードが返す見込み行数**)。
//   `Filter` 付きの Seq Scan は読む行数より桁違いに小さく出るため、行数は採らず
//   (全表スキャンの警告だけ出す)、フィルタ無しの Seq Scan とインデックス系の走査だけ採る。
// - SQLite (`EXPLAIN QUERY PLAN`): `SCAN <table>` (インデックス指定なし) が全表スキャン。
//   行数の推定は持たないので `scanRows` は常に null。
// 行数は複数の走査ノードがあるとき**最大値**を採る (JOIN の積は推定できないため、
// 最も重い 1 走査で下限を示す)。
//
// 副作用が無いので Vitest (`src/__tests__/scanPreflight.test.ts`) でユニットテストする。

import type { QueryResult } from "../api/tauri";
import { maskLiterals, trimTrailingSeparators } from "../dangerousSql";
import { bundleExplainPrefix } from "./investigationBundle";
import {
  attrVal,
  parseExplainForDriver,
  parseNum,
  ROWS_CAUTION_THRESHOLD,
  ROWS_WARNING_THRESHOLD,
  type PlanNode,
} from "./explainPlan";
import { maskedTopLevelWords, PREFLIGHT_MAX_CHARS, type PreflightTone } from "./preflight";

export interface ScanPlan {
  /**
   * 裏実行する `EXPLAIN ...` 文。**変換可能な単純 SELECT のときだけ**非 null。UNION・
   * サブクエリなど解析対象外の形状では null (= UI は「推定不可」を表示)。
   */
  explainSql: string | null;
}

export interface ScanSummary {
  /** インデックスを使わない全表スキャンが 1 つでもあるか。 */
  fullScan: boolean;
  /** 全表スキャンの対象テーブル名 (取れた分のみ、重複なし)。 */
  fullScanTables: string[];
  /** 推定スキャン行数 (走査ノードの最大値)。推定できなければ null (SQLite は常に null)。 */
  scanRows: number | null;
  /** プラン内の走査ノード数。0 のときは何も表示しない。 */
  scanNodes: number;
}

/** フルスキャンでも行数がこの値未満なら注意を促さない (開発 DB の小テーブルでの誤警告を避ける)。 */
export const SCAN_SMALL_TABLE_ROWS = 1_000;

/** 「推定不可」へ降格するトップレベルの集合演算キーワード。 */
const SET_OPERATORS = new Set(["union", "intersect", "except", "minus"]);

/**
 * 単一文の単純な SELECT をスキャンプリフライト用の `ScanPlan` へ変換する。
 *
 * - 対象外のときは **null** (バッジを出さない)。
 * - SELECT だが解析対象外の形状 (集合演算・サブクエリ) のときは `{ explainSql: null }`。
 * - 解析できる形状では EXPLAIN 文を伴う計画を返す。
 */
export function buildScanPlan(sql: string, driver?: string): ScanPlan | null {
  if (sql.length > PREFLIGHT_MAX_CHARS) return null;
  const masked = maskLiterals(sql, driver);
  const trimmed = trimTrailingSeparators(masked);
  if (trimmed.length === 0) return null;
  // 文字列内の `;` はマスクで空白化済み。ここに残る `;` は複数文。
  if (trimmed.includes(";")) return null;
  const words = maskedTopLevelWords(masked, 0, trimmed.length);
  if (words.length === 0 || words[0].text !== "select") return null;
  const texts = words.map((w) => w.text);
  // `SELECT ... INTO` (変数 / 新規テーブル / OUTFILE) とロック句 (`FOR UPDATE` /
  // `LOCK IN SHARE MODE`) は読み取りだけの SELECT ではないので対象外。
  if (texts.includes("into") || texts.includes("for") || texts.includes("lock")) return null;
  // FROM の無い SELECT (`SELECT 1`) はスキャンが無い。
  if (!texts.includes("from")) return null;
  if (texts.some((w) => SET_OPERATORS.has(w))) return { explainSql: null };
  // サブクエリ (括弧内の SELECT)。マスク済み文字列なので文字列リテラル内は誤検出しない。
  if (/\(\s*(select|with)\b/i.test(trimmed)) return { explainSql: null };
  return { explainSql: `${bundleExplainPrefix(driver)}${sql.trim()}` };
}

/** プランツリーの全ノードを走査する。 */
function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

// SQLite の走査ステップ: `SCAN t` / `SCAN TABLE t` / `SEARCH t USING INDEX ...`。
const SQLITE_SCAN_RE = /^\s*(SCAN|SEARCH)\b/i;
const SQLITE_TABLE_RE = /^\s*(?:SCAN|SEARCH)\s+(?:TABLE\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)/i;

/**
 * EXPLAIN の結果をドライバ横断の `ScanSummary` に正規化する。パースできない・走査ノードが
 * 無いときは null。
 */
export function summarizeScan(driver: string, result: QueryResult | null): ScanSummary | null {
  const { root, error } = parseExplainForDriver(driver, result);
  if (!root || error) return null;

  let fullScan = false;
  const tables: string[] = [];
  let scanRows: number | null = null;
  let scanNodes = 0;
  const noteRows = (n: number | null) => {
    if (n !== null && (scanRows === null || n > scanRows)) scanRows = n;
  };
  const noteFull = (table: unknown) => {
    fullScan = true;
    if (typeof table === "string" && table && !tables.includes(table)) tables.push(table);
  };

  walk(root, (node) => {
    if (driver === "sqlite") {
      const detail = attrVal(node, "detail");
      if (typeof detail !== "string" || !SQLITE_SCAN_RE.test(detail)) return;
      // 定数行 (`SCAN CONSTANT ROW`) はテーブルを読まない。
      if (/^\s*SCAN\s+CONSTANT\s+ROW\b/i.test(detail)) return;
      scanNodes++;
      // インデックス指定の無い SCAN だけが全表スキャン (`SCAN t USING [COVERING] INDEX` は
      // 全インデックス走査で、テーブル全読みではない)。
      if (/^\s*SCAN\b/i.test(detail) && !/\bUSING\s+(?:COVERING\s+)?INDEX\b/i.test(detail)) {
        noteFull(SQLITE_TABLE_RE.exec(detail)?.[1]);
      }
      return;
    }
    if (driver === "postgres") {
      const type = attrVal(node, "Node Type");
      if (typeof type !== "string" || !/\bScan$/.test(type)) return;
      // CTE / サブクエリ / 関数 / VALUES の走査は実テーブルの走査ではない。
      if (/^(CTE|Subquery|Function|Table Function|Values|WorkTable)\b/.test(type)) return;
      scanNodes++;
      // Filter 付きの Seq Scan は `Plan Rows` がフィルタ後の見込み行数で、実際に読む行数
      // (= テーブル全行) を大きく下回る。誤解を招く小さな数字を出さず行数は不明にする。
      const filtered = attrVal(node, "Filter") !== undefined;
      if (!(type === "Seq Scan" && filtered)) noteRows(parseNum(attrVal(node, "Plan Rows")));
      if (type === "Seq Scan") noteFull(attrVal(node, "Relation Name"));
      return;
    }
    // MySQL / MariaDB (`EXPLAIN FORMAT=JSON`)。
    if (node.kind !== "table") return;
    const access = attrVal(node, "access_type");
    if (typeof access !== "string") return;
    scanNodes++;
    noteRows(parseNum(attrVal(node, "rows_examined_per_scan")));
    if (access === "ALL") noteFull(attrVal(node, "table_name"));
  });

  if (scanNodes === 0) return null;
  return { fullScan, fullScanTables: tables, scanRows, scanNodes };
}

/**
 * バッジの色調。全表スキャン + 大きい推定行数ほど強く警告する。
 * - 推定行数 ≥ 100 万: danger / ≥ 10 万: warning (インデックスを使っていても大量走査は警告)
 * - 全表スキャン: 行数不明 (SQLite) または ≥ `SCAN_SMALL_TABLE_ROWS` なら warning、
 *   それ未満の小テーブルは neutral
 */
export function scanTone(summary: ScanSummary): PreflightTone {
  const rows = summary.scanRows;
  if (rows !== null && rows >= ROWS_WARNING_THRESHOLD) return "danger";
  if (rows !== null && rows >= ROWS_CAUTION_THRESHOLD) return "warning";
  if (summary.fullScan && (rows === null || rows >= SCAN_SMALL_TABLE_ROWS)) return "warning";
  return "neutral";
}
