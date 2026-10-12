// AI 使用量台帳 (`get_ai_usage_history`、#1540) の集計と概算コストの計算。純関数のみ。
// 単価は `aiModels.ts` の `AI_MODEL_PRICES` (概算用の手書き定数)。台帳は数値だけで、
// 送信内容や API キーは含まれない。

import type { AiUsageRecord } from "../api/tauri";
import { AI_MODEL_PRICES, isAiModelId } from "./aiModels";

/** 集計 1 行 (モデル別 / タスク別 / 日別 / 合計で共通)。 */
export interface UsageAggregate {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** 単価が分かるモデルの分の概算 (USD)。 */
  costUsd: number;
  /** 単価表に無いモデルの呼び出し回数 (これがあると `costUsd` は下限の目安)。 */
  unpricedCalls: number;
}

function empty(key: string): UsageAggregate {
  return {
    key,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
}

/** 1 レコードの概算コスト (USD)。単価表に無いモデルは `null`。 */
export function estimateRecordCostUsd(r: AiUsageRecord): number | null {
  if (!isAiModelId(r.model)) return null;
  const p = AI_MODEL_PRICES[r.model];
  return (
    (r.inputTokens * p.input +
      r.outputTokens * p.output +
      r.cacheReadInputTokens * p.cacheRead +
      r.cacheCreationInputTokens * p.cacheWrite) /
    1_000_000
  );
}

function add(into: UsageAggregate, r: AiUsageRecord): void {
  into.calls += r.calls;
  into.inputTokens += r.inputTokens;
  into.outputTokens += r.outputTokens;
  into.cacheReadInputTokens += r.cacheReadInputTokens;
  into.cacheCreationInputTokens += r.cacheCreationInputTokens;
  const cost = estimateRecordCostUsd(r);
  if (cost === null) into.unpricedCalls += r.calls;
  else into.costUsd += cost;
}

export interface UsageReport {
  total: UsageAggregate;
  /** コストの大きい順 (同額は呼び出し回数順)。 */
  byModel: UsageAggregate[];
  byTask: UsageAggregate[];
  /** 新しい日が先頭。 */
  byDay: UsageAggregate[];
}

/** JST の `YYYY-MM-DD` (台帳の日キーと同じ基準) を `days` 日前まで遡った下限。 */
export function sinceDayKey(now: Date, days: number): string {
  const d = new Date(now.getTime() + 9 * 60 * 60 * 1000 - (days - 1) * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** JST の今月 1 日 (`YYYY-MM-01`)。台帳の日キーと同じ基準 (月の境目は JST 0 時)。 */
export function monthStartKey(now: Date): string {
  return `${new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7)}-01`;
}

/** 台帳を集計する。`sinceDay` (含む) 以降の日だけを対象にする (省略で全期間)。 */
export function buildUsageReport(records: readonly AiUsageRecord[], sinceDay?: string): UsageReport {
  const total = empty("total");
  const models = new Map<string, UsageAggregate>();
  const tasks = new Map<string, UsageAggregate>();
  const days = new Map<string, UsageAggregate>();
  for (const r of records) {
    if (sinceDay && r.day < sinceDay) continue;
    add(total, r);
    for (const [map, key] of [
      [models, r.model],
      [tasks, r.task],
      [days, r.day],
    ] as const) {
      let row = map.get(key);
      if (!row) {
        row = empty(key);
        map.set(key, row);
      }
      add(row, r);
    }
  }
  const byWeight = (a: UsageAggregate, b: UsageAggregate) =>
    b.costUsd - a.costUsd || b.calls - a.calls || a.key.localeCompare(b.key);
  return {
    total,
    byModel: [...models.values()].sort(byWeight),
    byTask: [...tasks.values()].sort(byWeight),
    byDay: [...days.values()].sort((a, b) => b.key.localeCompare(a.key)),
  };
}

/** USD の表示 (概算なので桁は控えめ。1 セント未満は有効桁が残るよう 4 桁)。 */
export function formatUsd(v: number): string {
  if (v <= 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}
