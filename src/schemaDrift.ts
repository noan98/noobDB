// スキーマドリフト・タイムライン (#736) のフロント側ロジック。
//
// 世代の取得・正規化・フィンガープリント・保存・ローテーション・差分計算は Rust の
// `schema_drift` モジュールに移した (#1260: 旧実装は listTables → テーブルごとの
// describeTable + listIndexes の直列 2N IPC と、1 世代 200KB × 20 世代の localStorage
// 同期読み書きだった)。ここに残るのは、(1) 結果サマリをトースト用の短い表記へ整形する
// 純関数と、(2) 旧 localStorage 世代を Rust ストアへ一度だけ移す移行コードのみ。

import type {
  DriverKind,
  SchemaDriftGeneration,
  SchemaDriftSummary,
  SchemaDriftTableChange,
} from "./api/tauri";

const STORAGE_PREFIX = "noobdb.schemadrift.";

/** 旧ストアが 1 プロファイルあたり保持していた世代の上限 (移行時のクランプ用)。 */
export const MAX_LEGACY_GENERATIONS = 20;

/** この世代が (省略されていないので) 他世代との差分計算に使えるか。 */
export function canDiff(gen: SchemaDriftGeneration): boolean {
  return !gen.omitted;
}

// --- 変化サマリ (トースト/タイムラインパネル共有の整形ロジック) ---

/**
 * 1 テーブル分の変化を言語非依存の短い表記に整形する (純粋・テスト対象)。
 * 記号のみを使うことで日英どちらの文脈にも自然に埋め込める:
 * `+table` = テーブル追加、`-table` = テーブル削除、
 * `table(+2,-1,~1)` = 列の追加/削除/変更件数、`idx` プレフィックスはインデックス側。
 */
export function formatTableChangeFragment(c: SchemaDriftTableChange): string {
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
export function buildDriftDetail(summary: SchemaDriftSummary, maxTables = 3): string {
  if (summary.tables.length === 0) return "";
  const shown = summary.tables.slice(0, maxTables).map(formatTableChangeFragment);
  const more = summary.tables.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, …` : shown.join(", ");
}

// --- 旧 localStorage 世代の移行 (#1260) ---

function isDriver(v: unknown): v is DriverKind {
  return v === "mysql" || v === "postgres" || v === "sqlite";
}

function isValidLegacyGeneration(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.capturedAt !== "string" ||
    !isDriver(o.driver) ||
    typeof o.database !== "string" ||
    typeof o.fingerprint !== "string" ||
    typeof o.tableCount !== "number"
  ) {
    return false;
  }
  // `payload` は省略世代なら null、そうでなければ最低限の形を持つオブジェクト。
  if (o.payload === null) return true;
  if (!o.payload || typeof o.payload !== "object") return false;
  const p = o.payload as Record<string, unknown>;
  return isDriver(p.driver) && typeof p.database === "string" && Array.isArray(p.tables);
}

/**
 * 旧 localStorage のパース済み JSON から、Rust ストアへ渡せる世代 (新しい順) だけを
 * 取り出す (純粋)。未知の形・不正な世代は捨て、世代数は旧上限でクランプする。
 */
export function normalizeLegacySchemaDrift(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const gens = (parsed as Record<string, unknown>).generations;
  if (!Array.isArray(gens)) return [];
  return gens.filter(isValidLegacyGeneration).slice(0, MAX_LEGACY_GENERATIONS);
}

/** 移行元の localStorage キー。 */
export function legacySchemaDriftKey(profileId: string): string {
  return STORAGE_PREFIX + profileId;
}

/**
 * このプロファイルの旧 localStorage 世代を Rust ストアへ一度だけ取り込み、成功したら
 * キーを削除する。キーが無ければ何もしない。取り込みに失敗したとき (IPC エラー)
 * はキーを残し、次回の起動で再試行する。破損した JSON は移行しようがないので
 * キーごと破棄する。ストレージが使えない環境でも例外は投げない。
 */
export async function migrateLegacySchemaDrift(
  profileId: string,
  importLegacy: (profileId: string, generations: unknown[]) => Promise<number>,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): Promise<void> {
  const key = legacySchemaDriftKey(profileId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return;
  }
  if (raw === null) return;
  let generations: unknown[] = [];
  try {
    generations = normalizeLegacySchemaDrift(JSON.parse(raw));
  } catch {
    generations = [];
  }
  try {
    if (generations.length > 0) await importLegacy(profileId, generations);
    storage.removeItem(key);
  } catch {
    // 取り込み失敗 (IPC エラー) / ストレージ不可: キーを残して次回再試行する。
  }
}
