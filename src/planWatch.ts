// 実行計画ウォッチ (#743) のフロント側ロジック。
//
// 世代の保存・dedupe・ローテーション・EXPLAIN の実行と前世代との比較は Rust の
// `plan_watch` モジュールに移した (#1260: 旧実装は EXPLAIN を 1 件ずつ直列に
// `runQuery` し、毎回 localStorage 全体を JSON で読み書きしていた)。ここに残るのは、
// (1) ウォッチ状態 (スニペット ID → 世代列) の表現と読み取り専用ヘルパ、
// (2) パネルの値変化フラッシュ判定、(3) 旧 localStorage ウォッチを Rust ストアへ
// 一度だけ移す移行コードのみ。計画の比較・描画は `components/planDiff.ts` が
// 保存済みペイロードから行う (表示専用)。

import type { PlanWatchEntry, PlanWatchGeneration } from "./api/tauri";
import type { LiveField } from "./components/liveDiff";

const STORAGE_PREFIX = "noobdb.planwatch.";

/** 旧ストアが 1 ウォッチあたり保持していた世代の上限 (移行時のクランプ用)。 */
export const MAX_LEGACY_GENERATIONS = 20;

export type PlanGeneration = PlanWatchGeneration;

/** スニペット ID → 世代列 (新しい順)。エントリの存在 = ウォッチ登録済み。 */
export interface PlanWatchState {
  watches: Record<string, PlanGeneration[]>;
}

export const EMPTY_PLAN_WATCH: PlanWatchState = { watches: {} };

/** `plan_watch_list` の結果をパネル / App が使う状態へ変換する (登録順を保つ)。 */
export function planWatchStateFromEntries(entries: PlanWatchEntry[]): PlanWatchState {
  const watches: Record<string, PlanGeneration[]> = {};
  for (const e of entries) watches[e.snippetId] = e.generations;
  return { watches };
}

/** 計画ウォッチパネルの 1 行 (ウォッチ中のスニペット)。 */
export interface WatchedRowSnapshot {
  id: string;
  generations: PlanGeneration[];
}

/**
 * 計画ウォッチパネルの値変化フラッシュ (#1022) の判定。最新世代が入れ替わった
 * (= 更新で新しい計画が記録された) ときだけ世代数の表示を光らせる。世代数は
 * 上限で頭打ちになるため、件数ではなく先頭世代の ID で見る。
 * 件数の増減 (古い世代の刈り込みなど) も併せて変化とみなす。
 */
export const PLAN_WATCH_LIVE_FIELDS: readonly LiveField<WatchedRowSnapshot, "generations">[] = [
  {
    name: "generations",
    changed: (a, b) =>
      (a.generations[0]?.id ?? null) !== (b.generations[0]?.id ?? null) ||
      a.generations.length !== b.generations.length,
  },
];

/** 計画ウォッチ行の安定 key (#1022)。 */
export function watchedRowKey(row: WatchedRowSnapshot): string {
  return row.id;
}

export function isWatched(state: PlanWatchState, snippetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.watches, snippetId);
}

/** ウォッチ登録済みのスニペット ID 一覧 (登録順)。 */
export function watchedIds(state: PlanWatchState): string[] {
  return Object.keys(state.watches);
}

// --- 旧 localStorage ウォッチの移行 (#1260) ---

function isValidLegacyGeneration(v: unknown): v is PlanGeneration {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.capturedAt === "string" &&
    typeof o.driver === "string" &&
    (o.payloadKind === "json" || o.payloadKind === "sqliteRows") &&
    typeof o.payload === "string"
  );
}

/**
 * 旧 localStorage のパース済み JSON から、Rust ストアへ渡せるウォッチ (登録順) を
 * 取り出す (純粋)。未知の形・不正な世代は捨て、世代数は旧上限でクランプする。
 * 世代を持たないウォッチ (登録だけ) も残す。
 */
export function normalizeLegacyPlanWatch(parsed: unknown): PlanWatchEntry[] {
  if (!parsed || typeof parsed !== "object") return [];
  const watchesRaw = (parsed as Record<string, unknown>).watches;
  if (!watchesRaw || typeof watchesRaw !== "object") return [];
  const out: PlanWatchEntry[] = [];
  for (const [snippetId, gens] of Object.entries(watchesRaw as Record<string, unknown>)) {
    if (!Array.isArray(gens)) continue;
    out.push({
      snippetId,
      generations: gens.filter(isValidLegacyGeneration).slice(0, MAX_LEGACY_GENERATIONS),
    });
  }
  return out;
}

/** 移行元の localStorage キー。 */
export function legacyPlanWatchKey(profileId: string): string {
  return STORAGE_PREFIX + profileId;
}

/**
 * このプロファイルの旧 localStorage ウォッチを Rust ストアへ一度だけ取り込み、成功したら
 * キーを削除する。キーが無ければ何もしない。取り込みに失敗したとき (IPC エラー) は
 * キーを残し、次回の起動で再試行する。破損した JSON はキーごと破棄する。
 */
export async function migrateLegacyPlanWatch(
  profileId: string,
  importLegacy: (profileId: string, watches: PlanWatchEntry[]) => Promise<number>,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): Promise<void> {
  const key = legacyPlanWatchKey(profileId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return;
  }
  if (raw === null) return;
  let watches: PlanWatchEntry[] = [];
  try {
    watches = normalizeLegacyPlanWatch(JSON.parse(raw));
  } catch {
    watches = [];
  }
  try {
    if (watches.length > 0) await importLegacy(profileId, watches);
    storage.removeItem(key);
  } catch {
    // 取り込み失敗 (IPC エラー) / ストレージ不可: キーを残して次回再試行する。
  }
}
