import { useSyncExternalStore } from "react";
import type { QueryResult } from "./api/tauri";

/**
 * EXPLAIN タブで「固定」した実行計画 (#1539)。インデックス追加前後のように、計画を固定して
 * から SQL / スキーマを変えて EXPLAIN をやり直し、固定した計画と今の計画を見比べるための
 * 一時的な保持。タブ (scope) ごとに 1 件、在メモリのみで永続化しない — 実行計画ウォッチ
 * (#743) のような世代の蓄積ではなく、その場の比較用。
 */
export interface PinnedPlan {
  /** 固定した EXPLAIN 結果そのもの (再パースして比べる)。 */
  result: QueryResult;
  /** パーサを選ぶドライバ。接続を切り替えたら比較しない。 */
  driver: string;
  pinnedAt: number;
  /** 固定時の元 SQL (ラベル用。分からなければ null)。 */
  sql: string | null;
  /** 固定時が実測モード (EXPLAIN ANALYZE) だったか。 */
  analyze: boolean;
}

const pins = new Map<string, PinnedPlan>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((cb) => cb());
}

export function pinExplainPlan(scope: string, plan: PinnedPlan): void {
  pins.set(scope, plan);
  emit();
}

export function clearExplainPin(scope: string): void {
  if (pins.delete(scope)) emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** `scope` に固定された計画 (無ければ null)。 */
export function useExplainPin(scope: string): PinnedPlan | null {
  return useSyncExternalStore(
    subscribe,
    () => pins.get(scope) ?? null,
    () => null,
  );
}

/** テスト用のリセット。 @public */
export function __resetExplainPins(): void {
  pins.clear();
  emit();
}
