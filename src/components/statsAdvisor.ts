// 実行計画の「推定行数のズレ」から打てる統計の手当て (統計の鮮度の読み取りと、ANALYZE / 拡張統計 /
// ヒストグラムの SQL 生成)。#2327。
//
// 実行計画のノードから対象テーブルと条件に出てくる列を拾い、ドライバごとに
// - 統計の鮮度を読む SELECT (`runLookupQuery` で流す読み取り専用クエリ) とその結果のパース
// - 打ち手 (ANALYZE / CREATE STATISTICS / SET STATISTICS / UPDATE HISTOGRAM / DROP …) の SQL
// を組み立てる。ここは副作用の無い純関数に徹し (識別子のクォートと版による分岐をテストで固定する)、
// 実行は既存の保守経路 (確認・read_only 拒否・本番の承認) に任せる。

import type { CellValue, QueryResult } from "../api/tauri";
import type { I18nKey } from "../i18n";
import type { PlanNode } from "./explainPlan";
import { nodeMisestimate } from "./explainPlan";
import { fitPgName, qualifiedTableName, quoteIdentFor } from "./sqlDialect";

// --- 対象テーブルと条件の列 --------------------------------------------------

/** ノード (とその子孫) から読み取れる統計の対象テーブル。 */
export interface StatsTable {
  /** PostgreSQL のスキーマ (EXPLAIN VERBOSE のときだけ分かる)。不明なら null。 */
  schema: string | null;
  table: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function unquoteName(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith("`") && s.endsWith("`")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).replace(/``/g, "`").replace(/""/g, '"');
  }
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1);
  return s;
}

const NAME = '(`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)?)';
/** MySQL の EXPLAIN ANALYZE の行: `Table scan on t` / `Index lookup on t using ix (a=1)` など。 */
const MYSQL_TABLE_RE = new RegExp(`(?:scan|lookup|read|seek)\\s+on\\s+${NAME}`, "i");
/** SQLite の `SCAN t` / `SEARCH t USING INDEX ix (a=?)` / 旧形式の `SCAN TABLE t`。 */
const SQLITE_TABLE_RE = new RegExp(`^\\s*(?:SCAN|SEARCH)\\s+(?:TABLE\\s+)?${NAME}`, "i");

function splitQualified(raw: string, driver: string): StatsTable {
  const name = unquoteName(raw);
  const dot = name.indexOf(".");
  // クォート済みの名前は 1 つの識別子として扱う (中の `.` で分けない)。
  if (dot > 0 && !/^["`\[]/.test(raw.trim())) {
    const schema = name.slice(0, dot);
    const table = name.slice(dot + 1);
    return { schema: driver === "postgres" ? schema : schema, table };
  }
  return { schema: null, table: name };
}

/** 1 ノード自身が指すテーブル (無ければ null)。 */
export function nodeStatsTable(node: PlanNode, driver: string): StatsTable | null {
  if (driver === "postgres") {
    const rel = str(node.attrs.find(([k]) => k === "Relation Name")?.[1]);
    if (!rel) return null;
    return { schema: str(node.attrs.find(([k]) => k === "Schema")?.[1]), table: rel };
  }
  if (driver === "sqlite") {
    const m = SQLITE_TABLE_RE.exec(node.label);
    return m ? { schema: null, table: unquoteName(m[1]) } : null;
  }
  // MySQL: JSON 形式は `table` キーのノードが `table_name` を持ち、行フォーマット (EXPLAIN ANALYZE) はラベルに出る。
  const tn = str(node.attrs.find(([k]) => k === "table_name")?.[1]);
  if (tn) return { schema: null, table: tn };
  const m = MYSQL_TABLE_RE.exec(node.label);
  return m ? splitQualified(m[1], driver) : null;
}

/** ノード自身 → 子孫の順に、重複なしでテーブルを集める (Filter のノードの表は子の走査ノードにある)。 */
export function planStatsTables(node: PlanNode, driver: string): StatsTable[] {
  const out: StatsTable[] = [];
  const seen = new Set<string>();
  const walk = (n: PlanNode) => {
    const t = nodeStatsTable(n, driver);
    if (t) {
      const key = `${t.schema ?? ""}.${t.table}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** 統計の欄を出すノードか。推定ズレのあるノード (実測モード) と、実測を持たない SQLite の表アクセス。 */
export function showsStatsSection(node: PlanNode, driver: string): boolean {
  if (nodeMisestimate(node).level !== "") return true;
  return driver === "sqlite" && nodeStatsTable(node, driver) !== null;
}

const CONDITION_ATTRS = new Set([
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Join Filter",
  "Hash Cond",
  "Merge Cond",
  "attached_condition",
  "index_condition",
]);

/** 列名になりえない SQL のキーワード。型名などは `::型` を先に落としているので入れない (列名と衝突する)。 */
const NON_COLUMN_WORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "true",
  "false",
  "in",
  "any",
  "all",
  "some",
  "array",
  "like",
  "ilike",
  "between",
  "similar",
  "to",
  "escape",
  "case",
  "when",
  "then",
  "else",
  "end",
  "as",
  "exists",
  "distinct",
  "from",
  "select",
  "interval",
  "cast",
  "with",
  "without",
  "time",
  "zone",
]);

/**
 * 条件式の文字列から、列名らしい識別子を拾う。リテラル・型キャスト・数値は落とし、`t.col` は `col` にする。
 * 候補は列名として確かか分からない (関数名・別名もありうる) ので、呼び出し側が実際の列一覧と突き合わせる。
 */
export function extractConditionIdentifiers(text: string): string[] {
  const cleaned = text
    .replace(/'(?:[^']|'')*'/g, " ") // 文字列リテラル
    .replace(/::[A-Za-z_][\w ]*(?:\([^)]*\))?(?:\[\])?/g, " ") // PostgreSQL の型キャスト
    .replace(/\b\d+(?:\.\d+)?\b/g, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:[A-Za-z_][\w$]*\.)?(`[^`]+`|"[^"]+"|[A-Za-z_][\w$]*)(?![\w$]|\s*\()/g;
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
    const id = unquoteName(m[1]);
    const lower = id.toLowerCase();
    const quoted = m[1].startsWith('"') || m[1].startsWith("`");
    if (!quoted && NON_COLUMN_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(id);
  }
  return out;
}

/** ノードの条件 (Filter / Index Cond など。MySQL・SQLite はラベル) に出てくる識別子の候補。 */
export function nodeConditionIdentifiers(node: PlanNode, driver: string): string[] {
  const texts: string[] = [];
  if (driver === "postgres" || driver === "mysql") {
    for (const [k, v] of node.attrs) if (CONDITION_ATTRS.has(k) && typeof v === "string") texts.push(v);
  }
  if (driver !== "postgres") texts.push(node.label);
  return extractConditionIdentifiers(texts.join(" "));
}

/** 子孫を含む全ノードの条件識別子 (重複なし、出現順)。 */
export function planConditionIdentifiers(node: PlanNode, driver: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: PlanNode) => {
    for (const id of nodeConditionIdentifiers(n, driver)) {
      const k = id.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(id);
      }
    }
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** 実際の列一覧と突き合わせ、条件に出てくる列を列一覧の綴りで返す (大文字小文字は区別しない)。 */
export function pickFilterColumns(candidates: readonly string[], columns: readonly string[]): string[] {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const out: string[] = [];
  for (const c of candidates) {
    const real = byLower.get(c.toLowerCase());
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

// --- サーバ版 ---------------------------------------------------------------

export interface ServerVersion {
  major: number;
  minor: number;
  /** MariaDB。MySQL 8.0 のヒストグラム構文は使えない。 */
  mariadb: boolean;
}

/**
 * `SELECT VERSION()` (MySQL: `8.0.34` / `10.6.12-MariaDB`) と `current_setting('server_version_num')`
 * (PostgreSQL: `160002`) の値を読む。読めなければ null。
 */
export function parseServerVersion(driver: string, raw: string | null): ServerVersion | null {
  if (!raw) return null;
  const s = raw.trim();
  if (driver === "postgres") {
    const n = Number(s);
    // 9.x は 90600 のように 9 + 分版の形 (major=9, minor=6)。10 以降は 160002 (major=16)。
    if (!Number.isInteger(n) || n < 9_0000) return null;
    return { major: Math.floor(n / 10000), minor: Math.floor((n % 10000) / 100), mariadb: false };
  }
  const m = /^(\d+)\.(\d+)/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), mariadb: /mariadb/i.test(s) };
}

/**
 * MySQL のヒストグラム (`ANALYZE TABLE … UPDATE HISTOGRAM`) は 8.0 以降の MySQL のみ。
 * 版が分からないときは塞がない (非対応ならサーバがエラーを返す)。
 */
export function supportsHistogram(driver: string, version: ServerVersion | null): boolean {
  if (driver !== "mysql") return false;
  if (!version) return true;
  return !version.mariadb && version.major >= 8;
}

/** PostgreSQL の拡張統計は 10 以降。MCV 型は 12 以降。版が分からないときは塞がない。 */
export function supportsExtendedStatistics(driver: string, version: ServerVersion | null): boolean {
  if (driver !== "postgres") return false;
  return !version || version.major >= 10;
}

export function supportsMcvStatistics(driver: string, version: ServerVersion | null): boolean {
  if (driver !== "postgres") return false;
  return !version || version.major >= 12;
}

// --- 読み取りクエリ (runLookupQuery 用の SELECT) -----------------------------

function lit(driver: string, s: string): string {
  const escaped = driver === "mysql" ? s.replace(/\\/g, "\\\\").replace(/'/g, "''") : s.replace(/'/g, "''");
  return `'${escaped}'`;
}

/** サーバ版を読む SELECT。SQLite は版で分岐しないので null。 */
export function serverVersionSql(driver: string): string | null {
  if (driver === "postgres") return "SELECT current_setting('server_version_num')";
  if (driver === "mysql") return "SELECT VERSION()";
  return null;
}

/** 対象テーブルの列名を順に返す SELECT。 */
export function columnsSql(driver: string, t: StatsTable, database: string | null): string {
  if (driver === "sqlite") return `SELECT name FROM pragma_table_info(${lit(driver, t.table)})`;
  if (driver === "postgres") {
    const schema = t.schema ?? database;
    const where = schema
      ? `table_schema = ${lit(driver, schema)}`
      : "table_schema = ANY (current_schemas(false))";
    return `SELECT column_name FROM information_schema.columns WHERE ${where} AND table_name = ${lit(driver, t.table)} ORDER BY ordinal_position`;
  }
  const schema = t.schema ?? database;
  const where = schema ? `table_schema = ${lit(driver, schema)}` : "table_schema = DATABASE()";
  return `SELECT column_name FROM information_schema.columns WHERE ${where} AND table_name = ${lit(driver, t.table)} ORDER BY ordinal_position`;
}

/**
 * 統計の鮮度を読む SELECT (複数)。
 * - PostgreSQL: `pg_stat_user_tables` の `last_analyze` / `last_autoanalyze` / `n_mod_since_analyze`
 * - MySQL: `mysql.innodb_table_stats.last_update` (`mysql` スキーマの読み取り権限が要る)
 * - SQLite: `sqlite_stat1` / `sqlite_stat4` の有無と `sqlite_stat1` の中身
 */
export function freshnessSql(driver: string, t: StatsTable, database: string | null): string[] {
  if (driver === "postgres") {
    const schema = t.schema ?? database;
    const where = schema
      ? `schemaname = ${lit(driver, schema)}`
      : "schemaname = ANY (current_schemas(false))";
    return [
      `SELECT schemaname, relname, last_analyze, last_autoanalyze, n_mod_since_analyze, n_live_tup FROM pg_stat_user_tables WHERE ${where} AND relname = ${lit(driver, t.table)}`,
    ];
  }
  if (driver === "sqlite") {
    return [
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sqlite_stat1', 'sqlite_stat4')",
      `SELECT idx, stat FROM sqlite_stat1 WHERE tbl = ${lit(driver, t.table)}`,
    ];
  }
  const schema = t.schema ?? database;
  const where = schema ? `database_name = ${lit(driver, schema)}` : "database_name = DATABASE()";
  return [
    `SELECT last_update, n_rows FROM mysql.innodb_table_stats WHERE ${where} AND table_name = ${lit(driver, t.table)}`,
  ];
}

/** 既存の拡張統計 (PostgreSQL) / ヒストグラム (MySQL) を読む SELECT。SQLite は無いので null。 */
export function statsObjectsSql(driver: string, t: StatsTable, database: string | null): string | null {
  if (driver === "postgres") {
    const schema = t.schema ?? database;
    const where = schema ? `n.nspname = ${lit(driver, schema)}` : "n.nspname = ANY (current_schemas(false))";
    return (
      "SELECT sn.nspname, e.stxname, pg_get_statisticsobjdef(e.oid), e.stxkind::text " +
      "FROM pg_statistic_ext e JOIN pg_class c ON c.oid = e.stxrelid " +
      "JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_namespace sn ON sn.oid = e.stxnamespace " +
      `WHERE ${where} AND c.relname = ${lit(driver, t.table)} ORDER BY e.stxname`
    );
  }
  if (driver === "mysql") {
    const schema = t.schema ?? database;
    const where = schema ? `schema_name = ${lit(driver, schema)}` : "schema_name = DATABASE()";
    return (
      "SELECT column_name, JSON_UNQUOTE(JSON_EXTRACT(histogram, '$.\"histogram-type\"')), " +
      "JSON_EXTRACT(histogram, '$.\"number-of-buckets-specified\"'), " +
      "JSON_UNQUOTE(JSON_EXTRACT(histogram, '$.\"last-updated\"')) " +
      `FROM information_schema.COLUMN_STATISTICS WHERE ${where} AND table_name = ${lit(driver, t.table)} ORDER BY column_name`
    );
  }
  return null;
}

// --- 読み取り結果のパース ----------------------------------------------------

function cellStr(v: CellValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function cellNum(v: CellValue | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 統計の鮮度 (ドライバで取れる範囲)。取れない項目は null。 */
export interface StatsFreshness {
  /** この表の統計を最後に取り直した時刻 (PostgreSQL: last_analyze / MySQL: innodb_table_stats.last_update)。 */
  lastAnalyze: string | null;
  /** PostgreSQL: autovacuum による最後の ANALYZE。 */
  lastAutoAnalyze: string | null;
  /** PostgreSQL: 最後の ANALYZE 以降に変更された行数の推定。 */
  modsSinceAnalyze: number | null;
  /** 統計テーブル / pg_stat の行が見つかったか (false なら一度も取っていない / 見えない)。 */
  found: boolean;
  /** SQLite のみ。 */
  sqlite: {
    hasStat1: boolean;
    hasStat4: boolean;
    entries: { index: string | null; stat: string }[];
  } | null;
}

/** `freshnessSql` の結果を読む。`results` は SQL と同じ順 (失敗したクエリは null)。 */
export function parseFreshness(driver: string, results: readonly (QueryResult | null)[]): StatsFreshness {
  const empty: StatsFreshness = {
    lastAnalyze: null,
    lastAutoAnalyze: null,
    modsSinceAnalyze: null,
    found: false,
    sqlite: null,
  };
  if (driver === "sqlite") {
    const names = new Set((results[0]?.rows ?? []).map((r) => String(r[0]).toLowerCase()));
    const entries = (results[1]?.rows ?? []).map((r) => ({ index: cellStr(r[0]), stat: String(r[1] ?? "") }));
    const hasStat1 = names.has("sqlite_stat1");
    return {
      ...empty,
      found: entries.length > 0,
      sqlite: { hasStat1, hasStat4: names.has("sqlite_stat4"), entries },
    };
  }
  const row = results[0]?.rows[0];
  if (!row) return empty;
  if (driver === "postgres") {
    return {
      ...empty,
      found: true,
      lastAnalyze: cellStr(row[2]),
      lastAutoAnalyze: cellStr(row[3]),
      modsSinceAnalyze: cellNum(row[4]),
    };
  }
  return { ...empty, found: true, lastAnalyze: cellStr(row[0]) };
}

/** 既存の拡張統計 (PostgreSQL)。 */
export interface ExtendedStatistic {
  schema: string;
  name: string;
  /** `pg_get_statisticsobjdef` の定義 (CREATE STATISTICS …)。 */
  definition: string;
  /** `d` 依存関係 / `f` ndistinct / `m` MCV / `e` 式。 */
  kinds: string[];
}

/** 既存のヒストグラム (MySQL)。 */
export interface ColumnHistogram {
  column: string;
  type: string | null;
  buckets: number | null;
  lastUpdated: string | null;
}

export function parseExtendedStatistics(res: QueryResult | null): ExtendedStatistic[] {
  return (res?.rows ?? []).map((r) => ({
    schema: String(r[0] ?? ""),
    name: String(r[1] ?? ""),
    definition: String(r[2] ?? ""),
    kinds: String(r[3] ?? "")
      .replace(/[{}]/g, "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k !== ""),
  }));
}

export function parseHistograms(res: QueryResult | null): ColumnHistogram[] {
  return (res?.rows ?? []).map((r) => ({
    column: String(r[0] ?? ""),
    type: cellStr(r[1]),
    buckets: cellNum(r[2]),
    lastUpdated: cellStr(r[3]),
  }));
}

// --- 打ち手の SQL ------------------------------------------------------------

/** 打ち手を作れない理由 (UI は i18n キーで文言にする)。 */
export type StatsBlockReason =
  | "unsupportedDriver"
  | "tooFewColumns"
  | "noColumns"
  | "versionTooOld"
  | "mcvUnsupported"
  | "badNumber";

export const STATS_BLOCK_REASON_KEYS: Record<StatsBlockReason, I18nKey> = {
  unsupportedDriver: "statsAdvBlockedDriver",
  tooFewColumns: "statsAdvBlockedTooFewColumns",
  noColumns: "statsAdvBlockedNoColumns",
  versionTooOld: "statsAdvBlockedVersion",
  mcvUnsupported: "statsAdvBlockedMcv",
  badNumber: "statsAdvBlockedNumber",
};

export type StatsBuild = { ok: true; statements: string[] } | { ok: false; reason: StatsBlockReason };

const blocked = (reason: StatsBlockReason): StatsBuild => ({ ok: false, reason });
const built = (...statements: string[]): StatsBuild => ({ ok: true, statements });

function dbOf(t: StatsTable, database: string | null): string | null {
  return t.schema ?? database;
}

/**
 * 統計の再取得。PostgreSQL は列を絞れる (`ANALYZE t (a, b)`)。MySQL の `ANALYZE TABLE` は列を取らず、
 * SQLite の `ANALYZE` は表単位。
 */
export function analyzeStatements(
  driver: string,
  t: StatsTable,
  database: string | null,
  columns: readonly string[] = [],
): StatsBuild {
  const name = qualifiedTableName(driver, dbOf(t, database), t.table);
  if (driver === "mysql") return built(`ANALYZE TABLE ${name};`);
  if (driver === "sqlite") return built(`ANALYZE ${name};`);
  const cols = columns.length > 0 ? ` (${columns.map((c) => quoteIdentFor(driver, c)).join(", ")})` : "";
  return built(`ANALYZE ${name}${cols};`);
}

/** SQLite の `PRAGMA optimize` (必要な表だけ ANALYZE する)。 */
export function sqliteOptimizeStatements(driver: string): StatsBuild {
  if (driver !== "sqlite") return blocked("unsupportedDriver");
  return built("PRAGMA optimize;");
}

export type ExtendedStatKind = "dependencies" | "ndistinct" | "mcv";

/**
 * PostgreSQL の拡張統計。`CREATE STATISTICS name (kinds) ON a, b FROM t;` に続けて、作っただけでは
 * 統計が溜まらないので `ANALYZE t;` を流す。2 列以上が必要 (PG 14 の式統計は扱わない)。
 * `kinds` が空なら種類を指定しない (サーバが全種類を作る)。
 */
export function createStatisticsStatements(args: {
  driver: string;
  table: StatsTable;
  database: string | null;
  columns: readonly string[];
  kinds: readonly ExtendedStatKind[];
  version: ServerVersion | null;
  /** 既存の統計名 (衝突を避けて連番を付ける)。 */
  takenNames?: ReadonlySet<string>;
}): StatsBuild {
  const { driver, table, database, columns, kinds, version } = args;
  if (driver !== "postgres") return blocked("unsupportedDriver");
  if (!supportsExtendedStatistics(driver, version)) return blocked("versionTooOld");
  if (columns.length < 2) return blocked("tooFewColumns");
  if (kinds.includes("mcv") && !supportsMcvStatistics(driver, version)) return blocked("mcvUnsupported");
  const schema = dbOf(table, database);
  const stem = `${table.table}_${columns.join("_")}`;
  const statName = fitPgName(stem, "_stat", args.takenNames ?? new Set());
  const kindList = kinds.length > 0 ? ` (${kinds.join(", ")})` : "";
  const qualifiedStat = schema
    ? `${quoteIdentFor(driver, schema)}.${quoteIdentFor(driver, statName)}`
    : quoteIdentFor(driver, statName);
  const target = qualifiedTableName(driver, schema, table.table);
  const cols = columns.map((c) => quoteIdentFor(driver, c)).join(", ");
  return built(
    `CREATE STATISTICS ${qualifiedStat}${kindList} ON ${cols} FROM ${target};`,
    `ANALYZE ${target};`,
  );
}

export const STATISTICS_TARGET_MAX = 10000;

/** PostgreSQL: 列の統計目標を上げる (`SET STATISTICS n`、-1 で既定に戻す) 。反映には ANALYZE が要るので続けて流す。 */
export function setStatisticsTargetStatements(args: {
  driver: string;
  table: StatsTable;
  database: string | null;
  column: string;
  target: number;
}): StatsBuild {
  const { driver, table, database, column, target } = args;
  if (driver !== "postgres") return blocked("unsupportedDriver");
  if (!column) return blocked("noColumns");
  if (!Number.isInteger(target) || target < -1 || target > STATISTICS_TARGET_MAX) return blocked("badNumber");
  const name = qualifiedTableName(driver, dbOf(table, database), table.table);
  const col = quoteIdentFor(driver, column);
  return built(
    `ALTER TABLE ${name} ALTER COLUMN ${col} SET STATISTICS ${target};`,
    `ANALYZE ${name} (${col});`,
  );
}

export const HISTOGRAM_BUCKETS_MIN = 1;
export const HISTOGRAM_BUCKETS_MAX = 1024;
export const HISTOGRAM_BUCKETS_DEFAULT = 100;

/** MySQL 8.0 以降: `ANALYZE TABLE t UPDATE HISTOGRAM ON a, b WITH n BUCKETS;`。 */
export function histogramStatements(args: {
  driver: string;
  table: StatsTable;
  database: string | null;
  columns: readonly string[];
  buckets: number;
  version: ServerVersion | null;
}): StatsBuild {
  const { driver, table, database, columns, buckets, version } = args;
  if (driver !== "mysql") return blocked("unsupportedDriver");
  if (!supportsHistogram(driver, version)) return blocked("versionTooOld");
  if (columns.length === 0) return blocked("noColumns");
  if (!Number.isInteger(buckets) || buckets < HISTOGRAM_BUCKETS_MIN || buckets > HISTOGRAM_BUCKETS_MAX) {
    return blocked("badNumber");
  }
  const name = qualifiedTableName(driver, dbOf(table, database), table.table);
  const cols = columns.map((c) => quoteIdentFor(driver, c)).join(", ");
  return built(`ANALYZE TABLE ${name} UPDATE HISTOGRAM ON ${cols} WITH ${buckets} BUCKETS;`);
}

/** MySQL: `ANALYZE TABLE t DROP HISTOGRAM ON col;`。 */
export function dropHistogramStatements(args: {
  driver: string;
  table: StatsTable;
  database: string | null;
  columns: readonly string[];
  version: ServerVersion | null;
}): StatsBuild {
  const { driver, table, database, columns, version } = args;
  if (driver !== "mysql") return blocked("unsupportedDriver");
  if (!supportsHistogram(driver, version)) return blocked("versionTooOld");
  if (columns.length === 0) return blocked("noColumns");
  const name = qualifiedTableName(driver, dbOf(table, database), table.table);
  const cols = columns.map((c) => quoteIdentFor(driver, c)).join(", ");
  return built(`ANALYZE TABLE ${name} DROP HISTOGRAM ON ${cols};`);
}

/** PostgreSQL: `DROP STATISTICS "schema"."name";`。 */
export function dropStatisticsStatements(driver: string, schema: string, name: string): StatsBuild {
  if (driver !== "postgres") return blocked("unsupportedDriver");
  const q = schema
    ? `${quoteIdentFor(driver, schema)}.${quoteIdentFor(driver, name)}`
    : quoteIdentFor(driver, name);
  return built(`DROP STATISTICS ${q};`);
}

/**
 * MySQL の `ANALYZE TABLE` は失敗してもエラーにせず、結果行 (`Msg_type` / `Msg_text`) で返す。
 * `Error` / `Warning` の行があればその `Msg_text` を失敗の理由として返す (無ければ null)。
 * 結果に `Msg_type` 列が無い文 (他ドライバ・他の文) は対象外で null。
 */
export function mysqlAnalyzeFailure(res: Pick<QueryResult, "columns" | "rows"> | null): string | null {
  if (!res) return null;
  const names = res.columns.map((c) => c.name.toLowerCase());
  const typeIdx = names.indexOf("msg_type");
  if (typeIdx < 0) return null;
  const textIdx = names.indexOf("msg_text");
  const msgs: string[] = [];
  for (const row of res.rows) {
    const type = String(row[typeIdx] ?? "").toLowerCase();
    if (type === "error" || type === "warning")
      msgs.push(String(row[textIdx >= 0 ? textIdx : typeIdx] ?? ""));
  }
  return msgs.length > 0 ? msgs.join("\n") : null;
}
