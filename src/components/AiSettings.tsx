import { useEffect, useState, type ReactNode } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type AiConnectionTestResult } from "../api/tauri";
import {
  AI_TASK_DEFS,
  AI_TASK_KINDS,
  effortOptions,
  isAiEffort,
  isAiModelId,
  modelOptions,
  type AiEffort,
  type AiTaskKind,
} from "../ai/aiModels";
import { AI_SEND_SCOPES, toAiSnapshot, type AiSendScope } from "../ai/aiSettings";
import { connectionTestView } from "../ai/connectionTest";
import { useT, type I18nKey } from "../i18n";
import { setAiKeyPresent } from "../ai/aiKeyStore";
import { useAiStream } from "../ai/useAiStream";
import {
  setAiAllowRowData,
  setAiDefaultModel,
  giveAiConsent,
  setAiEnabled,
  setAiMaskLiterals,
  setAiSendScope,
  setAiTaskEffort,
  setAiTaskModel,
  useSettings,
} from "../settings";
import { AiStreamProgress } from "./AiStreamProgress";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { SettingsInfo, SettingsLabelWithInfo } from "./settingsLayout";
import { Button, Input, Select, Switch } from "./ui";
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
  | { kind: "done"; info: string; fallback: string | null }
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
        onDone: ({ event: e }) =>
          setSample({
            kind: "done",
            info: t("aiSampleDone", {
              model: e.model,
              input: e.usage.inputTokens,
              output: e.usage.outputTokens,
            }),
            fallback: e.fallbackUsed
              ? t("aiSampleFallback", { model: e.model, requested: e.requestedModel })
              : null,
          }),
        onError: (f) => setSample({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setSample({ kind: "cancelled" }),
      },
    );
  };

  const usable = ai.enabled && hasKey;
  const sampleRunning = sample.kind === "running";
  const view = testResult ? connectionTestView(testResult) : null;

  return (
    <Flex direction="column" gap="3" px="2">
      <chakra.label
        htmlFor="settings-ai-enabled"
        display="inline-flex"
        alignItems="center"
        gap="2"
        fontSize="md"
        fontWeight={500}
        color="app.text"
      >
        <Switch
          id="settings-ai-enabled"
          checked={ai.enabled}
          onChange={(checked) => {
            void handleToggle(checked);
          }}
        />
        {t("aiEnable")}
      </chakra.label>
      <chakra.span fontSize="sm" color="app.textMuted">
        {t("aiEnableHelp")}
      </chakra.span>

      <FormSection>
        <SettingsLabelWithInfo>
          <FieldLabel htmlFor="settings-ai-key">{t("aiApiKeyLabel")}</FieldLabel>
          <SettingsInfo>{t("aiApiKeyHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Flex align="center" gap="2" wrap="wrap">
          <chakra.span
            fontSize="sm"
            fontWeight={500}
            color={hasKey ? "app.textSuccess" : "app.textMuted"}
          >
            {hasKey ? t("aiApiKeyConfigured") : t("aiApiKeyNotConfigured")}
          </chakra.span>
          <Input
            id="settings-ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("aiApiKeyPlaceholder")}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            width="auto"
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
              variant="secondary"
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
      </FormSection>

      <FormSection>
        <SettingsLabelWithInfo>
          <FieldLabel htmlFor="settings-ai-default-model">{t("aiDefaultModel")}</FieldLabel>
          <SettingsInfo>{t("aiDefaultModelHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Select
          id="settings-ai-default-model"
          width="auto"
          value={ai.defaultModel}
          onChange={(e) => {
            if (isAiModelId(e.target.value)) setAiDefaultModel(e.target.value);
          }}
        >
          {modelOptions(null, suffix).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FormSection>

      <FormSection>
        <SettingsLabelWithInfo>
          <FieldLabel as="div">{t("aiTaskModels")}</FieldLabel>
          <SettingsInfo>{t("aiTaskModelsHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
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
                <Select
                  aria-label={`${t(TASK_LABEL[kind])} - ${t("aiColModel")}`}
                  value={ai.taskModels[kind] ?? ""}
                  onChange={(e) =>
                    setAiTaskModel(kind, isAiModelId(e.target.value) ? e.target.value : null)
                  }
                >
                  <option value="">{t("aiModelFollowDefault")}</option>
                  {modelOptions(kind, suffix).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={`${t(TASK_LABEL[kind])} - ${t("aiColEffort")}`}
                  value={effort}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!isAiEffort(v)) return;
                    // 推奨値を選んだら「推奨に従う (null)」として保存する。
                    setAiTaskEffort(kind, v === AI_TASK_DEFS[kind].recommendedEffort ? null : v);
                  }}
                >
                  {effortOptions(kind, suffix, (eff) => t(EFFORT_LABEL[eff])).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </TaskRow>
            );
          })}
        </chakra.div>
      </FormSection>

      <FormSection>
        <SettingsLabelWithInfo>
          <FieldLabel htmlFor="settings-ai-send-scope">{t("aiSendScope")}</FieldLabel>
          <SettingsInfo>{t("aiSendScopeHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <Select
          id="settings-ai-send-scope"
          width="auto"
          value={ai.sendScope}
          onChange={(e) => {
            const v = e.target.value as AiSendScope;
            if ((AI_SEND_SCOPES as readonly string[]).includes(v)) setAiSendScope(v);
          }}
        >
          {AI_SEND_SCOPES.map((s) => (
            <option key={s} value={s}>
              {t(SEND_SCOPE_LABEL[s])}
            </option>
          ))}
        </Select>
        <SettingsLabelWithInfo>
          <chakra.label
            htmlFor="settings-ai-allow-row-data"
            display="inline-flex"
            alignItems="center"
            gap="2"
            fontSize="md"
            fontWeight={500}
            color="app.text"
          >
            <Switch
              id="settings-ai-allow-row-data"
              checked={ai.allowRowData}
              onChange={setAiAllowRowData}
            />
            {t("aiAllowRowData")}
          </chakra.label>
          <SettingsInfo>{t("aiAllowRowDataHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
        <SettingsLabelWithInfo>
          <chakra.label
            htmlFor="settings-ai-mask-literals"
            display="inline-flex"
            alignItems="center"
            gap="2"
            fontSize="md"
            fontWeight={500}
            color="app.text"
          >
            <Switch
              id="settings-ai-mask-literals"
              checked={ai.maskLiterals}
              onChange={setAiMaskLiterals}
            />
            {t("aiMaskLiterals")}
          </chakra.label>
          <SettingsInfo>{t("aiMaskLiteralsHelp")}</SettingsInfo>
        </SettingsLabelWithInfo>
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
          {sample.info}
          {sample.fallback ? ` ${sample.fallback}` : ""}
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
