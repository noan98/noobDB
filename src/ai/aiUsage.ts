// AI の使用量表示と今月の累計 (#1474)。完了イベント (`ai-stream:done`) の整形と、
// JST 基準の月次累計の加算・月替わり判定を純関数で持つ。保存は `settings.ts` (`ai.usage`)。
// 料金の概算は扱わない (単価は変わるため。トークン数だけを見せる)。

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

/** 1 モデル分の累計。 */
export interface AiModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 月次累計。`month` は JST の `YYYY-MM`。 */
export interface AiUsageTotals {
  month: string;
  byModel: Record<string, AiModelUsage>;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日時を JST (UTC+9) の `YYYY-MM` にする。月の境目は JST 0 時 (UTC 15 時)。 */
export function jstMonthKey(date: Date): string {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function emptyUsageTotals(now: Date): AiUsageTotals {
  return { month: jstMonthKey(now), byModel: {} };
}

/** 保存値 (形が不明) を有効な累計へ丸める。壊れた値は空に戻す。 */
export function sanitizeAiUsageTotals(input: unknown, now: Date = new Date()): AiUsageTotals {
  if (!input || typeof input !== "object") return emptyUsageTotals(now);
  const p = input as Record<string, unknown>;
  if (typeof p.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) {
    return emptyUsageTotals(now);
  }
  const byModel: Record<string, AiModelUsage> = {};
  const src = p.byModel && typeof p.byModel === "object" ? (p.byModel as Record<string, unknown>) : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  for (const [model, raw] of Object.entries(src)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    byModel[model] = {
      requests: num(r.requests),
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadInputTokens: num(r.cacheReadInputTokens),
      cacheCreationInputTokens: num(r.cacheCreationInputTokens),
    };
  }
  return { month: p.month, byModel };
}

/**
 * 表示・加算の前に月を合わせる。保存済みの月が `now` の月と違えば空の新しい月にする
 * (月が変わると数え直す)。
 */
export function rollUsageMonth(totals: AiUsageTotals, now: Date): AiUsageTotals {
  return totals.month === jstMonthKey(now) ? totals : emptyUsageTotals(now);
}

/** 完了イベント 1 件を加算した新しい累計 (入力は変更しない)。実際に応答したモデルで数える。 */
export function addUsage(totals: AiUsageTotals, event: AiUsageEventLike, now: Date): AiUsageTotals {
  const base = rollUsageMonth(totals, now);
  const prev = base.byModel[event.model] ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const u = usageOf(event);
  return {
    month: base.month,
    byModel: {
      ...base.byModel,
      [event.model]: {
        requests: prev.requests + 1,
        inputTokens: prev.inputTokens + u.inputTokens,
        outputTokens: prev.outputTokens + u.outputTokens,
        cacheReadInputTokens: prev.cacheReadInputTokens + u.cacheReadInputTokens,
        cacheCreationInputTokens: prev.cacheCreationInputTokens + u.cacheCreationInputTokens,
      },
    },
  };
}

/** モデル別累計の合計。 */
export function sumUsage(totals: AiUsageTotals): AiModelUsage {
  const sum: AiModelUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const m of Object.values(totals.byModel)) {
    sum.requests += m.requests;
    sum.inputTokens += m.inputTokens;
    sum.outputTokens += m.outputTokens;
    sum.cacheReadInputTokens += m.cacheReadInputTokens;
    sum.cacheCreationInputTokens += m.cacheCreationInputTokens;
  }
  return sum;
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
  /** キャッシュ読み取り分があるときだけ。 */
  cacheRead: string | null;
}

export function summarizeUsage(event: AiUsageEventLike): AiUsageSummary {
  const u = usageOf(event);
  return {
    model: modelLabel(event.model),
    fallbackFrom: event.fallbackUsed ? modelLabel(event.requestedModel) : null,
    // キャッシュ作成・読み取りも入力側のトークンなので、表示の「入力」には含めない
    // (API の input_tokens はキャッシュ分を除いた値)。キャッシュ読み取りは別に併記する。
    input: formatTokens(u.inputTokens),
    output: formatTokens(u.outputTokens),
    cacheRead: u.cacheReadInputTokens > 0 ? formatTokens(u.cacheReadInputTokens) : null,
  };
}
