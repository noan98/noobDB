// 実行計画ウォッチ (#743) の世代ストア。
//
// `tableQuickAccess.ts` と同じく、プロファイルごとに localStorage へ永続化する。
// スニペット (保存クエリ) 単位で EXPLAIN 計画のスナップショットを世代管理し、
// 「内容が同一なら世代を増やさない」「上限でローテーション」を純関数で提供する
// (Vitest でユニットテスト)。EXPLAIN の実行・変化通知・比較 UI は App.tsx /
// PlanWatchPanel.tsx が担当し、計画の正規化・比較は `components/planDiff.ts` に任せる。

import type { PlanPayloadKind } from "./components/planDiff";

const STORAGE_PREFIX = "noobdb.planwatch.";

/** 1 ウォッチあたり保持する世代の上限 (超過した古い世代は切り捨て)。 */
export const MAX_GENERATIONS = 20;

/** 保存済みの計画 1 世代。新しい世代が先頭に並ぶ。 */
export interface PlanGeneration {
  id: string;
  /** 取得時刻 (ISO 8601)。 */
  capturedAt: string;
  driver: string;
  /** `planDiff.snapshotFromResult` が生成したペイロード種別。 */
  payloadKind: PlanPayloadKind;
  /** MySQL/PG: 生 JSON 文字列。SQLite: [id, parent, detail] 行の JSON。 */
  payload: string;
  /** `planDiff.planFingerprint` による構造フィンガープリント (dedupe 用)。 */
  fingerprint: string;
}

/** スニペット ID → 世代列 (新しい順)。エントリの存在 = ウォッチ登録済み。 */
export interface PlanWatchState {
  watches: Record<string, PlanGeneration[]>;
}

export const EMPTY_PLAN_WATCH: PlanWatchState = { watches: {} };

function isValidGeneration(v: unknown): v is PlanGeneration {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.capturedAt === "string" &&
    typeof o.driver === "string" &&
    (o.payloadKind === "json" || o.payloadKind === "sqliteRows") &&
    typeof o.payload === "string" &&
    typeof o.fingerprint === "string"
  );
}

/**
 * パース済み JSON を妥当な状態に整える。純粋 (ストレージ非依存) なのでユニット
 * テストできる。未知の形・不正な世代は捨て、世代数は上限でクランプする。
 */
export function normalizePlanWatch(parsed: unknown): PlanWatchState {
  if (!parsed || typeof parsed !== "object") return EMPTY_PLAN_WATCH;
  const watchesRaw = (parsed as Record<string, unknown>).watches;
  if (!watchesRaw || typeof watchesRaw !== "object") return EMPTY_PLAN_WATCH;
  const watches: Record<string, PlanGeneration[]> = {};
  for (const [snippetId, gens] of Object.entries(watchesRaw as Record<string, unknown>)) {
    if (!Array.isArray(gens)) continue;
    watches[snippetId] = gens.filter(isValidGeneration).slice(0, MAX_GENERATIONS);
  }
  return { watches };
}

export function isWatched(state: PlanWatchState, snippetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.watches, snippetId);
}

/** ウォッチ登録済みのスニペット ID 一覧 (登録順)。 */
export function watchedIds(state: PlanWatchState): string[] {
  return Object.keys(state.watches);
}

/**
 * ウォッチを切り替える (純粋: 新しい状態を返す)。解除時は蓄積した世代ごと削除
 * する (実データ由来の計画 JSON をローカルに残さない)。
 */
export function toggleWatch(state: PlanWatchState, snippetId: string): PlanWatchState {
  if (isWatched(state, snippetId)) {
    const watches = { ...state.watches };
    delete watches[snippetId];
    return { watches };
  }
  return { watches: { ...state.watches, [snippetId]: [] } };
}

/** ウォッチから 1 件除去する (純粋)。`toggleWatch` の解除側と同じ。 */
export function removeWatch(state: PlanWatchState, snippetId: string): PlanWatchState {
  if (!isWatched(state, snippetId)) return state;
  return toggleWatch(state, snippetId);
}

/**
 * もう存在しないスニペット (削除済み) のウォッチを取り除く。`available` は
 * 現在実在するスニペット ID の集合。純粋。
 */
export function pruneMissingWatches(state: PlanWatchState, available: string[]): PlanWatchState {
  const ids = watchedIds(state).filter((id) => available.includes(id));
  if (ids.length === watchedIds(state).length) return state;
  const watches: Record<string, PlanGeneration[]> = {};
  for (const id of ids) watches[id] = state.watches[id];
  return { watches };
}

export interface RecordResult {
  state: PlanWatchState;
  /** 新しい世代として追加されたか (同一計画なら false のまま世代は増えない)。 */
  added: boolean;
  /** 追加時の直前世代 (初回取得なら null)。変化検知の比較相手。 */
  prev: PlanGeneration | null;
}

/**
 * 取得した計画を世代として記録する (純粋)。未ウォッチのスニペットには何も
 * しない。最新世代とフィンガープリントが同一なら世代を増やさず、異なるときだけ
 * 先頭へ追加して `MAX_GENERATIONS` でローテーションする。
 */
export function recordGeneration(
  state: PlanWatchState,
  snippetId: string,
  gen: PlanGeneration,
): RecordResult {
  if (!isWatched(state, snippetId)) return { state, added: false, prev: null };
  const gens = state.watches[snippetId];
  const latest = gens.length > 0 ? gens[0] : null;
  if (latest && latest.fingerprint === gen.fingerprint) {
    return { state, added: false, prev: null };
  }
  const next = [gen, ...gens].slice(0, MAX_GENERATIONS);
  return {
    state: { watches: { ...state.watches, [snippetId]: next } },
    added: true,
    prev: latest,
  };
}

/** 世代 ID を生成する (既存のタブ ID 生成と同じ形式)。 */
export function newGenerationId(): string {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadPlanWatch(profileId: string): PlanWatchState {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileId);
    if (!raw) return EMPTY_PLAN_WATCH;
    return normalizePlanWatch(JSON.parse(raw));
  } catch {
    return EMPTY_PLAN_WATCH;
  }
}

export function savePlanWatch(profileId: string, state: PlanWatchState): void {
  try {
    if (watchedIds(state).length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + profileId);
    } else {
      localStorage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(state));
    }
  } catch {
    // ignore (quota / disabled storage)
  }
}
