/**
 * アプリ内アクティビティ (通知センター) の共有ストア (#912)。
 *
 * トースト (`components/Toast.tsx`) は一定時間で自動消滅する**一過性**の通知で、
 * 見逃すと二度と確認できない。インポート結果・同期の成否・実行計画ウォッチの
 * アラート (#743) のように「後から見返したい」イベントがあるため、トースト発火時に
 * ここへ push しておき、ヘッダのベルアイコン (`components/ActivityCenter.tsx`) から
 * 時系列で再閲覧できるようにする。
 *
 * ## 設計方針
 *
 * - **揮発性 (セッション内のみ)**: 在メモリで保持し、localStorage には保存しない。
 *   通知は「今このアプリで何が起きたか」の記録であり、再起動をまたいで蘇らせても
 *   文脈 (どの接続で・どのクエリで) が失われて価値が下がるため。件数上限
 *   (`ACTIVITY_LIMIT`) を超えたら古いものから捨てる (履歴 store と同じローテーション)。
 * - **単一の入口**: 記録は `pushActivity` のみ。トーストは `ToastProvider` が
 *   自動で流し込むので、呼び出し側 (App など) が二重に push する必要はない。
 * - **未読は id の水位で表す**: エントリごとに `read` フラグを持たせず、「最後に
 *   読んだ id」より新しいものを未読とする。純関数 `countUnread` で数えられ、
 *   一覧の再構築 (=全エントリのコピー) が要らない。
 * - **重大度は意味色と共有**: `ActivitySeverity` は `semanticColors.ts` の
 *   `SemanticRole` (success/warning/danger/info) と 1 対 1 で対応させ、色を
 *   二重管理しない (`danger` に対応する語だけ、トーストの tone に合わせて
 *   `error` と呼ぶ)。
 *
 * 一覧の加工 (追加/ローテーション・絞り込み・未読数・相対時刻) はすべて副作用の
 * ない純関数として公開し、`__tests__/activityLog.test.ts` が固定する。
 */

import { useSyncExternalStore } from "react";
import type { SemanticRole } from "./semanticColors";

/**
 * アクティビティの重大度。意味色の役割 (`SemanticRole`) と 1 対 1 で、
 * `danger` に相当するものだけトーストの tone と同じ `error` と呼ぶ。
 */
export type ActivitySeverity = "info" | "success" | "warning" | "error";

/** 重大度 → 意味色の役割。色/アイコンはこの対応を通してのみ決める。 */
export const ACTIVITY_SEVERITY_ROLE: Record<ActivitySeverity, SemanticRole> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "danger",
};

/** フィルタ UI が並べる重大度の順 (深刻な方から)。 */
export const ACTIVITY_SEVERITIES: readonly ActivitySeverity[] = [
  "error",
  "warning",
  "success",
  "info",
];

export interface ActivityEntry {
  /** 単調増加の識別子。未読判定 (水位) と React の key に使う。 */
  id: number;
  severity: ActivitySeverity;
  message: string;
  /** 記録時刻 (epoch ミリ秒)。 */
  at: number;
}

/** 保持する最大件数。超えた分は古いものから捨てる。 */
export const ACTIVITY_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// 純ロジック
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 新しいエントリを先頭 (最新が先) に足し、`limit` を超えた古い分を捨てた
 * 新しい配列を返す。入力は変更しない。`limit` が 0 以下なら空配列。
 */
export function appendActivity(
  list: readonly ActivityEntry[],
  entry: ActivityEntry,
  limit: number = ACTIVITY_LIMIT,
): ActivityEntry[] {
  if (!(limit > 0)) return [];
  return [entry, ...list].slice(0, Math.floor(limit));
}

/** 重大度で絞り込む。`null` (フィルタなし) はそのまま全件返す。 */
export function filterActivity(
  list: readonly ActivityEntry[],
  severity: ActivitySeverity | null,
): ActivityEntry[] {
  if (!severity) return [...list];
  return list.filter((e) => e.severity === severity);
}

/** `lastReadId` より新しい (= 未読の) 件数。 */
export function countUnread(list: readonly ActivityEntry[], lastReadId: number): number {
  return list.reduce((n, e) => (e.id > lastReadId ? n + 1 : n), 0);
}

/** 重大度ごとの件数 (フィルタチップのバッジ用)。 */
export function countBySeverity(
  list: readonly ActivityEntry[],
): Record<ActivitySeverity, number> {
  const out: Record<ActivitySeverity, number> = { info: 0, success: 0, warning: 0, error: 0 };
  for (const e of list) out[e.severity]++;
  return out;
}

/** 相対時刻の表現。文言の解決は i18n を持つ呼び出し側 (UI) が行う。 */
export type RelativeTime =
  | { unit: "now" }
  | { unit: "minutes"; value: number }
  | { unit: "hours"; value: number }
  | { unit: "days"; value: number };

/**
 * `at` (epoch ミリ秒) の `now` 時点での相対時刻を返す。1 分未満は `now`、
 * 以降は分 → 時間 → 日に丸める。未来の時刻 (時計のずれ) も `now` に倒す。
 */
export function relativeActivityTime(at: number, now: number): RelativeTime {
  const diffSec = Math.floor((now - at) / 1000);
  if (!Number.isFinite(diffSec) || diffSec < 60) return { unit: "now" };
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  return { unit: "days", value: Math.floor(hours / 24) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ストア (useSyncExternalStore ベース、settings.ts と同じ形)
// ─────────────────────────────────────────────────────────────────────────────

export interface ActivityState {
  entries: ActivityEntry[];
  /** 最後に既読にした id (これより大きい id が未読)。 */
  lastReadId: number;
}

const EMPTY_STATE: ActivityState = { entries: [], lastReadId: 0 };

let current: ActivityState = EMPTY_STATE;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((cb) => cb());
}

export function getActivityState(): ActivityState {
  return current;
}

/**
 * アクティビティを 1 件記録する。トーストからは `ToastProvider` が自動で
 * 呼ぶので、通知を出す側が別途呼ぶ必要はない。トーストを伴わない記録
 * (バックグラウンド処理の結果など) をしたい場合だけ直接呼ぶ。
 * @public
 */
export function pushActivity(severity: ActivitySeverity, message: string): void {
  const entry: ActivityEntry = { id: nextId++, severity, message, at: Date.now() };
  current = { ...current, entries: appendActivity(current.entries, entry) };
  emit();
}

/** すべて既読にする (センターを開いたとき)。 */
export function markActivityRead(): void {
  const top = current.entries[0]?.id ?? 0;
  if (current.lastReadId === top) return;
  current = { ...current, lastReadId: top };
  emit();
}

/** 履歴を消す (既読水位も戻す)。 */
export function clearActivity(): void {
  if (current.entries.length === 0 && current.lastReadId === 0) return;
  current = EMPTY_STATE;
  emit();
}

/** テスト用のリセット (id 採番も戻す)。 @public */
export function __resetActivityLog(): void {
  current = EMPTY_STATE;
  nextId = 1;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useActivityLog(): ActivityState {
  return useSyncExternalStore(subscribe, getActivityState, getActivityState);
}
