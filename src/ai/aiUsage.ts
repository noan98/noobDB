// AI の使用量表示 (#1474)。完了メッセージ (Channel の `done`) の整形を純関数で持つ。
// 日次・タスク別の集計と概算コストは使用量台帳 (#1540) の `aiUsageCost.ts`。
// 料金の概算はここでは扱わない (日次・タスク別と合わせて `aiUsageCost.ts` / 台帳 #1540 が担う)。

import { AI_MODEL_LABELS, isAiModelId } from "./aiModels";

/** 累計に必要な完了イベントの最小形 (`AiDoneEvent` の部分集合)。 */
export interface AiUsageEventLike {
  model: string;
  requestedModel: string;
  fallbackUsed: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

const ZERO_USAGE: AiUsageEventLike["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/**
 * 使用量を取り出す。実イベントは IPC 境界のスキーマ検証を通るので常に揃っているが、
 * 画面の表示 / 累計が欠けた値で落ちないよう 0 扱いにする (テストのモックも含む)。
 */
function usageOf(event: AiUsageEventLike): AiUsageEventLike["usage"] {
  return { ...ZERO_USAGE, ...(event.usage as Partial<AiUsageEventLike["usage"]> | undefined) };
}

/** トークン数の短縮表記 (999 → "999"、3200 → "3.2k"、1_250_000 → "1.3M")。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.floor(n)));
  const short = (v: number, unit: string) => `${(Math.round(v * 10) / 10).toString()}${unit}`;
  if (n < 999_950) return short(n / 1000, "k");
  return short(n / 1_000_000, "M");
}

/** モデル ID の表示名 (未知の ID はそのまま)。 */
export function modelLabel(id: string): string {
  return isAiModelId(id) ? AI_MODEL_LABELS[id] : id;
}

/** 回答下の使用量表示に必要な値。文言は `AiUsageNote` が i18n で組み立てる。 */
export interface AiUsageSummary {
  model: string;
  /** フォールバックしたときの要求モデルの表示名。していなければ `null`。 */
  fallbackFrom: string | null;
  input: string;
  output: string;
  /** キャッシュ書き込み (作成) 分。0 のときは `null`。 */
  cacheWrite: string | null;
  /** キャッシュ読み取り分。0 のときは `null`。 */
  cacheRead: string | null;
}

export function summarizeUsage(event: AiUsageEventLike): AiUsageSummary {
  const u = usageOf(event);
  return {
    model: modelLabel(event.model),
    fallbackFrom: event.fallbackUsed ? modelLabel(event.requestedModel) : null,
    // API の `input_tokens` はキャッシュ分を含まない。入力が少なく見えないよう、
    // キャッシュの書き込み / 読み取りは 0 より大きいときだけ別に併記する。
    input: formatTokens(u.inputTokens),
    output: formatTokens(u.outputTokens),
    cacheWrite: u.cacheCreationInputTokens > 0 ? formatTokens(u.cacheCreationInputTokens) : null,
    cacheRead: u.cacheReadInputTokens > 0 ? formatTokens(u.cacheReadInputTokens) : null,
  };
}
