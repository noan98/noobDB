// AI 基盤 (#690) のモデル・タスク種別・エフォートの定義と、設定画面のプルダウン選択肢。
//
// Rust 側 `src-tauri/src/ai/models.rs` との二重定義。集合と推奨値の一致は
// `__tests__/aiParity.test.ts` が Rust ソースを読んで固定する。モデル ID を IPC の
// 呼び出し側が直接渡す経路は作らない (「タスク種別 + 設定スナップショット」を渡し、
// `taskModels[kind] ?? defaultModel` の解決はバックエンドが行う)。ここは UI の選択肢と
// 設定の検証だけを持つ。

export const AI_MODEL_IDS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
] as const;
export type AiModelId = (typeof AI_MODEL_IDS)[number];

/** グローバル既定モデル (かつ既定モデルプルダウンの「推奨」)。 */
export const DEFAULT_AI_MODEL: AiModelId = "claude-opus-5-5";

/** プルダウンに出す表示名 (製品名なので翻訳しない)。 */
export const AI_MODEL_LABELS: Record<AiModelId, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
};

export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export const AI_TASK_KINDS = ["connectionTest", "generic"] as const;
export type AiTaskKind = (typeof AI_TASK_KINDS)[number];

/**
 * タスク種別ごとの定義表 (推奨モデル / 推奨エフォートの単一ソース)。後続 Issue が
 * タスク種別を足すときは、`AI_TASK_KINDS` と Rust の `AiTaskKind` / `recommended_*` と
 * 一緒にここへ登録する (Record なので登録漏れは型エラーになる)。
 */
export const AI_TASK_DEFS: Record<
  AiTaskKind,
  { recommendedModel: AiModelId; recommendedEffort: AiEffort }
> = {
  connectionTest: { recommendedModel: "claude-opus-5-5", recommendedEffort: "low" },
  generic: { recommendedModel: "claude-opus-5-5", recommendedEffort: "medium" },
};

export interface AiSelectOption<V extends string> {
  value: V;
  label: string;
  recommended: boolean;
}

/** 推奨の選択肢の表示名の末尾に付ける。接尾辞は i18n を通して呼び出し側が渡す。 */
function withSuffix(label: string, recommended: boolean, suffix: string): string {
  return recommended ? `${label} ${suffix}` : label;
}

/**
 * モデルのプルダウン選択肢。`kind` が `null` のときはグローバル既定モデル用
 * (推奨は `DEFAULT_AI_MODEL`)、タスク種別を渡すとそのタスクの推奨モデルに付ける。
 * `recommendedSuffix` は「(推奨)」 / 「(recommended)」 (i18n の `aiRecommendedSuffix`)。
 */
export function modelOptions(
  kind: AiTaskKind | null,
  recommendedSuffix: string,
): AiSelectOption<AiModelId>[] {
  const recommendedId = kind === null ? DEFAULT_AI_MODEL : AI_TASK_DEFS[kind].recommendedModel;
  return AI_MODEL_IDS.map((value) => {
    const recommended = value === recommendedId;
    return {
      value,
      recommended,
      label: withSuffix(AI_MODEL_LABELS[value], recommended, recommendedSuffix),
    };
  });
}

/**
 * エフォートのプルダウン選択肢。`effortLabel` は段階ごとの表示名 (i18n)。
 * そのタスク種別の推奨エフォートに「(推奨)」を付ける。
 */
export function effortOptions(
  kind: AiTaskKind,
  recommendedSuffix: string,
  effortLabel: (effort: AiEffort) => string,
): AiSelectOption<AiEffort>[] {
  const recommendedId = AI_TASK_DEFS[kind].recommendedEffort;
  return AI_EFFORTS.map((value) => {
    const recommended = value === recommendedId;
    return {
      value,
      recommended,
      label: withSuffix(effortLabel(value), recommended, recommendedSuffix),
    };
  });
}

export function isAiModelId(v: unknown): v is AiModelId {
  return typeof v === "string" && (AI_MODEL_IDS as readonly string[]).includes(v);
}

export function isAiEffort(v: unknown): v is AiEffort {
  return typeof v === "string" && (AI_EFFORTS as readonly string[]).includes(v);
}
