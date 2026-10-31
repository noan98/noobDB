import { useEffect, useState, type ReactNode } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type AiConnectionTestResult } from "../api/tauri";
import {
  AI_MODEL_LABELS,
  AI_TASK_DEFS,
  AI_TASK_KINDS,
  effortOptions,
  isAiEffort,
  isAiModelId,
  modelOptions,
  unsetUsesRecommendedModel,
  type AiEffort,
  type AiTaskKind,
} from "../ai/aiModels";
import { AI_SEND_SCOPES, sanitizeMonthlyBudget, toAiSnapshot, type AiSendScope } from "../ai/aiSettings";
import { connectionTestView } from "../ai/connectionTest";
import { useT, type I18nKey } from "../i18n";
import { setAiKeyPresent } from "../ai/aiKeyStore";
import { useAiStream } from "../ai/useAiStream";
import {
  setAiAllowRowData,
  setAiDefaultModel,
  giveAiConsent,
  setAiEnabled,
  setAiHideSetupHint,
  setAiInlineComplete,
  setAiMonthlyBudget,
  setAiMaskLiterals,
  setAiSendScope,
  setAiTaskEffort,
  setAiTaskModel,
  useSettings,
} from "../settings";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageHistory } from "./AiUsageHistory";
import { AiUsageNote } from "./AiUsageNote";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import {
  SettingsInfo,
  SettingsLabelWithInfo,
  SettingsToggleLabel,
  SettingsToggleRow,
} from "./settingsLayout";
import { Icon, ICON_SIZES } from "./Icon";
import { Button, Input, Switch } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import { useToast } from "./Toast";

const TASK_LABEL: Record<AiTaskKind, I18nKey> = {
  connectionTest: "aiTaskConnectionTest",
  generic: "aiTaskGeneric",
  errorExplain: "aiTaskErrorExplain",
  nl2sql: "aiTaskNl2sql",
  explainInterpret: "aiTaskExplainInterpret",
  impactAnalysis: "aiTaskImpactAnalysis",
  sqlExplain: "aiTaskSqlExplain",
  sqlRewrite: "aiTaskSqlRewrite",
  schemaDoc: "aiTaskSchemaDoc",
  syncRisk: "aiTaskSyncRisk",
  testData: "aiTaskTestData",
  historySearch: "aiTaskHistorySearch",
  advisorExplain: "aiTaskAdvisorExplain",
  resultSummary: "aiTaskResultSummary",
  assertionSuggest: "aiTaskAssertionSuggest",
  lockDiagnose: "aiTaskLockDiagnose",
  inlineComplete: "aiTaskInlineComplete",
};

const EFFORT_LABEL: Record<AiEffort, I18nKey> = {
  low: "aiEffortLow",
  medium: "aiEffortMedium",
  high: "aiEffortHigh",
  xhigh: "aiEffortXhigh",
  max: "aiEffortMax",
};

const SEND_SCOPE_LABEL: Record<AiSendScope, I18nKey> = {
  schemaOnly: "aiSendScopeSchemaOnly",
  schemaAndSql: "aiSendScopeSchemaAndSql",
};

type SampleState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; fallback: boolean }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

/**
 * 設定画面「AI アシスタント」(#690) の中身。有効化 (初回は送信への明示同意)・API キー
 * (keyring のみ)・既定モデル / タスク別のモデルとエフォート・送信範囲・接続テストを扱う。
 * API キーの入力値は保存後に画面から消し、保存済みかどうかだけを表示する。
 */
export function AiSettings() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const ai = useSettings().ai;
  const suffix = t("aiRecommendedSuffix");

  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  // タスク別の詳細 (17 行 x モデル / エフォート) は既定では畳む。日常的に触る項目が埋もれないように。
  const [taskOpen, setTaskOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [sample, setSample] = useState<SampleState>({ kind: "idle" });
  // サンプル要求の本文 (`stream.text`) は完了 / 中止 / エラー後も次の要求まで残して表示する。
  const stream = useAiStream({ idPrefix: "ai" });

  useEffect(() => {
    let alive = true;
    api
      .hasAiApiKey()
      .then((v) => {
        if (alive) setHasKey(v);
        setAiKeyPresent(v);
      })
      .catch(() => {
        /* 未取得なら「未設定」表示のまま */
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleToggle = async (checked: boolean) => {
    // 初回の有効化だけ、Anthropic の API へ送信することへの明示同意を取る。
    if (checked && !ai.consentGiven) {
      const ok = await confirm({
        title: t("aiConsentTitle"),
        message: t("aiConsentBody"),
        confirmLabel: t("aiConsentConfirm"),
        tone: "warning",
      });
      if (!ok) return;
      giveAiConsent();
    }
    setAiEnabled(checked);
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setKeyBusy(true);
    try {
      await api.setAiApiKey(key);
      setHasKey(true);
      setAiKeyPresent(true);
      toast.success(t("aiApiKeySaved"));
    } catch (e) {
      toast.error(t("aiApiKeyError", { error: String(e) }));
    } finally {
      // 成否にかかわらず入力値は画面から消す。
      setKeyDraft("");
      setKeyBusy(false);
    }
  };

  const deleteKey = async () => {
    setKeyBusy(true);
    try {
      await api.setAiApiKey("");
      setHasKey(false);
      setAiKeyPresent(false);
      setTestResult(null);
      toast.success(t("aiApiKeyDeleted"));
    } catch (e) {
      toast.error(t("aiApiKeyError", { error: String(e) }));
    } finally {
      setKeyBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await api.testAiConnection(toAiSnapshot(ai)));
    } catch (e) {
      setTestError(t("aiTestFailed", { error: String(e) }));
    } finally {
      setTesting(false);
    }
  };

  // 後続 Issue の実機能が入るまでの最小の `run_ai_request` 呼び出し元。接続テスト
  // (非ストリーミング) とは別に、ストリーミング経路 (delta / done / error / cancel) を
  // 実際に通して確かめられるようにしている。
  const runSample = async () => {
    if (!stream.acquire()) return;
    setSample({ kind: "running" });
    await stream.start(
      {
        task: "generic",
        prompt: t("aiSamplePrompt"),
        settings: toAiSnapshot(ai),
      },
      {
        onDone: ({ event: e }) => setSample({ kind: "done", fallback: e.fallbackUsed }),
        onError: (f) => setSample({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setSample({ kind: "cancelled" }),
      },
    );
  };

  // 既定のまま使っていないタスクの数 (モデルかエフォートのどちらかを上書きしているもの)。
  const changedTasks = AI_TASK_KINDS.filter(
    (kind) => ai.taskModels[kind] !== null || ai.taskEfforts[kind] !== null,
  ).length;
  const usable = ai.enabled && hasKey;

  // 月次予算 (#1620) の入力。確定 (blur / Enter) で保存し、空・0・不正値は「上限なし」に戻す。
  const [budgetDraft, setBudgetDraft] = useState(
    ai.monthlyBudgetUsd === null ? "" : String(ai.monthlyBudgetUsd),
  );
  const commitBudget = () => {
    const raw = budgetDraft.trim();
    setAiMonthlyBudget(raw === "" ? null : Number(raw));
    const saved = raw === "" ? null : sanitizeMonthlyBudget(Number(raw));
    setBudgetDraft(saved === null ? "" : String(saved));
  };
  const sampleRunning = sample.kind === "running";
  const view = testResult ? connectionTestView(testResult) : null;

  return (
    <Flex direction="column" gap="2">
      <SettingsToggleRow>
        <SettingsToggleLabel htmlFor="settings-ai-enabled">{t("aiEnable")}</SettingsToggleLabel>
        <Switch
          id="settings-ai-enabled"
          checked={ai.enabled}
          onChange={(checked) => {
            void handleToggle(checked);
          }}
        />
      </SettingsToggleRow>
      <chakra.span fontSize="sm" color="app.textMuted">
        {t("aiEnableHelp")}
      </chakra.span>

      <SettingsToggleRow>
        <SettingsLabelWithInfo>
          <SettingsToggleLabel htmlFor="settings-ai-setup-hint">{t("aiHideSetupHint")}</SettingsToggleLabel>
          <SettingsInfo>{t("aiHideSetupHintHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Switch
          id="settings-ai-setup-hint"
          checked={!ai.hideSetupHint}
          onChange={(v) => setAiHideSetupHint(!v)}
        />
      </SettingsToggleRow>

      <Flex direction="column" gap="1.5">
        <SettingsLabelWithInfo>
          <SettingsToggleLabel htmlFor="settings-ai-key">{t("aiApiKeyLabel")}</SettingsToggleLabel>
          <SettingsInfo>{t("aiApiKeyHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Flex align="center" gap="2" wrap="wrap">
          <Input
            id="settings-ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("aiApiKeyPlaceholder")}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter で保存する。IME の変換確定の Enter は除く。
              if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              if (!keyBusy && keyDraft.trim() !== "") void saveKey();
            }}
            flex="1"
            minW="240px"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={keyBusy || keyDraft.trim() === ""}
            onClick={() => {
              void saveKey();
            }}
          >
            {t("aiApiKeySave")}
          </Button>
          {hasKey && (
            <Button
              type="button"
              variant="dangerOutline"
              size="sm"
              disabled={keyBusy}
              onClick={() => {
                void deleteKey();
              }}
            >
              {t("aiApiKeyDelete")}
            </Button>
          )}
        </Flex>
        <chakra.span fontSize="sm" fontWeight={500} color={hasKey ? "app.textSuccess" : "app.textMuted"}>
          {hasKey ? t("aiApiKeyConfigured") : t("aiApiKeyNotConfigured")}
        </chakra.span>
      </Flex>

      <SettingsToggleRow>
        <SettingsLabelWithInfo>
          <SettingsToggleLabel htmlFor="settings-ai-default-model">{t("aiDefaultModel")}</SettingsToggleLabel>
          <SettingsInfo>{t("aiDefaultModelHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <ListboxSelect
          id="settings-ai-default-model"
          value={ai.defaultModel}
          options={modelOptions(null, suffix).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => {
            if (isAiModelId(v)) setAiDefaultModel(v);
          }}
        />
      </SettingsToggleRow>

      <FormSection>
        <Flex align="center" gap="2" wrap="wrap">
          <chakra.button
            type="button"
            display="inline-flex"
            alignItems="center"
            gap="1"
            bg="transparent"
            border="none"
            p="0"
            cursor="pointer"
            color="app.text"
            aria-expanded={taskOpen}
            aria-controls="settings-ai-task-models"
            onClick={() => setTaskOpen((v) => !v)}
            _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
          >
            <Icon name={taskOpen ? "chevron-down" : "chevron-right"} size={ICON_SIZES.sm} />
            <FieldLabel as="span">{t("aiTaskModels")}</FieldLabel>
          </chakra.button>
          <SettingsInfo>{t("aiTaskModelsHelp")}</SettingsInfo>
          <chakra.span fontSize="sm" color="app.textMuted" data-testid="ai-task-models-summary">
            {changedTasks === 0
              ? t("aiTaskModelsAllDefault")
              : t("aiTaskModelsChanged", { count: changedTasks })}
          </chakra.span>
        </Flex>
        {taskOpen && (
          <div id="settings-ai-task-models">
            <chakra.div
              display="grid"
              gridTemplateColumns="140px minmax(0, 1fr) minmax(0, 1fr)"
              alignItems="center"
              gap="2"
              role="group"
              aria-label={t("aiTaskModels")}
            >
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("aiColTask")}
              </chakra.span>
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("aiColModel")}
              </chakra.span>
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("aiColEffort")}
              </chakra.span>
              {AI_TASK_KINDS.map((kind) => {
                const effort = ai.taskEfforts[kind] ?? AI_TASK_DEFS[kind].recommendedEffort;
                return (
                  <TaskRow key={kind} label={t(TASK_LABEL[kind])}>
                    <ListboxSelect
                      css={{ width: "100%" }}
                      ariaLabel={`${t(TASK_LABEL[kind])} - ${t("aiColModel")}`}
                      value={ai.taskModels[kind] ?? ""}
                      options={[
                        {
                          value: "",
                          label: unsetUsesRecommendedModel(kind)
                            ? t("aiModelFollowRecommended", {
                                model: AI_MODEL_LABELS[AI_TASK_DEFS[kind].recommendedModel],
                              })
                            : t("aiModelFollowDefault"),
                        },
                        ...modelOptions(kind, suffix).map((o) => ({ value: o.value, label: o.label })),
                      ]}
                      onChange={(v) => setAiTaskModel(kind, isAiModelId(v) ? v : null)}
                    />
                    <ListboxSelect
                      css={{ width: "100%" }}
                      ariaLabel={`${t(TASK_LABEL[kind])} - ${t("aiColEffort")}`}
                      value={effort}
                      options={effortOptions(kind, suffix, (eff) => t(EFFORT_LABEL[eff])).map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                      onChange={(v) => {
                        if (!isAiEffort(v)) return;
                        // 推奨値を選んだら「推奨に従う (null)」として保存する。
                        setAiTaskEffort(kind, v === AI_TASK_DEFS[kind].recommendedEffort ? null : v);
                      }}
                    />
                  </TaskRow>
                );
              })}
            </chakra.div>
          </div>
        )}
      </FormSection>

      <FormSection>
        <SettingsToggleRow>
          <SettingsLabelWithInfo>
            <SettingsToggleLabel htmlFor="settings-ai-send-scope">{t("aiSendScope")}</SettingsToggleLabel>
            <SettingsInfo>{t("aiSendScopeHelp")}</SettingsInfo>
          </SettingsLabelWithInfo>
          <ListboxSelect
            id="settings-ai-send-scope"
            value={ai.sendScope}
            options={AI_SEND_SCOPES.map((s) => ({ value: s, label: t(SEND_SCOPE_LABEL[s]) }))}
            onChange={(v) => {
              if ((AI_SEND_SCOPES as readonly string[]).includes(v)) setAiSendScope(v as AiSendScope);
            }}
          />
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsLabelWithInfo>
            <SettingsToggleLabel htmlFor="settings-ai-allow-row-data">
              {t("aiAllowRowData")}
            </SettingsToggleLabel>
            <SettingsInfo>{t("aiAllowRowDataHelp")}</SettingsInfo>
          </SettingsLabelWithInfo>
          <Switch id="settings-ai-allow-row-data" checked={ai.allowRowData} onChange={setAiAllowRowData} />
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsLabelWithInfo>
            <SettingsToggleLabel htmlFor="settings-ai-mask-literals">
              {t("aiMaskLiterals")}
            </SettingsToggleLabel>
            <SettingsInfo>{t("aiMaskLiteralsHelp")}</SettingsInfo>
          </SettingsLabelWithInfo>
          <Switch id="settings-ai-mask-literals" checked={ai.maskLiterals} onChange={setAiMaskLiterals} />
        </SettingsToggleRow>
        <SettingsToggleRow>
          <SettingsLabelWithInfo>
            <SettingsToggleLabel htmlFor="settings-ai-inline-complete">
              {t("aiInlineComplete")}
            </SettingsToggleLabel>
            <SettingsInfo>{t("aiInlineCompleteHelp")}</SettingsInfo>
          </SettingsLabelWithInfo>
          <Switch
            id="settings-ai-inline-complete"
            checked={ai.inlineComplete}
            onChange={setAiInlineComplete}
          />
        </SettingsToggleRow>
        {ai.inlineComplete && ai.sendScope !== "schemaAndSql" && (
          <Callout tone="info">{t("aiInlineCompleteNeedsScope")}</Callout>
        )}
      </FormSection>

      <FormSection>
        <SettingsToggleRow>
          <SettingsLabelWithInfo>
            <SettingsToggleLabel htmlFor="settings-ai-monthly-budget">
              {t("aiMonthlyBudget")}
            </SettingsToggleLabel>
            <SettingsInfo>{t("aiMonthlyBudgetHelp")}</SettingsInfo>
          </SettingsLabelWithInfo>
          <Input
            id="settings-ai-monthly-budget"
            type="number"
            min={0}
            step={1}
            width="auto"
            value={budgetDraft}
            placeholder={t("aiMonthlyBudgetPlaceholder")}
            onChange={(e) => setBudgetDraft(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </SettingsToggleRow>
      </FormSection>

      <Flex align="center" gap="2" wrap="wrap">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!usable || testing}
          onClick={() => {
            void runTest();
          }}
        >
          {testing ? t("aiTesting") : t("aiTestConnection")}
        </Button>
        {!usable && ai.enabled && (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("aiTestNeedsKey")}
          </chakra.span>
        )}
      </Flex>
      {view && (
        <Callout tone={view.tone} role={view.tone === "danger" ? "alert" : "status"}>
          {t(view.key, view.vars)}
        </Callout>
      )}
      {testError && <ErrorNote role="alert">{testError}</ErrorNote>}

      <Flex align="center" gap="2" wrap="wrap">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!usable || sampleRunning}
          onClick={() => {
            void runSample();
          }}
        >
          {t("aiSampleRequest")}
        </Button>
        {sampleRunning && (
          <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
            {t("aiSampleCancel")}
          </Button>
        )}
        <SettingsInfo>{t("aiSampleRequestHelp")}</SettingsInfo>
      </Flex>
      {sampleRunning && <AiStreamProgress stream={stream} previewText={false} />}
      {sample.kind !== "idle" && stream.text !== "" && (
        <chakra.div
          whiteSpace="pre-wrap"
          fontSize="sm"
          color="app.text"
          aria-live="polite"
          data-testid="ai-sample-text"
        >
          {stream.text}
        </chakra.div>
      )}
      {sample.kind === "done" && (
        <Callout tone={sample.fallback ? "warning" : "success"} role="status">
          <AiUsageNote event={stream.done} />
        </Callout>
      )}
      {sample.kind === "error" &&
        (sample.refused ? (
          <Callout tone="warning" role="alert">
            {t("aiSampleRefused", { message: sample.message })}
          </Callout>
        ) : (
          <ErrorNote role="alert">{t("aiSampleError", { message: sample.message })}</ErrorNote>
        ))}
      {sample.kind === "cancelled" && (
        <Callout tone="info" role="status">
          {t("aiSampleCancelled")}
        </Callout>
      )}
      <AiUsageHistory
        taskLabel={(task) =>
          (AI_TASK_KINDS as readonly string[]).includes(task) ? t(TASK_LABEL[task as AiTaskKind]) : task
        }
        reloadKey={`${sample.kind}:${testResult ? 1 : 0}`}
      />
      {dialog}
    </Flex>
  );
}

/** タスク種別 1 行 (ラベル + モデル + エフォートのプルダウン)。 */
function TaskRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <chakra.span fontSize="sm" color="app.text">
        {label}
      </chakra.span>
      {children}
    </>
  );
}
