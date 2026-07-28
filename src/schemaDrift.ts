// スキーマドリフト・タイムライン (#736) の世代ストア + 純ロジック。
//
// `planWatch.ts` (#743 実行計画ウォッチ) が確立した「プロファイル単位・
// localStorage・フィンガープリント同一なら世代を増やさない・MAX_GENERATIONS
// ローテーション・破損耐性つき正規化」のパターンを踏襲する。実際のスナップショット
// 取得 (`listTables` + `describeTable` + `listIndexes`) と、前世代との差分計算
// (`diffSchemaSnapshots` IPC 経由。純粋計算層は Rust の `compute_schema_diff` を
// そのまま流用する #736 の設計方針) は App.tsx が担う — ここは保存済み世代の
// 管理とフィンガープリント/差分サマリの純粋な計算に徹する。
//
// インデックスの差分だけは `compute_schema_diff` の対象外 (カラムのみを比較する)
// なので、`diffIndexes` としてここに純 TS 実装する。

import type { ColumnDiff, DriverKind, IndexInfo, SchemaDiff, SchemaSnapshotTable } from "./api/tauri";

const STORAGE_PREFIX = "noobdb.schemadrift.";

/** 1 プロファイルあたり保持する世代の上限 (超過した古い世代は切り捨て)。 */
export const MAX_GENERATIONS = 20;

/**
 * 1 世代の直列化ペイロードがこのサイズ (概算文字数。UTF-16 コードユニット数を
 * バイト数の近似として使う。他モジュールの `MAX_*_BYTES` ガードと同じ精神) を
 * 超えたら保存をスキップする「サイズ暴走ガード」。列数の非常に多いスキーマで
 * localStorage のクォータを食い潰さないための保険で、超過時も世代メタ
 * (捕捉時刻・フィンガープリント・テーブル数) は記録し `omitted: true` を立てる。
 */
export const MAX_SNAPSHOT_BYTES = 200_000;

/** 1 テーブル分のスナップショット: 列メタデータ (`compute_schema_diff` 用の
 *  `SchemaSnapshotTable` を拡張) + インデックス一覧。 */
export interface SnapshotTable extends SchemaSnapshotTable {
  indexes: IndexInfo[];
}

/** 1 世代分の完全なスナップショット内容。 */
export interface SchemaSnapshotPayload {
  driver: DriverKind;
  database: string;
  tables: SnapshotTable[];
}

/** 保存済みのスキーマスナップショット 1 世代。新しい世代が先頭に並ぶ。 */
export interface SchemaGeneration {
  id: string;
  /** 取得時刻 (ISO 8601)。 */
  capturedAt: string;
  driver: DriverKind;
  database: string;
  /** `fingerprintPayload` による内容フィンガープリント (dedupe 用)。 */
  fingerprint: string;
  /** キャプチャ時点のテーブル数 (`payload` が省略されていても保持)。 */
  tableCount: number;
  /** 完全なスナップショット。サイズ暴走ガードで省略された場合は `null`。 */
  payload: SchemaSnapshotPayload | null;
  /** `true` のとき、直列化サイズが `MAX_SNAPSHOT_BYTES` を超えたため
   *  `payload` の保存を省略した (この世代は他世代との差分表示ができない)。 */
  omitted: boolean;
}

/** プロファイル 1 つ分のスキーマドリフト状態。 */
export interface SchemaDriftState {
  generations: SchemaGeneration[];
}

export const EMPTY_SCHEMA_DRIFT: SchemaDriftState = { generations: [] };

function isDriver(v: unknown): v is DriverKind {
  return v === "mysql" || v === "postgres" || v === "sqlite";
}

function isValidGeneration(v: unknown): v is SchemaGeneration {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.capturedAt !== "string" ||
    !isDriver(o.driver) ||
    typeof o.database !== "string" ||
    typeof o.fingerprint !== "string" ||
    typeof o.tableCount !== "number" ||
    typeof o.omitted !== "boolean"
  ) {
    return false;
  }
  // `payload` は omitted なら null、そうでなければ最低限の形を持つオブジェクト。
  if (o.payload === null) return true;
  if (!o.payload || typeof o.payload !== "object") return false;
  const p = o.payload as Record<string, unknown>;
  return isDriver(p.driver) && typeof p.database === "string" && Array.isArray(p.tables);
}

/**
 * パース済み JSON を妥当な状態に整える (純粋)。未知の形・不正な世代は捨て、
 * 世代数は上限でクランプする。`planWatch.normalizePlanWatch` と同じ役割。
 */
export function normalizeSchemaDrift(parsed: unknown): SchemaDriftState {
  if (!parsed || typeof parsed !== "object") return EMPTY_SCHEMA_DRIFT;
  const gensRaw = (parsed as Record<string, unknown>).generations;
  if (!Array.isArray(gensRaw)) return EMPTY_SCHEMA_DRIFT;
  const generations = gensRaw.filter(isValidGeneration).slice(0, MAX_GENERATIONS);
  return { generations };
}

export function loadSchemaDrift(profileId: string): SchemaDriftState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return EMPTY_SCHEMA_DRIFT;
    return normalizeSchemaDrift(JSON.parse(raw));
  } catch {
    return EMPTY_SCHEMA_DRIFT;
  }
}

export function saveSchemaDrift(profileId: string, state: SchemaDriftState): void {
  try {
    if (state.generations.length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + profileId);
    } else {
      localStorage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(state));
    }
  } catch {
    // ignore (quota / disabled storage)
  }
}

/** 世代 ID を生成する (既存のタブ/計画世代 ID 生成と同じ形式)。 */
export function newGenerationId(): string {
  return `drift_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 決定的な短いハッシュ (FNV-1a, 32bit) を 8 桁の16進文字列で返す。暗号学的な
 * 強度は不要 (dedupe 目的の内容フィンガープリントのみ) なので、依存を増やさず
 * 標準の数値演算だけで実装する。
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 捕捉したテーブル群からスナップショットペイロードを組み立てる (純粋)。
 * テーブルを名前順に正規化するため、`listTables` の返却順に依らずフィンガー
 * プリントが安定する。
 */
export function buildSnapshotPayload(
  driver: DriverKind,
  database: string,
  tables: SnapshotTable[],
): SchemaSnapshotPayload {
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  return { driver, database, tables: sorted };
}

/** ペイロードの内容フィンガープリント。直列化した JSON のハッシュ。 */
export function fingerprintPayload(payload: SchemaSnapshotPayload): string {
  return fnv1a(JSON.stringify(payload));
}

/**
 * ペイロードから世代を組み立てる (純粋)。直列化サイズが `MAX_SNAPSHOT_BYTES`
 * を超えるときはサイズ暴走ガードとして `payload` を省略し `omitted: true` を
 * 立てる — フィンガープリント自体は常に全内容から計算するため、省略した
 * 世代でも「前回と同一かどうか」の判定は変わらず正確に働く。
 */
export function captureGeneration(
  payload: SchemaSnapshotPayload,
  capturedAt: string = new Date().toISOString(),
): SchemaGeneration {
  const serialized = JSON.stringify(payload);
  const fingerprint = fnv1a(serialized);
  const omitted = serialized.length > MAX_SNAPSHOT_BYTES;
  return {
    id: newGenerationId(),
    capturedAt,
    driver: payload.driver,
    database: payload.database,
    fingerprint,
    tableCount: payload.tables.length,
    payload: omitted ? null : payload,
    omitted,
  };
}

export interface RecordResult {
  state: SchemaDriftState;
  /** 新しい世代として追加されたか (同一フィンガープリントなら false)。 */
  added: boolean;
  /** 追加時の直前世代 (初回捕捉なら null)。変化検知の比較相手。 */
  prev: SchemaGeneration | null;
}

/**
 * 取得したスナップショットを世代として記録する (純粋)。最新世代とフィンガー
 * プリントが同一なら世代を増やさず、異なるときだけ先頭へ追加して
 * `MAX_GENERATIONS` でローテーションする。
 */
export function recordSnapshotGeneration(
  state: SchemaDriftState,
  gen: SchemaGeneration,
): RecordResult {
  const latest = state.generations.length > 0 ? state.generations[0] : null;
  if (latest && latest.fingerprint === gen.fingerprint) {
    return { state, added: false, prev: null };
  }
  const next = [gen, ...state.generations].slice(0, MAX_GENERATIONS);
  return { state: { generations: next }, added: true, prev: latest };
}

/** この世代が (省略されていないので) 他世代との差分計算に使えるか。 */
export function canDiff(gen: SchemaGeneration): boolean {
  return gen.payload !== null;
}

/** `diffSchemaSnapshots` IPC に渡す入力形へ変換する。省略済み世代は `null`。 */
export function toDiffInput(gen: SchemaGeneration): SchemaSnapshotTable[] | null {
  if (!gen.payload) return null;
  return gen.payload.tables.map((t) => ({ name: t.name, columns: t.columns }));
}

// --- インデックス差分 (compute_schema_diff の対象外なのでここで純 TS 実装) ---

export type IndexDriftStatus = "added" | "removed" | "changed";

/** テーブル 1 つ内、インデックス 1 本の差分。 */
export interface IndexDriftEntry {
  table: string;
  indexName: string;
  status: IndexDriftStatus;
}

/** インデックスの実質的な定義を比較可能な文字列に落とす (名前は除く)。 */
function indexShape(idx: IndexInfo): string {
  return JSON.stringify([idx.columns, idx.unique, idx.primary, idx.method ?? null]);
}

/**
 * 2 世代間でインデックスの追加/削除/変更を検出する (純粋)。両世代に存在する
 * テーブルのみを対象にする — テーブル自体の追加/削除は `compute_schema_diff`
 * (バック側) が既に一段上のレベルで報告するため、ここで二重に数えない。
 * 省略された世代 (`payload === null`) が渡された場合は比較できないので空配列。
 */
export function diffIndexes(
  prev: SchemaGeneration,
  next: SchemaGeneration,
): IndexDriftEntry[] {
  if (!prev.payload || !next.payload) return [];
  const prevByTable = new Map(prev.payload.tables.map((t) => [t.name, t]));
  const entries: IndexDriftEntry[] = [];
  for (const nextTable of next.payload.tables) {
    const prevTable = prevByTable.get(nextTable.name);
    if (!prevTable) continue;
    const prevIdx = new Map(prevTable.indexes.map((i) => [i.name, i]));
    const nextIdx = new Map(nextTable.indexes.map((i) => [i.name, i]));
    for (const [name, idx] of nextIdx) {
      const old = prevIdx.get(name);
      if (!old) {
        entries.push({ table: nextTable.name, indexName: name, status: "added" });
      } else if (indexShape(old) !== indexShape(idx)) {
        entries.push({ table: nextTable.name, indexName: name, status: "changed" });
      }
    }
    for (const name of prevIdx.keys()) {
      if (!nextIdx.has(name)) {
        entries.push({ table: nextTable.name, indexName: name, status: "removed" });
      }
    }
  }
  return entries.sort((a, b) =>
    a.table === b.table ? a.indexName.localeCompare(b.indexName) : a.table.localeCompare(b.table),
  );
}

// --- 変化サマリ (トースト/タイムラインパネル共有の整形ロジック) ---

/** 1 テーブルの変化サマリ。`tableStatus` はテーブル自体の増減、それ以外は
 *  「両側に存在するテーブル」内の列/インデックス単位の変化件数。 */
export interface TableChangeSummary {
  table: string;
  tableStatus: "added" | "removed" | "changed";
  columnsAdded: number;
  columnsRemoved: number;
  columnsChanged: number;
  indexesAdded: number;
  indexesRemoved: number;
  indexesChanged: number;
}

/** 2 世代間の変化サマリ全体。変化のあったテーブルのみ、名前順。 */
export interface DriftSummary {
  tables: TableChangeSummary[];
}

function countStatus(columns: ColumnDiff[], status: ColumnDiff["status"]): number {
  return columns.filter((c) => c.status === status).length;
}

/**
 * バックエンドの `SchemaDiff` (`diffSchemaSnapshots` の戻り値) とフロント計算の
 * インデックス差分を突き合わせ、テーブル単位の変化サマリへ整形する (純粋)。
 * 変化がまったく無いテーブル (`status === "same"` かつインデックス差分無し) は
 * 結果から除外する。
 */
export function summarizeDrift(diff: SchemaDiff, indexDrift: IndexDriftEntry[]): DriftSummary {
  const byTable = new Map<string, IndexDriftEntry[]>();
  for (const entry of indexDrift) {
    const list = byTable.get(entry.table) ?? [];
    list.push(entry);
    byTable.set(entry.table, list);
  }

  const tables: TableChangeSummary[] = [];
  for (const t of diff.tables) {
    const idx = byTable.get(t.name) ?? [];
    const indexesAdded = idx.filter((e) => e.status === "added").length;
    const indexesRemoved = idx.filter((e) => e.status === "removed").length;
    const indexesChanged = idx.filter((e) => e.status === "changed").length;

    if (t.status === "source_only") {
      tables.push({
        table: t.name,
        tableStatus: "removed",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded,
        indexesRemoved,
        indexesChanged,
      });
      continue;
    }
    if (t.status === "target_only") {
      tables.push({
        table: t.name,
        tableStatus: "added",
        columnsAdded: 0,
        columnsRemoved: 0,
        columnsChanged: 0,
        indexesAdded,
        indexesRemoved,
        indexesChanged,
      });
      continue;
    }
    // status === "same" | "different" — 両側に存在するテーブル。
    const columnsAdded = countStatus(t.columns, "target_only");
    const columnsRemoved = countStatus(t.columns, "source_only");
    const columnsChanged = countStatus(t.columns, "different");
    const hasChange =
      t.status === "different" || indexesAdded > 0 || indexesRemoved > 0 || indexesChanged > 0;
    if (!hasChange) continue;
    tables.push({
      table: t.name,
      tableStatus: "changed",
      columnsAdded,
      columnsRemoved,
      columnsChanged,
      indexesAdded,
      indexesRemoved,
      indexesChanged,
    });
  }
  tables.sort((a, b) => a.table.localeCompare(b.table));
  return { tables };
}

/**
 * 1 テーブル分の変化を言語非依存の短い表記に整形する (純粋・テスト対象)。
 * 記号のみを使うことで日英どちらの文脈にも自然に埋め込める:
 * `+table` = テーブル追加、`-table` = テーブル削除、
 * `table(+2,-1,~1)` = 列の追加/削除/変更件数、`idx` プレフィックスはインデックス側。
 */
export function formatTableChangeFragment(c: TableChangeSummary): string {
  if (c.tableStatus === "added") return `+${c.table}`;
  if (c.tableStatus === "removed") return `-${c.table}`;
  const bits: string[] = [];
  if (c.columnsAdded > 0) bits.push(`+${c.columnsAdded}`);
  if (c.columnsRemoved > 0) bits.push(`-${c.columnsRemoved}`);
  if (c.columnsChanged > 0) bits.push(`~${c.columnsChanged}`);
  if (c.indexesAdded > 0 || c.indexesRemoved > 0 || c.indexesChanged > 0) {
    const idxBits: string[] = [];
    if (c.indexesAdded > 0) idxBits.push(`+${c.indexesAdded}`);
    if (c.indexesRemoved > 0) idxBits.push(`-${c.indexesRemoved}`);
    if (c.indexesChanged > 0) idxBits.push(`~${c.indexesChanged}`);
    bits.push(`idx${idxBits.join("")}`);
  }
  return `${c.table}(${bits.join(",")})`;
}

/**
 * トースト通知に埋め込む短い詳細文字列を組み立てる (純粋)。先頭 `maxTables`
 * 件だけを表示し、超過分があれば `…` を付ける。空サマリなら空文字列。
 */
export function buildDriftDetail(summary: DriftSummary, maxTables = 3): string {
  if (summary.tables.length === 0) return "";
  const shown = summary.tables.slice(0, maxTables).map(formatTableChangeFragment);
  const more = summary.tables.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, …` : shown.join(", ");
}
