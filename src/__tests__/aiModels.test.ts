import { describe, expect, it } from "vitest";
import {
  AI_EFFORTS,
  AI_MODEL_IDS,
  AI_TASK_DEFS,
  AI_TASK_KINDS,
  DEFAULT_AI_MODEL,
  effortOptions,
  modelOptions,
} from "../ai/aiModels";
import {
  DEFAULT_AI_SETTINGS,
  sanitizeAiSettings,
  toAiSnapshot,
} from "../ai/aiSettings";
import { connectionTestView } from "../ai/connectionTest";
import { normalizeSettings } from "../settings";

const SUFFIX = "(推奨)";

describe("AI モデル / エフォートのプルダウン (#690)", () => {
  it("既定モデル用は claude-opus-5-5 にだけ (推奨) が付く", () => {
    const opts = modelOptions(null, SUFFIX);
    expect(opts.map((o) => o.value)).toEqual([...AI_MODEL_IDS]);
    const recommended = opts.filter((o) => o.recommended);
    expect(recommended.map((o) => o.value)).toEqual([DEFAULT_AI_MODEL]);
    expect(DEFAULT_AI_MODEL).toBe("claude-opus-5-5");
    for (const o of opts) {
      expect(o.label.endsWith(SUFFIX)).toBe(o.recommended);
    }
  });

  it("タスク種別ごとの上書きは、そのタスクの推奨モデルの末尾に (推奨) が付く", () => {
    for (const kind of AI_TASK_KINDS) {
      const opts = modelOptions(kind, SUFFIX);
      const labelled = opts.filter((o) => o.label.endsWith(SUFFIX));
      expect(labelled.map((o) => o.value)).toEqual([AI_TASK_DEFS[kind].recommendedModel]);
    }
    // インライン補完 (#1479) だけは入力のたびに呼ぶため軽量モデルを推奨する。
    expect(AI_TASK_DEFS.inlineComplete.recommendedModel).toBe("claude-haiku-5-5");
    expect(AI_TASK_DEFS.nl2sql.recommendedModel).toBe("claude-opus-5-5");
  });

  it("エフォートは connectionTest=low / generic=medium に (推奨) が付く", () => {
    const label = (e: string) => e.toUpperCase();
    expect(AI_TASK_DEFS.connectionTest.recommendedEffort).toBe("low");
    expect(AI_TASK_DEFS.generic.recommendedEffort).toBe("medium");
    for (const kind of AI_TASK_KINDS) {
      const opts = effortOptions(kind, SUFFIX, label);
      expect(opts.map((o) => o.value)).toEqual([...AI_EFFORTS]);
      const labelled = opts.filter((o) => o.label.endsWith(SUFFIX));
      expect(labelled.map((o) => o.value)).toEqual([AI_TASK_DEFS[kind].recommendedEffort]);
    }
    expect(effortOptions("generic", SUFFIX, label).find((o) => o.value === "medium")?.label).toBe(
      `MEDIUM ${SUFFIX}`,
    );
  });

  it("接尾辞は呼び出し側 (i18n) が決める", () => {
    expect(modelOptions(null, "(recommended)")[0].label).toBe("Claude Opus 5.5 (recommended)");
  });
});

describe("AI 設定の正規化 (#690)", () => {
  it("既定はオフ・行データ送信なし・スキーマのみ", () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AI_SETTINGS.allowRowData).toBe(false);
    expect(DEFAULT_AI_SETTINGS.sendScope).toBe("schemaOnly");
    expect(DEFAULT_AI_SETTINGS.defaultModel).toBe("claude-opus-5-5");
    expect(DEFAULT_AI_SETTINGS.maskLiterals).toBe(true);
    for (const k of AI_TASK_KINDS) {
      expect(DEFAULT_AI_SETTINGS.taskModels[k]).toBeNull();
      expect(DEFAULT_AI_SETTINGS.taskEfforts[k]).toBeNull();
    }
  });

  it("不正値は既定へ丸める", () => {
    const s = sanitizeAiSettings({
      enabled: "yes",
      defaultModel: "gpt-x",
      taskModels: { connectionTest: "claude-haiku-5-5", generic: "nope", extra: "claude-opus-5-5" },
      taskEfforts: { connectionTest: "ultra", generic: "max" },
      sendScope: "everything",
      allowRowData: 1,
    });
    expect(s.enabled).toBe(false);
    expect(s.defaultModel).toBe("claude-opus-5-5");
    expect(s.taskModels.connectionTest).toBe("claude-haiku-5-5");
    expect(s.taskModels.generic).toBeNull();
    expect(s.taskEfforts.connectionTest).toBeNull();
    expect(s.taskEfforts.generic).toBe("max");
    expect(s.sendScope).toBe("schemaOnly");
    expect(s.allowRowData).toBe(false);
    expect(s.maskLiterals).toBe(true);
    expect(sanitizeAiSettings({ maskLiterals: false }).maskLiterals).toBe(false);
  });

  it("有効な値は保たれ、Settings 全体の normalize も通る", () => {
    const s = normalizeSettings({
      ai: { enabled: true, consentGiven: true, defaultModel: "claude-fable-5-1", sendScope: "schemaAndSql" },
    });
    expect(s.ai.enabled).toBe(true);
    expect(s.ai.consentGiven).toBe(true);
    expect(s.ai.defaultModel).toBe("claude-fable-5-1");
    expect(s.ai.sendScope).toBe("schemaAndSql");
    expect(normalizeSettings({}).ai).toEqual(DEFAULT_AI_SETTINGS);
  });

  it("スナップショットはモデル ID を含まず、送信範囲も含まない", () => {
    const snap = toAiSnapshot({ ...DEFAULT_AI_SETTINGS, enabled: true });
    expect(Object.keys(snap).sort()).toEqual(["defaultModel", "enabled", "taskEfforts", "taskModels"]);
  });
});

describe("接続テスト結果の表示 (#690)", () => {
  const base = { model: null, elapsedMs: 5 };
  it("認証 / ネットワーク / 成功 / その他を区別する", () => {
    expect(connectionTestView({ ...base, status: "success", message: "ok", model: "m" }).tone).toBe("success");
    expect(connectionTestView({ ...base, status: "authError", message: "x" })).toMatchObject({
      tone: "danger",
      key: "aiTestAuthError",
    });
    expect(connectionTestView({ ...base, status: "networkError", message: "x" })).toMatchObject({
      tone: "warning",
      key: "aiTestNetworkError",
    });
    expect(connectionTestView({ ...base, status: "apiError", message: "x" }).key).toBe("aiTestApiError");
    expect(connectionTestView({ ...base, status: "refused", message: "x" }).key).toBe("aiTestRefused");
  });
});
