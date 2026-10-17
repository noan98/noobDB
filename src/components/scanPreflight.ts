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
   * トップレベルに LIMIT があり、ORDER BY / GROUP BY / DISTINCT / 集約 / ウィンドウが無い SELECT。
   * 実際に読む行数は LIMIT で頭打ちになりうるので、バッジの警告を和らげる。
   */
  cheapLimit?: boolean;
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
  /** 推定スキャン行数 (全走査ノードの最大値)。推定できなければ null (SQLite は常に null)。 */
  scanRows: number | null;
  /** 全表スキャンのノードだけから取った推定行数 (最大値)。行数が分かる全表スキャンが無ければ null。 */
  fullScanRows: number | null;
  /**
   * 行数が分からない全表スキャンが 1 つでもあるか (PostgreSQL の Filter 付き Seq Scan・
   * SQLite など)。立っていると、他ノードの小さな行数で「軽い」と誤解させないよう警告以上にする。
   */
  unknownRowsFullScan: boolean;
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
  // LIMIT 付きでも ORDER BY / GROUP BY / DISTINCT / 集約 / ウィンドウがあれば全件を読む。
  const cheapLimit =
    texts.includes("limit") &&
    !texts.some(
      (w) => w === "order" || w === "group" || w === "distinct" || w === "having" || w === "over",
    ) &&
    !/\b(count|sum|avg|min|max|group_concat|string_agg|array_agg|json_agg|total)\s*\(/i.test(trimmed);
  return {
    explainSql: `${bundleExplainPrefix(driver)}${sql.trim()}`,
    ...(cheapLimit ? { cheapLimit: true } : {}),
  };
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
  let fullScanRows: number | null = null;
  let unknownRowsFullScan = false;
  let scanNodes = 0;
  // 走査ノード 1 つを記録する。`rows` は推定できなければ null、`table` は全表スキャンのときだけ渡す。
  const note = (rows: number | null, full: boolean, table?: unknown) => {
    scanNodes++;
    if (rows !== null && (scanRows === null || rows > scanRows)) scanRows = rows;
    if (!full) return;
    fullScan = true;
    if (typeof table === "string" && table && !tables.includes(table)) tables.push(table);
    if (rows === null) unknownRowsFullScan = true;
    else if (fullScanRows === null || rows > fullScanRows) fullScanRows = rows;
  };

  // `workers`: 直近の祖先 Gather / Gather Merge の `Workers Planned` (PostgreSQL の並列計画)。
  const visit = (node: PlanNode, workers: number | null): void => {
    let childWorkers = workers;
    if (driver === "sqlite") {
      const detail = attrVal(node, "detail");
      if (
        typeof detail === "string" &&
        SQLITE_SCAN_RE.test(detail) &&
        !/^\s*SCAN\s+CONSTANT\s+ROW\b/i.test(detail)
      ) {
        // 定数行はテーブルを読まない。インデックス指定の無い SCAN だけが全表スキャン
        // (`SCAN t USING [COVERING] INDEX` は全インデックス走査で、テーブル全読みではない)。
        const full = /^\s*SCAN\b/i.test(detail) && !/\bUSING\s+(?:COVERING\s+)?INDEX\b/i.test(detail);
        note(null, full, full ? SQLITE_TABLE_RE.exec(detail)?.[1] : undefined);
      }
    } else if (driver === "postgres") {
      const type = attrVal(node, "Node Type");
      if (typeof type === "string") {
        if (type === "Gather" || type === "Gather Merge")
          childWorkers = parseNum(attrVal(node, "Workers Planned"));
        // CTE / サブクエリ / 関数 / VALUES の走査は実テーブルの走査ではない。
        const isScan =
          /\bScan$/.test(type) && !/^(CTE|Subquery|Function|Table Function|Values|WorkTable)\b/.test(type);
        if (isScan) {
          let rows = parseNum(attrVal(node, "Plan Rows"));
          // 並列スキャンの `Plan Rows` はワーカー 1 つぶん。祖先 Gather の計画ワーカー数で補正する
          // (取れなければ行数は不明)。
          if (rows !== null && attrVal(node, "Parallel Aware") === true) {
            rows = workers === null ? null : rows * (workers + 1);
          }
          // Filter 付きの Seq Scan は `Plan Rows` がフィルタ後の見込み行数で、実際に読む行数
          // (= テーブル全行) を大きく下回る。誤解を招く小さな数字を出さず行数は不明にする。
          const full = type === "Seq Scan";
          if (full && attrVal(node, "Filter") !== undefined) rows = null;
          note(rows, full, full ? attrVal(node, "Relation Name") : undefined);
        }
      }
    } else if (node.kind === "table") {
      // MySQL / MariaDB (`EXPLAIN FORMAT=JSON`)。
      const access = attrVal(node, "access_type");
      if (typeof access === "string") {
        const full = access === "ALL";
        note(
          parseNum(attrVal(node, "rows_examined_per_scan")),
          full,
          full ? attrVal(node, "table_name") : undefined,
        );
      }
    }
    for (const c of node.children) visit(c, childWorkers);
  };
  visit(root, null);

  if (scanNodes === 0) return null;
  return { fullScan, fullScanTables: tables, scanRows, fullScanRows, unknownRowsFullScan, scanNodes };
}

/**
 * バッジの色調。全表スキャン + 大きい推定行数ほど強く警告する。
 * - 推定行数 ≥ 100 万: danger / ≥ 10 万: warning (インデックスを使っていても大量走査は警告)
 * - 行数不明の全表スキャンがある、または全表スキャンの行数 ≥ `SCAN_SMALL_TABLE_ROWS`: warning
 *   (それ未満の小テーブルだけなら neutral)
 * - `cheapLimit` (ソート・集約の無い LIMIT 付き) は実読み取りが LIMIT で頭打ちになりうるので neutral。
 */
export function scanTone(summary: ScanSummary, cheapLimit = false): PreflightTone {
  if (cheapLimit) return "neutral";
  const rows = summary.scanRows;
  if (rows !== null && rows >= ROWS_WARNING_THRESHOLD) return "danger";
  if (rows !== null && rows >= ROWS_CAUTION_THRESHOLD) return "warning";
  if (summary.unknownRowsFullScan) return "warning";
  if (summary.fullScan && summary.fullScanRows !== null && summary.fullScanRows >= SCAN_SMALL_TABLE_ROWS) {
    return "warning";
  }
  return "neutral";
}
