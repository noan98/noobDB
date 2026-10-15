// 前回入力の記憶 (#1631) の機能別ロジック。副作用なし (ストレージへの読み書きは
// `rememberedInputs.ts`)。各モーダルは「読む → 既定値に重ねる」「実行時に保存する」だけを行い、
// 値の検証・秘密情報の除外・履歴の並び規則はここに集約してユニットテストする。
//
// **秘密情報は保存しない**: パスワード・パスフレーズ・API キーはそもそも入力欄が無い。値を持つ
// 欄 (テストデータの固定値、ルーチン引数、値検索の語) のうち、機微な列に入りうるものは
// 保存対象から外す (固定値は列名がマスク対象パターンに一致する列のみ除外、ルーチン引数は
// 引数名がマスク対象に一致する引数を除外)。

import type { ImportErrorMode, ImportFormat, TextEncodingId } from "./api/tauri";
import { matchesMaskPattern } from "./components/columnMask";
import type { ColumnGenSpec, GenStrategy, TemporalFormat } from "./components/testDataGen";
import {
  asRecord,
  loadRemembered,
  pickBool,
  pickNumber,
  pickOneOf,
  pickString,
  rememberScope,
  saveRemembered,
} from "./rememberedInputs";
import { parseTextEncodingId } from "./sqlFileIO";

// ---------------------------------------------------------------------------
// パス
// ---------------------------------------------------------------------------

/** パスのディレクトリ部分 (区切りは `/` と `\` の両方)。ディレクトリ部が無ければ空。 */
export function dirnameOf(path: string): string {
  const p = path.trim();
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 0) return "";
  // ルート直下 (`/a.sql`, `C:\a.sql`) はルート自身を返す。
  if (idx === 0) return p.slice(0, 1);
  if (idx === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3);
  return p.slice(0, idx);
}

/** ディレクトリとファイル名を、ディレクトリ側の区切り文字に合わせて連結する。 */
export function joinDirAndName(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** パスの末尾のファイル名。 */
export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ---------------------------------------------------------------------------
// ダンプ (プロファイル単位)
// ---------------------------------------------------------------------------

export const DUMP_MEMORY_FEATURE = "dump";

/** ダンプのスイッチ (`DumpOptions` の真偽値フィールド)。 */
export const DUMP_BOOL_KEYS = [
  "singleTransaction",
  "routines",
  "events",
  "triggers",
  "addDropTable",
  "extendedInsert",
  "completeInsert",
  "noData",
  "noCreateInfo",
  "noOwner",
  "noPrivileges",
  "formatSql",
  "gzip",
  "noTablespaces",
  "setGtidPurgedOff",
  "writeChecksum",
  "sqliteSnapshot",
] as const;
export type DumpBoolKey = (typeof DUMP_BOOL_KEYS)[number];

export interface DumpPrefs {
  options: Partial<Record<DumpBoolKey, boolean>>;
  /** 保存先ディレクトリ (ファイル名は毎回タイムスタンプ付きで作る)。 */
  dir: string;
}

export function sanitizeDumpPrefs(raw: unknown): DumpPrefs | null {
  const o = asRecord(raw);
  if (!o) return null;
  const optsRaw = asRecord(o.options) ?? {};
  const options: Partial<Record<DumpBoolKey, boolean>> = {};
  for (const k of DUMP_BOOL_KEYS) {
    if (typeof optsRaw[k] === "boolean") options[k] = optsRaw[k] as boolean;
  }
  return { options, dir: pickString(o.dir, "") };
}

export function loadDumpPrefs(profileId: string | undefined): DumpPrefs | null {
  if (!profileId) return null;
  return loadRemembered(DUMP_MEMORY_FEATURE, rememberScope(profileId), sanitizeDumpPrefs);
}

export function saveDumpPrefs(profileId: string | undefined, prefs: DumpPrefs): void {
  if (!profileId) return;
  saveRemembered(DUMP_MEMORY_FEATURE, rememberScope(profileId), prefs);
}

// ---------------------------------------------------------------------------
// 取り込み (接続 × DB × テーブル)
// ---------------------------------------------------------------------------

export const IMPORT_MEMORY_FEATURE = "import";

export const IMPORT_FORMATS: readonly ImportFormat[] = ["csv", "json", "ndjson", "xlsx"];
export const IMPORT_DELIMITERS = [",", "\t", ";"] as const;
export type ImportDelimiter = (typeof IMPORT_DELIMITERS)[number];
export const IMPORT_NULL_MODES = ["none", "empty", "custom"] as const;
export type ImportNullMode = (typeof IMPORT_NULL_MODES)[number];
const IMPORT_ERROR_MODES: readonly ImportErrorMode[] = ["abort", "skip"];

export interface ImportPrefs {
  format: ImportFormat;
  encoding: string;
  delimiter: ImportDelimiter;
  quote: string;
  hasHeader: boolean;
  nullMode: ImportNullMode;
  nullCustom: string;
  errorMode: ImportErrorMode;
}

export const DEFAULT_IMPORT_PREFS: ImportPrefs = {
  format: "csv",
  encoding: "utf-8",
  delimiter: ",",
  quote: '"',
  hasHeader: true,
  nullMode: "empty",
  nullCustom: "NULL",
  errorMode: "abort",
};

/** エンコーディングの長さ上限 (壊れたデータでの肥大化を防ぐ)。 */
const MAX_SHORT_TEXT = 64;

export function sanitizeImportPrefs(raw: unknown): ImportPrefs | null {
  const o = asRecord(raw);
  if (!o) return null;
  const d = DEFAULT_IMPORT_PREFS;
  const quote = pickString(o.quote, d.quote);
  return {
    format: pickOneOf(o.format, IMPORT_FORMATS, d.format),
    encoding: pickString(o.encoding, d.encoding).slice(0, MAX_SHORT_TEXT) || d.encoding,
    delimiter: pickOneOf(o.delimiter, IMPORT_DELIMITERS, d.delimiter),
    // 引用符はバックエンドが 1 バイト ASCII を要求する。
    quote: quote.length === 1 && quote.charCodeAt(0) < 128 ? quote : d.quote,
    hasHeader: pickBool(o.hasHeader, d.hasHeader),
    nullMode: pickOneOf(o.nullMode, IMPORT_NULL_MODES, d.nullMode),
    nullCustom: pickString(o.nullCustom, d.nullCustom).slice(0, MAX_SHORT_TEXT),
    errorMode: pickOneOf(o.errorMode, IMPORT_ERROR_MODES, d.errorMode),
  };
}

export function importScope(profileId: string | undefined, database: string, table: string | null): string {
  return rememberScope(profileId, database, table);
}

export function loadImportPrefs(scope: string): ImportPrefs | null {
  return loadRemembered(IMPORT_MEMORY_FEATURE, scope, sanitizeImportPrefs);
}

export function saveImportPrefs(scope: string, prefs: ImportPrefs): void {
  saveRemembered(IMPORT_MEMORY_FEATURE, scope, prefs);
}

/**
 * ファイルを選び直したときの区切り文字。`.tsv` はタブ、タブのままほかの拡張子へ替えたら
 * カンマへ戻し、それ以外 (`;` など前回の指定) は保つ。
 */
export function delimiterAfterPick(current: ImportDelimiter, path: string): ImportDelimiter {
  if (path.toLowerCase().endsWith(".tsv")) return "\t";
  return current === "\t" ? "," : current;
}

// ---------------------------------------------------------------------------
// 一括書き出し (接続 × DB)
// ---------------------------------------------------------------------------

export const TABLES_EXPORT_MEMORY_FEATURE = "tablesExport";

const EXPORT_FORMATS = ["csv", "json", "ndjson", "markdown", "sql", "xlsx"] as const;
export type RememberedExportFormat = (typeof EXPORT_FORMATS)[number];

export interface TablesExportPrefs {
  format: RememberedExportFormat;
  dir: string;
  maskEnabled: boolean;
  includeDdl: boolean;
}

export function sanitizeTablesExportPrefs(raw: unknown): TablesExportPrefs | null {
  const o = asRecord(raw);
  if (!o) return null;
  return {
    format: pickOneOf(o.format, EXPORT_FORMATS, "csv"),
    dir: pickString(o.dir, ""),
    maskEnabled: pickBool(o.maskEnabled, false),
    includeDdl: pickBool(o.includeDdl, false),
  };
}

export function tablesExportScope(profileId: string | undefined, database: string): string {
  return rememberScope(profileId, database);
}

export function loadTablesExportPrefs(scope: string): TablesExportPrefs | null {
  return loadRemembered(TABLES_EXPORT_MEMORY_FEATURE, scope, sanitizeTablesExportPrefs);
}

export function saveTablesExportPrefs(scope: string, prefs: TablesExportPrefs): void {
  saveRemembered(TABLES_EXPORT_MEMORY_FEATURE, scope, prefs);
}

// ---------------------------------------------------------------------------
// テストデータ (接続 × スキーマ × テーブル)
// ---------------------------------------------------------------------------

export const TEST_DATA_MEMORY_FEATURE = "testData";

const GEN_STRATEGIES: readonly GenStrategy[] = [
  "serial",
  "uuid",
  "randomNumber",
  "randomString",
  "randomDate",
  "randomBool",
  "fixed",
  "choice",
  "fkRef",
  "omit",
];
const TEMPORAL_FORMATS: readonly TemporalFormat[] = ["date", "time", "datetime"];

/** 列ごとに覚える生成方針 (候補値・FK 参照先などスキーマ由来のものは含めない)。 */
export interface RememberedColumnSpec {
  strategy: GenStrategy;
  nullRate: number;
  /** 機微な列名の固定値は保存しない (undefined)。 */
  fixedValue?: string;
  length: number;
  min: number;
  max: number;
  serialStart: number;
  temporal: TemporalFormat;
}

export interface TestDataPrefs {
  rowCountText: string;
  seed: number;
  columns: Record<string, RememberedColumnSpec>;
}

const MAX_REMEMBERED_COLUMNS = 500;
const MAX_FIXED_VALUE = 1000;

function sanitizeColumnSpec(raw: unknown): RememberedColumnSpec | null {
  const o = asRecord(raw);
  if (!o) return null;
  const strategy = pickOneOf(o.strategy, GEN_STRATEGIES, "randomString");
  const out: RememberedColumnSpec = {
    strategy,
    nullRate: Math.min(1, Math.max(0, pickNumber(o.nullRate, 0))),
    length: Math.max(1, Math.floor(pickNumber(o.length, 8))),
    min: pickNumber(o.min, 0),
    max: pickNumber(o.max, 1000),
    serialStart: Math.floor(pickNumber(o.serialStart, 1)),
    temporal: pickOneOf(o.temporal, TEMPORAL_FORMATS, "datetime"),
  };
  if (typeof o.fixedValue === "string") out.fixedValue = o.fixedValue.slice(0, MAX_FIXED_VALUE);
  return out;
}

export function sanitizeTestDataPrefs(raw: unknown): TestDataPrefs | null {
  const o = asRecord(raw);
  if (!o) return null;
  const colsRaw = asRecord(o.columns) ?? {};
  const columns: Record<string, RememberedColumnSpec> = {};
  for (const name of Object.keys(colsRaw).slice(0, MAX_REMEMBERED_COLUMNS)) {
    const spec = sanitizeColumnSpec(colsRaw[name]);
    if (spec) columns[name] = spec;
  }
  return {
    rowCountText: pickString(o.rowCountText, "100").slice(0, 12),
    seed: Math.max(0, Math.floor(pickNumber(o.seed, 0))),
    columns,
  };
}

/** 保存用に現在の方針を縮める。`maskPatterns` に一致する列名の固定値は保存しない。 */
export function snapshotTestDataPrefs(
  specs: readonly ColumnGenSpec[],
  rowCountText: string,
  seed: number,
  maskPatterns: readonly string[],
): TestDataPrefs {
  const columns: Record<string, RememberedColumnSpec> = {};
  for (const s of specs) {
    const entry: RememberedColumnSpec = {
      strategy: s.strategy,
      nullRate: s.nullRate,
      length: s.length,
      min: s.min,
      max: s.max,
      serialStart: s.serialStart,
      temporal: s.temporal,
    };
    if (!matchesMaskPattern(s.column, maskPatterns)) entry.fixedValue = s.fixedValue;
    columns[s.column] = entry;
  }
  return { rowCountText, seed, columns };
}

/** 方針の戦略が、その列で選べるか (`choice` は列挙型、`fkRef` は FK 列のみ)。 */
function strategyAvailable(spec: ColumnGenSpec, strategy: GenStrategy): boolean {
  if (strategy === "choice") return spec.kind === "enum";
  if (strategy === "fkRef") return !!spec.fkTable && !!spec.fkColumn;
  return true;
}

/**
 * 推定した既定の方針に、覚えている値を重ねる。列が消えた・型が変わって選べなくなった戦略
 * (列挙でなくなった `choice` など) は既定のままにする。純粋 (入力は変更しない)。
 */
export function applyRememberedSpecs(specs: readonly ColumnGenSpec[], prefs: TestDataPrefs): ColumnGenSpec[] {
  return specs.map((spec) => {
    const saved = prefs.columns[spec.column];
    if (!saved || !strategyAvailable(spec, saved.strategy)) return spec;
    return {
      ...spec,
      strategy: saved.strategy,
      nullRate: saved.nullRate,
      fixedValue: saved.fixedValue ?? spec.fixedValue,
      length: saved.length,
      min: saved.min,
      max: saved.max,
      serialStart: saved.serialStart,
      temporal: saved.temporal,
    };
  });
}

export function testDataScope(profileId: string | undefined, database: string, table: string): string {
  return rememberScope(profileId, database, table);
}

export function loadTestDataPrefs(scope: string): TestDataPrefs | null {
  return loadRemembered(TEST_DATA_MEMORY_FEATURE, scope, sanitizeTestDataPrefs);
}

export function saveTestDataPrefs(scope: string, prefs: TestDataPrefs): void {
  saveRemembered(TEST_DATA_MEMORY_FEATURE, scope, prefs);
}

// ---------------------------------------------------------------------------
// ルーチン引数の履歴 (接続 × DB × ルーチン)
// ---------------------------------------------------------------------------
//
// 引数には機微な値が入りうるため、**ディスクには書かない** (localStorage にも `profiles.json` にも
// 残さない)。アプリを起動している間だけ、モジュール内のメモリ (= UI の状態) に保持し、再起動で消える。
// さらに引数名がマスク対象パターンに一致する位置の値は、メモリにも残さない。

/** 1 ルーチンが覚える引数セットの件数。 */
export const MAX_ROUTINE_ARG_SETS = 5;

/** 履歴 1 件 = 引数の位置順の値 (入力しない引数は空文字)。 */
export type RoutineArgSet = string[];

/**
 * 履歴の先頭に今回の引数セットを足す (同じ内容は先頭へ繰り上げ、上限を超えたら古い順に捨てる)。
 * 引数名がマスク対象パターンに一致する位置は保存しない (空文字へ置き換える)。全部空なら足さない。
 */
export function pushRoutineArgSet(
  history: readonly RoutineArgSet[],
  values: readonly string[],
  paramNames: readonly string[],
  maskPatterns: readonly string[],
): RoutineArgSet[] {
  const safe = values.map((v, i) => (matchesMaskPattern(paramNames[i] ?? "", maskPatterns) ? "" : v));
  if (safe.every((v) => v === "")) return history.slice();
  const key = JSON.stringify(safe);
  const rest = history.filter((h) => JSON.stringify(h) !== key);
  return [safe, ...rest].slice(0, MAX_ROUTINE_ARG_SETS);
}

export function routineArgsScope(
  profileId: string | undefined,
  database: string,
  kind: string,
  name: string,
  id: string | null,
): string {
  return rememberScope(profileId, database, kind, name, id);
}

/** アプリ起動中だけ保持する履歴 (スコープ → 引数セット)。ディスクには書かない。 */
const routineArgMemory = new Map<string, RoutineArgSet[]>();

/** 保持するスコープ数の上限 (最後に使った順で古いものから捨てる)。 */
const MAX_ROUTINE_SCOPES = 50;

export function loadRoutineArgSets(scope: string): RoutineArgSet[] {
  return routineArgMemory.get(scope)?.map((set) => set.slice()) ?? [];
}

export function saveRoutineArgSets(scope: string, sets: readonly RoutineArgSet[]): void {
  routineArgMemory.delete(scope);
  if (sets.length > 0)
    routineArgMemory.set(
      scope,
      sets.map((set) => set.slice()),
    );
  while (routineArgMemory.size > MAX_ROUTINE_SCOPES) {
    const oldest = routineArgMemory.keys().next().value;
    if (oldest === undefined) break;
    routineArgMemory.delete(oldest);
  }
}

/** メモリ上の履歴を全部捨てる (テスト用・将来の「履歴を消去」用)。 */
export function clearRoutineArgMemory(): void {
  routineArgMemory.clear();
}

/** 履歴 1 件の表示用の短い要約 (空の引数は `·`)。 */
export function describeArgSet(set: readonly string[], max = 60): string {
  const text = set.map((v) => (v === "" ? "·" : v)).join(", ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 履歴の引数セットを現在のシグネチャの引数数に合わせる (足りなければ空、余りは捨てる)。 */
export function fitArgSet(set: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_, i) => set[i] ?? "");
}

// ---------------------------------------------------------------------------
// 最近実行した SQL スクリプト (全接続共通)
// ---------------------------------------------------------------------------

export const SCRIPT_RECENTS_MEMORY_FEATURE = "scriptRecents";
const SCRIPT_RECENTS_SCOPE = "global";
export const MAX_RECENT_SCRIPTS = 8;

export interface RecentScript {
  path: string;
  encoding: TextEncodingId | null;
}

export function sanitizeRecentScripts(raw: unknown): RecentScript[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RecentScript[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o || typeof o.path !== "string" || o.path.trim() === "") continue;
    out.push({
      path: o.path,
      encoding: typeof o.encoding === "string" ? parseTextEncodingId(o.encoding) : null,
    });
    if (out.length >= MAX_RECENT_SCRIPTS) break;
  }
  return out;
}

/** 先頭に足す (同じパスは繰り上げ、上限を超えたら古い順に捨てる)。 */
export function pushRecentScript(list: readonly RecentScript[], entry: RecentScript): RecentScript[] {
  const path = entry.path.trim();
  if (!path) return list.slice();
  return [{ path, encoding: entry.encoding }, ...list.filter((r) => r.path !== path)].slice(
    0,
    MAX_RECENT_SCRIPTS,
  );
}

export function loadRecentScripts(): RecentScript[] {
  return loadRemembered(SCRIPT_RECENTS_MEMORY_FEATURE, SCRIPT_RECENTS_SCOPE, sanitizeRecentScripts) ?? [];
}

export function saveRecentScripts(list: readonly RecentScript[]): void {
  saveRemembered(SCRIPT_RECENTS_MEMORY_FEATURE, SCRIPT_RECENTS_SCOPE, list);
}

// ---------------------------------------------------------------------------
// 値検索の検索履歴 (接続 × DB)
// ---------------------------------------------------------------------------

export const DATA_SEARCH_MEMORY_FEATURE = "dataSearch";
export const MAX_DATA_SEARCH_HISTORY = 10;
const MAX_TERM_LENGTH = 200;
const MAX_REMEMBERED_TABLES = 100;
const MATCH_MODES = ["contains", "prefix", "exact"] as const;

export interface DataSearchHistoryEntry {
  term: string;
  mode: (typeof MATCH_MODES)[number];
  scope: "all" | "selected";
  /** `scope` が "selected" のときの対象テーブル。 */
  tables: string[];
}

export function sanitizeDataSearchHistory(raw: unknown): DataSearchHistoryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DataSearchHistoryEntry[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o || typeof o.term !== "string" || o.term.trim() === "") continue;
    const scope = pickOneOf(o.scope, ["all", "selected"] as const, "all");
    const tables =
      scope === "selected" && Array.isArray(o.tables)
        ? o.tables.filter((t): t is string => typeof t === "string").slice(0, MAX_REMEMBERED_TABLES)
        : [];
    if (scope === "selected" && tables.length === 0) continue;
    out.push({
      term: o.term.slice(0, MAX_TERM_LENGTH),
      mode: pickOneOf(o.mode, MATCH_MODES, "contains"),
      scope,
      tables,
    });
    if (out.length >= MAX_DATA_SEARCH_HISTORY) break;
  }
  return out;
}

function dataSearchKey(e: DataSearchHistoryEntry): string {
  return JSON.stringify([e.term, e.mode, e.scope, e.scope === "selected" ? [...e.tables].sort() : []]);
}

/** 先頭に足す (同じ条件は繰り上げ、上限を超えたら古い順に捨てる)。 */
export function pushDataSearchHistory(
  list: readonly DataSearchHistoryEntry[],
  entry: DataSearchHistoryEntry,
): DataSearchHistoryEntry[] {
  const term = entry.term.trim().slice(0, MAX_TERM_LENGTH);
  if (!term) return list.slice();
  const next: DataSearchHistoryEntry = {
    term,
    mode: entry.mode,
    scope: entry.scope,
    tables: entry.scope === "selected" ? entry.tables.slice(0, MAX_REMEMBERED_TABLES) : [],
  };
  const key = dataSearchKey(next);
  return [next, ...list.filter((e) => dataSearchKey(e) !== key)].slice(0, MAX_DATA_SEARCH_HISTORY);
}

export function dataSearchScope(profileId: string | undefined, database: string): string {
  return rememberScope(profileId, database);
}

export function loadDataSearchHistory(scope: string): DataSearchHistoryEntry[] {
  return loadRemembered(DATA_SEARCH_MEMORY_FEATURE, scope, sanitizeDataSearchHistory) ?? [];
}

export function saveDataSearchHistory(scope: string, list: readonly DataSearchHistoryEntry[]): void {
  saveRemembered(DATA_SEARCH_MEMORY_FEATURE, scope, list);
}
