import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, listenAiStream, type AiConnectionTestResult } from "../api/tauri";
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
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
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

let sampleSeq = 0;
function makeSampleStreamId(): string {
  sampleSeq += 1;
  return `ai_${Date.now().toString(36)}_${sampleSeq.toString(36)}`;
}

type SampleState =
  | { kind: "idle" }
  | { kind: "running"; text: string }
  | { kind: "done"; text: string; info: string; fallback: string | null }
  | { kind: "error"; text: string; message: string; refused: boolean }
  | { kind: "cancelled"; text: string };

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
  const sampleStreamRef = useRef<string | null>(null);
  const sampleUnlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);

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

  const stopSampleListener = useCallback(() => {
    sampleUnlistenRef.current?.();
    sampleUnlistenRef.current = null;
    sampleStreamRef.current = null;
  }, []);

  // 画面を閉じたら実行中のサンプル要求を止める。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const sid = sampleStreamRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* すでに完了 */
        });
      }
      sampleUnlistenRef.current?.();
      sampleUnlistenRef.current = null;
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
    const streamId = makeSampleStreamId();
    sampleStreamRef.current = streamId;
    let text = "";
    setSample({ kind: "running", text });
    try {
      // 購読してから開始する (最初の delta を取りこぼさない)。
      const unlisten = await listenAiStream(streamId, {
        onDelta: (e) => {
          text += e.text;
          setSample({ kind: "running", text });
        },
        onDone: (e) => {
          stopSampleListener();
          setSample({
            kind: "done",
            text,
            info: t("aiSampleDone", {
              model: e.model,
              input: e.usage.inputTokens,
              output: e.usage.outputTokens,
            }),
            fallback: e.fallbackUsed
              ? t("aiSampleFallback", { model: e.model, requested: e.requestedModel })
              : null,
          });
        },
        onError: (e) => {
          stopSampleListener();
          setSample({ kind: "error", text, message: e.error, refused: e.kind === "aiRefused" });
        },
        onCancelled: () => {
          stopSampleListener();
          setSample({ kind: "cancelled", text });
        },
      });
      // 購読の確立中にアンマウントされると、cleanup の cancelStream は登録前に走って空振りし
      // リスナーが残る。確立後に確認して、残っていれば外して要求を出さない。
      if (!mountedRef.current) {
        unlisten();
        sampleStreamRef.current = null;
        return;
      }
      sampleUnlistenRef.current = unlisten;
      await api.runAiRequest({
        streamId,
        task: "generic",
        prompt: t("aiSamplePrompt"),
        settings: toAiSnapshot(ai),
      });
    } catch (e) {
      stopSampleListener();
      setSample({ kind: "error", text, message: String(e), refused: false });
    }
  };

  const cancelSample = () => {
    const sid = sampleStreamRef.current;
    if (sid) {
      void api.cancelStream(sid).catch(() => {
        /* すでに完了 */
      });
    }
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
        <FieldLabel htmlFor="settings-ai-key">{t("aiApiKeyLabel")}</FieldLabel>
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
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiApiKeyHelp")}
        </chakra.span>
      </FormSection>

      <FormSection>
        <FieldLabel htmlFor="settings-ai-default-model">{t("aiDefaultModel")}</FieldLabel>
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
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiDefaultModelHelp")}
        </chakra.span>
      </FormSection>

      <FormSection>
        <FieldLabel as="div">{t("aiTaskModels")}</FieldLabel>
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
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiTaskModelsHelp")}
        </chakra.span>
      </FormSection>

      <FormSection>
        <FieldLabel htmlFor="settings-ai-send-scope">{t("aiSendScope")}</FieldLabel>
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
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiSendScopeHelp")}
        </chakra.span>
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
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiAllowRowDataHelp")}
        </chakra.span>
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
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiMaskLiteralsHelp")}
        </chakra.span>
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
          <Button type="button" variant="secondary" size="sm" onClick={cancelSample}>
            {t("aiSampleCancel")}
          </Button>
        )}
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiSampleRequestHelp")}
        </chakra.span>
      </Flex>
      {sample.kind !== "idle" && sample.text !== "" && (
        <chakra.div
          whiteSpace="pre-wrap"
          fontSize="sm"
          color="app.text"
          aria-live="polite"
          data-testid="ai-sample-text"
        >
          {sample.text}
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
