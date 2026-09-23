import { useEffect, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenScriptStream,
  type ScriptDoneEvent,
  type ScriptErrorEvent,
  type ScriptOptions,
  type ScriptProgressEvent,
} from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { transitions, variants } from "../motion";
import {
  classifyScriptDone,
  DEFAULT_SCRIPT_OPTIONS,
  describeScriptError,
  makeScriptStreamId,
  omittedFailureCount,
  scriptProgressPercent,
  toggleScriptOption,
} from "../scriptRun";
import { useConfirm } from "./ConfirmDialog";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { StreamProgressBar } from "./StreamProgressBar";
import { useToast } from "./Toast";
import { Button, Input, Switch } from "./ui";

interface Props {
  sessionId: string;
  /** 実行時の既定 DB コンテキスト (サイドバーで右クリックした DB)。 */
  database: string | null;
  /** 本番マークの接続なら実行前に確認を挟む (UI レベルの誤操作防止のみ)。 */
  isProduction: boolean;
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; event: ScriptDoneEvent }
  | { kind: "error"; event: ScriptErrorEvent }
  | { kind: "setupError"; message: string };

const OPTION_ROWS: { key: keyof ScriptOptions; label: I18nKey; hint: I18nKey }[] = [
  { key: "continueOnError", label: "scriptOptContinue", hint: "scriptOptContinueHint" },
  { key: "wrapInTransaction", label: "scriptOptWrap", hint: "scriptOptWrapHint" },
];

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * `.sql` スクリプトファイルのストリーミング実行モーダル (#973)。「開いて、決めて、
 * 閉じる」一時操作なので Modal に置く。ファイル選択はダイアログ (`dialog:allow-open`)
 * でパスを得るだけで、読み込み・分割・実行はすべて Rust の `run_sql_script` が行う
 * (capabilities を増やさない)。
 */
export function ScriptRunModal({ sessionId, database, isProduction, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [path, setPath] = useState("");
  const [options, setOptions] = useState<ScriptOptions>(DEFAULT_SCRIPT_OPTIONS);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [progress, setProgress] = useState<ScriptProgressEvent | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // 実行中にアンマウントされたら購読を外し、バックエンドのストリームも止める。
  useEffect(
    () => () => {
      const sid = streamIdRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* already finished */
        });
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
      streamIdRef.current = null;
    },
    [],
  );

  const isRunning = status.kind === "running";

  const cleanupStream = () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamIdRef.current = null;
  };

  const handleBrowse = async () => {
    const selected = await open({
      multiple: false,
      title: t("scriptPickFileTitle"),
      filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
    });
    if (typeof selected === "string" && selected) setPath(selected);
  };

  const handleRun = async () => {
    const target = path.trim();
    if (!target) return;
    if (isProduction) {
      const ok = await confirm({
        title: t("scriptProductionConfirmTitle"),
        message: t("scriptProductionConfirmMessage", { file: basename(target) }),
        confirmLabel: t("scriptProductionConfirmOk"),
        tone: "warning",
      });
      if (!ok) return;
    }
    const streamId = makeScriptStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "running" });
    setProgress(null);
    try {
      // 購読してから開始する (初回の進捗イベントを取りこぼさない)。
      unlistenRef.current = await listenScriptStream(streamId, {
        onProgress: (e) => setProgress(e),
        onDone: (e) => {
          cleanupStream();
          setStatus({ kind: "done", event: e });
          setProgress(null);
          if (classifyScriptDone(e) === "success") {
            toast.success(
              t("scriptDone", {
                executed: e.executed,
                secs: (e.elapsedMs / 1000).toFixed(1),
                rows: e.rowsAffected,
              }),
            );
          } else {
            toast.error(t("scriptDonePartial", { executed: e.executed, failed: e.failedCount }));
          }
        },
        onError: (e) => {
          cleanupStream();
          setStatus({ kind: "error", event: e });
          setProgress(null);
          toast.error(t("scriptError", { error: describeScriptError(e).message }));
        },
        onCancelled: () => {
          cleanupStream();
          setStatus({ kind: "idle" });
          setProgress(null);
        },
      });
      await api.runSqlScript({ sessionId, streamId, database, path: target, options });
    } catch (e) {
      // 購読・開始 (入力検証) の失敗は終端イベントが来ないので、ここで UI を戻す。
      cleanupStream();
      setStatus({ kind: "setupError", message: String(e) });
      setProgress(null);
      toast.error(t("scriptError", { error: String(e) }));
    }
  };

  const handleCancelRun = async () => {
    const streamId = streamIdRef.current;
    if (!streamId) return;
    // 先に購読を外し、バックエンドの cancelled イベントと二重に処理しない
    // (Dump / Export と同じキャンセル手順)。確定済み文数は戻り値から読む。
    cleanupStream();
    setStatus({ kind: "idle" });
    setProgress(null);
    const res = await api.cancelStream(streamId).catch(() => null);
    toast.info(t("scriptCancelled", { count: res?.deliveredRows ?? 0 }));
  };

  const percent = progress ? scriptProgressPercent(progress) : null;

  return (
    <Modal onSubmit={handleRun} submitDisabled={isRunning || !path.trim()} width="640px" onClose={onClose} closeOnInteractOutside={!isRunning} closeOnEscape={!isRunning}>
      <ModalHeader onClose={onClose} closeLabel={t("scriptClose")} closeDisabled={isRunning}>
        {database ? t("scriptTitleDb", { database }) : t("scriptTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight="normal">
          {t("scriptNote")}
        </chakra.div>

        <FormSection>
          <FieldLabel htmlFor="script-path">{t("scriptFileLabel")}</FieldLabel>
          <PathRow>
            <Input
              id="script-path"
              flex="1"
              minW={0}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("scriptFilePlaceholder")}
              disabled={isRunning}
            />
            <Button type="button" onClick={handleBrowse} disabled={isRunning}>
              {t("scriptBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        <FormSection>
          <FieldLabel as="div">{t("scriptOptionsLabel")}</FieldLabel>
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            {OPTION_ROWS.map((row) => (
              <chakra.div key={row.key} display="flex" alignItems="flex-start" gap="2" py="1">
                <chakra.span mt="0.5" flex="none">
                  <Switch
                    checked={options[row.key]}
                    onChange={() => setOptions((prev) => toggleScriptOption(prev, row.key))}
                    disabled={isRunning}
                    size="sm"
                    aria-label={t(row.label)}
                  />
                </chakra.span>
                <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0}>
                  <chakra.span fontSize="md" color="app.text">
                    {t(row.label)}
                  </chakra.span>
                  <chakra.span fontSize="xs" color="app.textMuted" lineHeight="snug">
                    {t(row.hint)}
                  </chakra.span>
                </chakra.span>
              </chakra.div>
            ))}
          </chakra.div>
          <chakra.div fontSize="xs" color="app.textMuted" lineHeight="snug">
            {t("scriptSessionNote")}
          </chakra.div>
        </FormSection>

        <StreamProgressBar active={isRunning} />

        <AnimatePresence mode="wait" initial={false}>
          {isRunning && (
            <motion.div
              key="script-progress"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.div fontSize="sm" color="app.textMuted" display="flex" flexWrap="wrap" alignItems="center" gap="2">
                <chakra.span fontWeight={500} color="app.text">
                  {progress ? t("scriptProgress", { executed: progress.executed }) : t("scriptRunning")}
                </chakra.span>
                {progress && progress.failed > 0 && (
                  <chakra.span color="app.textError">{t("scriptProgressFailed", { failed: progress.failed })}</chakra.span>
                )}
                {percent != null && <chakra.span>{t("scriptProgressPercent", { percent })}</chakra.span>}
                {progress && (
                  <chakra.span opacity={0.8}>
                    {t("dumpProgressElapsed", { secs: (progress.elapsedMs / 1000).toFixed(1) })}
                  </chakra.span>
                )}
              </chakra.div>
            </motion.div>
          )}
          {status.kind === "done" && (
            <motion.div
              key="script-done"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <ScriptDoneSummary event={status.event} />
            </motion.div>
          )}
          {status.kind === "error" && (
            <motion.div
              key="script-error"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <ScriptErrorSummary event={status.event} />
            </motion.div>
          )}
          {status.kind === "setupError" && (
            <motion.div
              key="script-setup-error"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <ErrorNote>{t("scriptError", { error: status.message })}</ErrorNote>
            </motion.div>
          )}
        </AnimatePresence>
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {isRunning ? (
          <Button type="button" variant="secondary" onClick={handleCancelRun}>
            {t("scriptCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("scriptClose")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isRunning}
          onClick={handleRun}
          disabled={isRunning || !path.trim()}
        >
          {isRunning ? t("scriptRunning") : t("scriptExecute")}
        </LoadingButton>
      </ModalFooter>
      {dialog}
    </Modal>
  );
}

function ScriptDoneSummary({ event }: { event: ScriptDoneEvent }) {
  const t = useT();
  const partial = classifyScriptDone(event) === "partial";
  const omitted = omittedFailureCount(event);
  return (
    <chakra.div display="flex" flexDirection="column" gap="2" fontSize="sm">
      <chakra.div color={partial ? "app.textWarning" : "app.textSuccess"} fontWeight={500}>
        {partial
          ? t("scriptDonePartial", { executed: event.executed, failed: event.failedCount })
          : t("scriptDone", {
              executed: event.executed,
              secs: (event.elapsedMs / 1000).toFixed(1),
              rows: event.rowsAffected,
            })}
      </chakra.div>
      {event.skippedControl > 0 && (
        <chakra.div color="app.textMuted" fontSize="xs">
          {t("scriptDoneSkippedControl", { count: event.skippedControl })}
        </chakra.div>
      )}
      {event.failures.length > 0 && (
        <chakra.div display="flex" flexDirection="column" gap="1">
          <FieldLabel as="div">{t("scriptFailuresLabel")}</FieldLabel>
          <chakra.ul
            listStyleType="none"
            m="0"
            p="0"
            maxH="220px"
            overflowY="auto"
            borderWidth="1px"
            borderColor="app.border"
            borderRadius="md"
          >
            {event.failures.map((f) => (
              <chakra.li
                key={`${f.index}-${f.line}`}
                px="2.5"
                py="1.5"
                borderBottomWidth="1px"
                borderColor="app.border"
                display="flex"
                flexDirection="column"
                gap="0.5"
              >
                <chakra.span fontSize="xs" color="app.textError">
                  {t("scriptFailureLine", { line: f.line })} — {f.error}
                </chakra.span>
                <chakra.span fontSize="xs" color="app.textMuted" fontFamily="mono" wordBreak="break-all">
                  {f.sql}
                </chakra.span>
              </chakra.li>
            ))}
          </chakra.ul>
          {omitted > 0 && (
            <chakra.div fontSize="xs" color="app.textMuted">
              {t("scriptFailuresOmitted", { count: omitted })}
            </chakra.div>
          )}
        </chakra.div>
      )}
    </chakra.div>
  );
}

function ScriptErrorSummary({ event }: { event: ScriptErrorEvent }) {
  const t = useT();
  const d = describeScriptError(event);
  return (
    <ErrorNote>
      <chakra.div display="flex" flexDirection="column" gap="1">
        <chakra.span>
          {d.line != null
            ? t("scriptErrorAt", { line: d.line, error: d.message })
            : t("scriptError", { error: d.message })}
        </chakra.span>
        {d.sql && (
          <chakra.span fontFamily="mono" fontSize="xs" wordBreak="break-all">
            {d.sql}
          </chakra.span>
        )}
        {d.rolledBack && <chakra.span fontSize="xs">{t("scriptRolledBack")}</chakra.span>}
      </chakra.div>
    </ErrorNote>
  );
}
