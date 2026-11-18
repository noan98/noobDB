/**
 * SQL ノートブック (#2380) の文書モデルと、`.noobnb` (JSON) への保存 / 読み込みの純ロジック。
 *
 * - 文書は Markdown セルと SQL セルの並び。SQL セルは直近の実行結果を「スナップショット」(先頭 N 行 +
 *   列メタデータ + 実行時刻 + 所要時間) として持ち、開き直しても再実行せずに読める。
 * - **保存形式はホワイトリスト方式**: `serializeNotebook` は既知のフィールドだけを書き出す。実行時の
 *   状態や、うっかり混入した余計なプロパティ (パスワード等) はファイルに入らない。接続は
 *   プロファイル ID と表示名だけを持つ。
 * - **マスキング**: 設定の機微カラムマスク (`columnMask.ts`) が有効なら、スナップショットを作るとき
 *   (`buildSnapshot`) と書き出すとき (`serializeNotebook`) の両方で、対象列の値を伏せ字にする。
 *   書き出し時にもう一度掛けるのは、取得後に設定やパターンを変えた場合でも平文をファイルへ残さないため。
 */
import type { CellValue, Column, ConnectionProfile } from "./api/tauri";
import { MASK_PLACEHOLDER, resolveMaskedColumns, type MaskConfig } from "./components/columnMask";
import { isReadOnlySql } from "./dangerousSql";
import type { ChartConfig } from "./components/chartData";
import { sanitizeChartConfig } from "./components/chartData";

export const NOTEBOOK_FILE_FORMAT = "noobdb-notebook";
export const NOTEBOOK_FILE_VERSION = 1;
export const NOTEBOOK_FILE_EXTENSION = "noobnb";
/** スナップショットに残す行数の既定 (Issue #2380)。 */
export const DEFAULT_SNAPSHOT_ROW_LIMIT = 200;
/** 保存行数の上限。ファイルの肥大 (`read_text_file` の 8 MiB 上限) を避ける。 */
export const MAX_SNAPSHOT_ROW_LIMIT = 1000;
export const SNAPSHOT_ROW_LIMIT_CHOICES: readonly number[] = [50, 200, 500, 1000];
/**
 * `.noobnb` 全体の上限 (UTF-8 バイト)。読み込みに使う `read_text_file` の上限 (8 MiB) を超えるファイルは
 * 保存できても開き直せないので、保存前に測って止める。
 */
export const MAX_NOTEBOOK_FILE_BYTES = 8 * 1024 * 1024;
/** スナップショットの 1 セルの値の最大文字数。超えた分は切り詰める (`valuesTruncated` で表示に出す)。 */
export const MAX_SNAPSHOT_CELL_CHARS = 2000;
/** 読み込み時の安全弁。 */
export const MAX_NOTEBOOK_CELLS = 500;
/** セル 1 つのテキスト (SQL / Markdown) の最大文字数。読み込み側がこれを超えた分を切り捨てる。 */
export const MAX_CELL_TEXT_CHARS = 500_000;
const MAX_COLUMNS = 500;

export interface NotebookSnapshot {
  columns: Column[];
  /** 保存している行 (最大 `snapshotRowLimit`)。マスク済み。 */
  rows: CellValue[][];
  /** サーバから受け取った総行数 (切り詰め前)。 */
  totalRows: number;
  /** `rows` が `totalRows` より少ない (保存行数の上限で切り詰めた)。 */
  truncated: boolean;
  /** 結果セットを返さない文 (DML / DDL) の影響行数。 */
  rowsAffected: number;
  hasColumns: boolean;
  elapsedMs: number;
  /** 実行完了の時刻 (ISO 8601, UTC)。 */
  executedAt: string;
  /** 失敗したときのメッセージ。成功なら null。 */
  error: string | null;
  /** 伏せ字にした列名。 */
  maskedColumns: string[];
  /** 長い値を `MAX_SNAPSHOT_CELL_CHARS` で切り詰めたセルがある。 */
  valuesTruncated: boolean;
  /** 自動 LIMIT が掛かった行数 (掛からなければ null)。「全 N 行」が実件数でないことを示す。 */
  appliedAutoLimit: number | null;
}

export type NotebookCellView = "table" | "chart";

export interface NotebookMarkdownCell {
  id: string;
  kind: "markdown";
  text: string;
  collapsed: boolean;
}

export interface NotebookSqlCell {
  id: string;
  kind: "sql";
  sql: string;
  collapsed: boolean;
  snapshot: NotebookSnapshot | null;
  view: NotebookCellView;
  chart: ChartConfig | null;
  /**
   * このセルの実行先の接続 (#2396)。null = 文書の既定 (実行時点の現在の接続)。
   * ファイルにはプロファイル ID と表示名だけを書く (秘密情報は入れない)。
   */
  connection: NotebookConnectionRef | null;
}

export type NotebookCell = NotebookMarkdownCell | NotebookSqlCell;

export interface NotebookConnectionRef {
  profileId: string;
  name: string;
}

export interface NotebookDoc {
  title: string;
  connection: NotebookConnectionRef | null;
  /**
   * 実行先のデータベース (PostgreSQL ではスキーマ)。空 = 接続の既定。現在のタブの状態には従わず、
   * 文書が自分で持つ。
   */
  database: string | null;
  snapshotRowLimit: number;
  cells: NotebookCell[];
}

let idCounter = 0;
/** セル ID。ファイルに保存され、並べ替え / 実行結果の対応づけに使う。 */
export function newCellId(): string {
  idCounter += 1;
  return `c${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newMarkdownCell(text = ""): NotebookMarkdownCell {
  return { id: newCellId(), kind: "markdown", text, collapsed: false };
}

export function newSqlCell(sql = ""): NotebookSqlCell {
  return {
    id: newCellId(),
    kind: "sql",
    sql,
    collapsed: false,
    snapshot: null,
    view: "table",
    chart: null,
    connection: null,
  };
}

export function createEmptyNotebook(connection: NotebookConnectionRef | null = null): NotebookDoc {
  return {
    title: "",
    connection,
    database: null,
    snapshotRowLimit: DEFAULT_SNAPSHOT_ROW_LIMIT,
    cells: [newMarkdownCell(""), newSqlCell("")],
  };
}

/** 保存行数の入力を `[1, MAX_SNAPSHOT_ROW_LIMIT]` の整数へ丸める。 */
export function clampSnapshotRowLimit(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SNAPSHOT_ROW_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_SNAPSHOT_ROW_LIMIT);
}

// ── セル操作 (純関数) ──────────────────────────────────────────────

export function insertCellAfter(cells: readonly NotebookCell[], afterId: string | null, cell: NotebookCell) {
  if (afterId === null) return [...cells, cell];
  const idx = cells.findIndex((c) => c.id === afterId);
  if (idx < 0) return [...cells, cell];
  return [...cells.slice(0, idx + 1), cell, ...cells.slice(idx + 1)];
}

export function removeCell(cells: readonly NotebookCell[], id: string): NotebookCell[] {
  return cells.filter((c) => c.id !== id);
}

/** `id` のセルを `delta` (-1 = 上 / +1 = 下) だけ動かす。端なら同じ配列を返す。 */
export function moveCell(cells: readonly NotebookCell[], id: string, delta: -1 | 1): NotebookCell[] {
  const idx = cells.findIndex((c) => c.id === id);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= cells.length) return cells as NotebookCell[];
  const next = [...cells];
  const [moved] = next.splice(idx, 1);
  next.splice(to, 0, moved);
  return next;
}

/** ドラッグ並べ替えの結果 (ID の並び) を検証して適用する。順列でなければ元のまま。 */
export function reorderCellsByIds(cells: readonly NotebookCell[], ids: readonly string[]): NotebookCell[] {
  if (ids.length !== cells.length) return cells as NotebookCell[];
  const byId = new Map(cells.map((c) => [c.id, c]));
  if (byId.size !== cells.length) return cells as NotebookCell[];
  const next: NotebookCell[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) return cells as NotebookCell[];
    byId.delete(id);
    next.push(c);
  }
  return next;
}

export function updateCell(
  cells: readonly NotebookCell[],
  id: string,
  patch: Partial<Omit<NotebookMarkdownCell, "id" | "kind">> | Partial<Omit<NotebookSqlCell, "id" | "kind">>,
): NotebookCell[] {
  return cells.map((c) => (c.id === id ? ({ ...c, ...patch } as NotebookCell) : c));
}

/** 実行対象の SQL セル ID を順に返す。`fromId` を渡すとそのセルから下 (自身を含む)。空の SQL は除く。 */
export function sqlCellsToRun(cells: readonly NotebookCell[], fromId?: string | null): NotebookSqlCell[] {
  let start = 0;
  if (fromId) {
    const idx = cells.findIndex((c) => c.id === fromId);
    if (idx >= 0) start = idx;
  }
  return cells.slice(start).filter((c): c is NotebookSqlCell => c.kind === "sql" && c.sql.trim().length > 0);
}

/** セルの実行先の解決結果 (#2396)。 */
export type NotebookCellTarget =
  /** 文書の既定。実行時点の現在の接続で動く。 */
  | { kind: "current" }
  /** 別の接続が開いていて、そこで動く。 */
  | { kind: "open"; profile: ConnectionProfile; sessionId: string }
  /** 保存されたプロファイルが見つからない (削除された / 別マシンで開いた)。実行できない。 */
  | { kind: "missing"; ref: NotebookConnectionRef }
  /** プロファイルはあるが、いま開いていない。接続してから実行する。 */
  | { kind: "closed"; ref: NotebookConnectionRef; profile: ConnectionProfile };

/**
 * セルの実行先を決める純関数。`connection` が無い、または現在の接続と同じなら `current`。
 * 開いている接続 (`openConnections`: アクティブ + 背景) を先に探し (「別 DB で開く」の一時プロファイルも含む)、
 * 無ければ保存済みプロファイル (`profiles`) で「開いていない」と「見つからない」を区別する。
 */
export function resolveCellTarget(
  connection: NotebookConnectionRef | null,
  currentProfileId: string | null,
  profiles: readonly ConnectionProfile[],
  openConnections: readonly { sessionId: string; profile: ConnectionProfile }[],
): NotebookCellTarget {
  if (!connection || connection.profileId === currentProfileId) return { kind: "current" };
  const open = openConnections.find((c) => c.profile.id === connection.profileId);
  // 開いている接続のプロファイルは接続時点のまま (編集保存しても更新されない) なので、安全網の設定
  // (本番表示など) は保存済みプロファイルの最新を優先する。派生接続など保存一覧に無いときだけ開いている側。
  if (open) {
    const fresh = profiles.find((p) => p.id === connection.profileId) ?? open.profile;
    return { kind: "open", profile: fresh, sessionId: open.sessionId };
  }
  const saved = profiles.find((p) => p.id === connection.profileId);
  return saved ? { kind: "closed", ref: connection, profile: saved } : { kind: "missing", ref: connection };
}

/** 書き込み文を含むセルか (セルに印を付ける)。 */
export function cellHasWrites(sql: string, driver?: string): boolean {
  return sql.trim().length > 0 && !isReadOnlySql(sql, driver);
}

// ── スナップショット ──────────────────────────────────────────────

/** 対象列を伏せ字にした行を返す。対象が無ければ元の配列をそのまま返す。 */
export function maskSnapshotRows(
  columns: readonly Column[],
  rows: readonly CellValue[][],
  mask: MaskConfig,
): { rows: CellValue[][]; maskedColumns: string[] } {
  const flags = resolveMaskedColumns(
    columns.map((c) => c.name),
    mask,
  );
  if (!flags) return { rows: rows as CellValue[][], maskedColumns: [] };
  return {
    rows: rows.map((r) => r.map((v, i) => (flags[i] ? MASK_PLACEHOLDER : v))),
    maskedColumns: columns.filter((_, i) => flags[i]).map((c) => c.name),
  };
}

/** 長すぎる文字列の値を切り詰める (ファイルの肥大を避ける)。切り詰めたら末尾に `…` を付ける。 */
export function clipCellValues(rows: CellValue[][]): { rows: CellValue[][]; truncated: boolean } {
  let truncated = false;
  const out = rows.map((r) =>
    r.map((v) => {
      if (typeof v === "string" && v.length > MAX_SNAPSHOT_CELL_CHARS) {
        truncated = true;
        return `${v.slice(0, MAX_SNAPSHOT_CELL_CHARS)}…`;
      }
      return v;
    }),
  );
  return { rows: truncated ? out : rows, truncated };
}

export interface SnapshotInput {
  columns: Column[];
  /** 受け取った行 (呼び出し側が上限まで集めたもの。超過分は渡さなくてよい)。 */
  rows: CellValue[][];
  /** サーバから受け取った総行数。 */
  totalRows: number;
  rowsAffected: number;
  hasColumns: boolean;
  elapsedMs: number;
  error?: string | null;
  appliedAutoLimit?: number | null;
}

/** 実行結果からスナップショットを作る。行数の上限で切り詰め、マスクを掛ける。 */
export function buildSnapshot(
  input: SnapshotInput,
  limit: number,
  mask: MaskConfig,
  now: Date = new Date(),
): NotebookSnapshot {
  const cap = clampSnapshotRowLimit(limit);
  const kept = input.rows.slice(0, cap);
  const masked = maskSnapshotRows(input.columns, kept, mask);
  const clipped = clipCellValues(masked.rows);
  return {
    columns: input.columns.map((c) => ({ name: c.name, type_name: c.type_name })),
    rows: clipped.rows,
    totalRows: Math.max(input.totalRows, kept.length),
    truncated: input.totalRows > kept.length,
    rowsAffected: input.rowsAffected,
    hasColumns: input.hasColumns,
    elapsedMs: input.elapsedMs,
    executedAt: now.toISOString(),
    error: input.error ?? null,
    maskedColumns: masked.maskedColumns,
    valuesTruncated: clipped.truncated,
    appliedAutoLimit: input.appliedAutoLimit ?? null,
  };
}

/** エラーで終わった実行のスナップショット (行なし)。 */
export function buildErrorSnapshot(
  error: string,
  elapsedMs: number,
  now: Date = new Date(),
): NotebookSnapshot {
  return {
    columns: [],
    rows: [],
    totalRows: 0,
    truncated: false,
    rowsAffected: 0,
    hasColumns: false,
    elapsedMs,
    executedAt: now.toISOString(),
    error,
    maskedColumns: [],
    valuesTruncated: false,
    appliedAutoLimit: null,
  };
}

// ── 保存 / 読み込み ────────────────────────────────────────────────

function snapshotForFile(s: NotebookSnapshot, mask: MaskConfig) {
  const masked = maskSnapshotRows(s.columns, s.rows, mask);
  // 書き出し時にも掛け直した結果、新たに伏せた列を含める。
  const maskedColumns = Array.from(new Set([...s.maskedColumns, ...masked.maskedColumns]));
  // 取得時に伏せ済みの列はそのまま (すでに伏せ字)。
  const clipped = clipCellValues(masked.rows);
  const rows = clipped.rows;
  return {
    columns: s.columns.map((c) => ({ name: c.name, type_name: c.type_name })),
    rows,
    totalRows: s.totalRows,
    truncated: s.truncated,
    rowsAffected: s.rowsAffected,
    hasColumns: s.hasColumns,
    elapsedMs: s.elapsedMs,
    executedAt: s.executedAt,
    error: s.error,
    maskedColumns,
    valuesTruncated: s.valuesTruncated || clipped.truncated,
    appliedAutoLimit: s.appliedAutoLimit,
  };
}

/** 文字列の UTF-8 バイト数。 */
/** 保存前の検査で見つかった、読み込み側の上限 (黙って捨てられる量) の超過。 */
export type NotebookLimitViolation = { kind: "cells"; limit: number } | { kind: "cellText"; limit: number };

/**
 * 読み込み (`parseNotebook`) は `MAX_NOTEBOOK_CELLS` 個を超えるセルと `MAX_CELL_TEXT_CHARS` を超えるテキストを
 * 黙って捨てる。保存したファイルが開き直すと欠けるのを防ぐため、保存前に同じ上限を検査する。
 */
export function checkNotebookLimits(doc: NotebookDoc): NotebookLimitViolation | null {
  if (doc.cells.length > MAX_NOTEBOOK_CELLS) return { kind: "cells", limit: MAX_NOTEBOOK_CELLS };
  for (const c of doc.cells) {
    const len = c.kind === "markdown" ? c.text.length : c.sql.length;
    if (len > MAX_CELL_TEXT_CHARS) return { kind: "cellText", limit: MAX_CELL_TEXT_CHARS };
  }
  return null;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `.noobnb` の本文 (行が数倍に膨らまないよう整形しない JSON) を作る。ホワイトリスト以外のプロパティは書かない。 */
export function serializeNotebook(doc: NotebookDoc, mask: MaskConfig, now: Date = new Date()): string {
  const file = {
    format: NOTEBOOK_FILE_FORMAT,
    version: NOTEBOOK_FILE_VERSION,
    savedAt: now.toISOString(),
    title: doc.title,
    database: doc.database,
    connection: doc.connection ? { profileId: doc.connection.profileId, name: doc.connection.name } : null,
    snapshotRowLimit: clampSnapshotRowLimit(doc.snapshotRowLimit),
    cells: doc.cells.map((c) =>
      c.kind === "markdown"
        ? { id: c.id, kind: "markdown", text: c.text, collapsed: c.collapsed }
        : {
            id: c.id,
            kind: "sql",
            sql: c.sql,
            collapsed: c.collapsed,
            view: c.view,
            chart: c.chart,
            connection: c.connection ? { profileId: c.connection.profileId, name: c.connection.name } : null,
            snapshot: c.snapshot ? snapshotForFile(c.snapshot, mask) : null,
          },
    ),
  };
  return `${JSON.stringify(file)}\n`;
}

export type ParseNotebookResult =
  | { ok: true; doc: NotebookDoc }
  | { ok: false; reason: "invalid" | "format" | "newerVersion" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = MAX_CELL_TEXT_CHARS): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function parseCellValue(v: unknown): CellValue {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  return null;
}

/** `{ profileId, name }` だけを読む。ID が空なら null (それ以外のプロパティは無視する)。 */
function parseConnectionRef(raw: unknown): NotebookConnectionRef | null {
  if (!isObj(raw) || typeof raw.profileId !== "string" || raw.profileId === "") return null;
  return { profileId: str(raw.profileId, 200), name: str(raw.name, 200) };
}

function parseSnapshot(raw: unknown, limit: number): NotebookSnapshot | null {
  if (!isObj(raw)) return null;
  const columns: Column[] = Array.isArray(raw.columns)
    ? raw.columns
        .filter(isObj)
        .slice(0, MAX_COLUMNS)
        .map((c) => ({ name: str(c.name, 1000), type_name: str(c.type_name, 200) }))
    : [];
  const rows: CellValue[][] = Array.isArray(raw.rows)
    ? raw.rows
        .filter(Array.isArray)
        .slice(0, limit)
        .map((r) => (r as unknown[]).slice(0, columns.length).map(parseCellValue))
    : [];
  return {
    columns,
    rows,
    totalRows: Math.max(num(raw.totalRows, rows.length), rows.length),
    truncated: raw.truncated === true,
    rowsAffected: num(raw.rowsAffected),
    hasColumns: raw.hasColumns === true,
    elapsedMs: num(raw.elapsedMs),
    executedAt: str(raw.executedAt, 64),
    error: typeof raw.error === "string" ? raw.error.slice(0, 20_000) : null,
    valuesTruncated: raw.valuesTruncated === true,
    appliedAutoLimit:
      typeof raw.appliedAutoLimit === "number" && Number.isFinite(raw.appliedAutoLimit)
        ? raw.appliedAutoLimit
        : null,
    maskedColumns: Array.isArray(raw.maskedColumns)
      ? raw.maskedColumns.filter((x): x is string => typeof x === "string").slice(0, MAX_COLUMNS)
      : [],
  };
}

/** `.noobnb` の本文を読む。壊れた部分は捨てて読める範囲を復元する (版が新しすぎるときは拒否)。 */
export function parseNotebook(text: string): ParseNotebookResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isObj(raw)) return { ok: false, reason: "invalid" };
  if (raw.format !== NOTEBOOK_FILE_FORMAT) return { ok: false, reason: "format" };
  if (typeof raw.version !== "number" || raw.version > NOTEBOOK_FILE_VERSION) {
    return { ok: false, reason: "newerVersion" };
  }
  const limit = clampSnapshotRowLimit(raw.snapshotRowLimit);
  const seen = new Set<string>();
  const cells: NotebookCell[] = [];
  for (const c of Array.isArray(raw.cells) ? raw.cells.slice(0, MAX_NOTEBOOK_CELLS) : []) {
    if (!isObj(c)) continue;
    let id = str(c.id, 100);
    if (!id || seen.has(id)) id = newCellId();
    seen.add(id);
    if (c.kind === "markdown") {
      cells.push({ id, kind: "markdown", text: str(c.text), collapsed: c.collapsed === true });
    } else if (c.kind === "sql") {
      const snapshot = parseSnapshot(c.snapshot, MAX_SNAPSHOT_ROW_LIMIT);
      cells.push({
        id,
        kind: "sql",
        sql: str(c.sql),
        collapsed: c.collapsed === true,
        snapshot,
        view: c.view === "chart" ? "chart" : "table",
        chart: snapshot ? sanitizeChartConfig(c.chart, snapshot.columns) : null,
        connection: parseConnectionRef(c.connection),
      });
    }
  }
  const docConnection = parseConnectionRef(raw.connection);
  return {
    ok: true,
    doc: {
      title: str(raw.title, 200),
      database: typeof raw.database === "string" && raw.database ? raw.database.slice(0, 200) : null,
      connection: docConnection,
      snapshotRowLimit: limit,
      cells,
    },
  };
}

/** 保存ダイアログの既定ファイル名 (拡張子込み)。パス区切りと制御文字は `_` にする。 */
export function notebookFileName(title: string, ext: string = NOTEBOOK_FILE_EXTENSION): string {
  const base = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return `${base || "notebook"}.${ext}`;
}
