// AI 使用量の今月 (JST) 累計の保存先 (#1474)。設定 (`settings.ts`) とは別の localStorage キーに
// 持つ。応答のたびに更新されるため、設定全体の書き込み・再描画・エクスポート/インポート/
// 全初期化に混ぜない。秘密情報ではない。月替わりの判定は読み書きのたびにここで行う。

import { useMemo, useSyncExternalStore } from "react";
import {
  addUsage,
  emptyUsageTotals,
  rollUsageMonth,
  sanitizeAiUsageTotals,
  type AiUsageEventLike,
  type AiUsageTotals,
} from "./aiUsage";

const STORAGE_KEY = "noobdb.aiUsage";

function load(): AiUsageTotals {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeAiUsageTotals(JSON.parse(raw));
  } catch {
    // 読めなければ空から始める
  }
  return emptyUsageTotals(new Date());
}

let current: AiUsageTotals = load();
const listeners = new Set<() => void>();

function commit(next: AiUsageTotals): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくてもメモリ上の累計は続ける
  }
  listeners.forEach((cb) => cb());
}

/** 完了イベント 1 件を今月の累計に加算する。`useAiStream` 以外の経路 (インライン補完など) もここを呼ぶ。 */
export function recordAiUsage(event: AiUsageEventLike, now: Date = new Date()): void {
  commit(addUsage(current, event, now));
}

/** 今月の累計をリセットする。 */
export function resetAiUsage(now: Date = new Date()): void {
  commit(emptyUsageTotals(now));
}

/** 現在の累計 (月が替わっていれば空の新しい月)。 */
export function getAiUsage(now: Date = new Date()): AiUsageTotals {
  return rollUsageMonth(current, now);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 設定画面用: 今月の累計を購読する。 */
export function useAiUsage(): AiUsageTotals {
  const snapshot = useSyncExternalStore(subscribe, () => current);
  return useMemo(() => rollUsageMonth(snapshot, new Date()), [snapshot]);
}
