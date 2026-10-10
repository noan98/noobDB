// AI 基盤 (#690) の設定 (`Settings.ai`)。永続化は `settings.ts` の既存パターンに従う。
// API キーはここには持たない (OS keyring のみ。`api.setAiApiKey` / `api.hasAiApiKey`)。

import {
  AI_TASK_KINDS,
  DEFAULT_AI_MODEL,
  isAiEffort,
  isAiModelId,
  type AiEffort,
  type AiModelId,
  type AiTaskKind,
} from "./aiModels";

/** プロンプトに含めてよい情報の範囲。 */
export const AI_SEND_SCOPES = ["schemaOnly", "schemaAndSql"] as const;
export type AiSendScope = (typeof AI_SEND_SCOPES)[number];

export interface AiSettings {
  /** AI 機能の有効化。既定オフの明示オプトイン。 */
  enabled: boolean;
  /** 初回有効化時の送信同意ダイアログに同意済みか。 */
  consentGiven: boolean;
  defaultModel: AiModelId;
  /** タスク種別ごとのモデル上書き。`null` = 既定モデルに従う。 */
  taskModels: Record<AiTaskKind, AiModelId | null>;
  /** タスク種別ごとのエフォート。`null` = 推奨エフォート。 */
  taskEfforts: Record<AiTaskKind, AiEffort | null>;
  sendScope: AiSendScope;
  /** 行データ (セルの値) を送ってよいか。既定は送らない。 */
  allowRowData: boolean;
  /** SQL 内の文字列リテラルをマスクして送る (#692)。既定オン。 */
  maskLiterals: boolean;
}

function nullRecord<V>(): Record<AiTaskKind, V | null> {
  return Object.fromEntries(AI_TASK_KINDS.map((k) => [k, null])) as Record<AiTaskKind, V | null>;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  consentGiven: false,
  defaultModel: DEFAULT_AI_MODEL,
  taskModels: nullRecord<AiModelId>(),
  taskEfforts: nullRecord<AiEffort>(),
  sendScope: "schemaOnly",
  allowRowData: false,
  maskLiterals: true,
};

function sanitizeRecord<V>(
  input: unknown,
  valid: (v: unknown) => v is V,
): Record<AiTaskKind, V | null> {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out = nullRecord<V>();
  for (const k of AI_TASK_KINDS) {
    const v = src[k];
    out[k] = valid(v) ? v : null;
  }
  return out;
}

/** 保存値 / インポート値 (形が不明) を、常に有効な `AiSettings` へ丸める。 */
export function sanitizeAiSettings(input: unknown): AiSettings {
  if (!input || typeof input !== "object") return structuredCloneSettings(DEFAULT_AI_SETTINGS);
  const p = input as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    consentGiven: p.consentGiven === true,
    defaultModel: isAiModelId(p.defaultModel) ? p.defaultModel : DEFAULT_AI_MODEL,
    taskModels: sanitizeRecord(p.taskModels, isAiModelId),
    taskEfforts: sanitizeRecord(p.taskEfforts, isAiEffort),
    sendScope: (AI_SEND_SCOPES as readonly string[]).includes(p.sendScope as string)
      ? (p.sendScope as AiSendScope)
      : "schemaOnly",
    allowRowData: p.allowRowData === true,
    // 未保存 (旧設定) はオン。明示的に false のときだけオフ。
    maskLiterals: p.maskLiterals !== false,
  };
}

function structuredCloneSettings(s: AiSettings): AiSettings {
  return { ...s, taskModels: { ...s.taskModels }, taskEfforts: { ...s.taskEfforts } };
}

/**
 * IPC に渡す設定スナップショット。Rust 側 `AiSettingsSnapshot` と同形。
 * 送信範囲 (`sendScope` / `allowRowData`) はプロンプトを組み立てるフロントの責務なので
 * ここには含めない。
 */
export interface AiSettingsSnapshot {
  enabled: boolean;
  defaultModel: AiModelId;
  taskModels: Record<AiTaskKind, AiModelId | null>;
  taskEfforts: Record<AiTaskKind, AiEffort | null>;
}

export function toAiSnapshot(ai: AiSettings): AiSettingsSnapshot {
  return {
    enabled: ai.enabled,
    defaultModel: ai.defaultModel,
    taskModels: { ...ai.taskModels },
    taskEfforts: { ...ai.taskEfforts },
  };
}
