import { useEffect, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenScriptStream,
  type ScriptAnalyzedEvent,
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
  isAnalysisStaleError,
  makeScriptStreamId,
  omittedFailureCount,
  parseStartAt,
  remainingDangerous,
  resumeFromBeginAt,
  resumeStartAt,
  scriptProgressPercent,
  setDangerousExcluded,
  skipList,
  startInsideTransaction,
  toggleExcluded,
  toggleScriptOption,
  type ScriptToggleKey,
} from "../scriptRun";
import { parseTextEncodingId, TEXT_ENCODING_OPTIONS } from "../sqlFileIO";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { ScriptAnalysisPanel } from "./ScriptAnalysisPanel";
import { StreamProgressBar } from "./StreamProgressBar";
import { useToast } from "./Toast";
import { Button, Input, Select, Switch } from "./ui";

/** 事前確認の結果と、それを取ったときの入力 (ファイル + 文字コード) のキー。 */
interface AnalysisResult {
  event: ScriptAnalyzedEvent;
  key: string;
}

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
  /** 事前確認 (ドライラン) の走査中 (#1535)。 */
  | { kind: "analyzing" }
  | { kind: "analysisError"; message: string }
  | { kind: "done"; event: ScriptDoneEvent }
  /** `runOptions` はその実行で実際に使ったオプション (再開の可否は画面の現在の設定ではなくこれで決める)。 */
  | { kind: "error"; event: ScriptErrorEvent; runOptions: ScriptOptions }
  | { kind: "setupError"; message: string };

const OPTION_ROWS: { key: ScriptToggleKey; label: I18nKey; hint: I18nKey }[] = [
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
  /** 開始文番号の入力欄の文字列 (空 = 先頭から)。 */
  const [startAtText, setStartAtText] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [progress, setProgress] = useState<ScriptProgressEvent | null>(null);
  /** 事前確認 (ドライラン) の結果と、それを取ったときの入力 (ファイル + 文字コード)。 */
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  /** 事前確認の一覧で「実行しない」にした文の通し番号。 */
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const analysisRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  /** 走査中の事前確認の完了待ち (キャンセル・アンマウントで `null` を返して待ちを解く)。 */
  const pendingAnalysisRef = useRef<((r: AnalysisResult | null) => void) | null>(null);

  // 実行中にアンマウントされたら購読を外し、バックエンドのストリームも止める。
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const sid = streamIdRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* already finished */
        });
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
      streamIdRef.current = null;
      pendingAnalysisRef.current?.(null);
    };
  }, []);

  // 結果 (完了・エラー・再開ボタン) はオプションの下に出るので、見える位置へスクロールする。
  useEffect(() => {
    if (status.kind === "done" || status.kind === "error" || status.kind === "analysisError" || status.kind === "setupError") {
      // フェードインで高さが確定してからスクロールする。
      const timer = window.setTimeout(() => statusRef.current?.scrollIntoView?.({ block: "end" }), 250);
      return () => window.clearTimeout(timer);
    }
  }, [status.kind]);

  const isRunning = status.kind === "running";
  const isAnalyzing = status.kind === "analyzing";
  const busy = isRunning || isAnalyzing;
  const inputKey = `${path.trim()}\n${options.encoding ?? ""}`;
  // 事前確認の結果は、取ったときと同じファイル・文字コードのときだけ実行に反映する。
  const analysisFresh = analysis !== null && analysis.key === inputKey;

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

  /**
   * 実行せずにファイルを走査して、文数・危険文・先頭の文の一覧を出す (#1535)。失敗・キャンセル
   * なら `null`。実行ボタンからの自動確認 (`scroll = false`) でも同じ経路を使う。
   */
  const analyzeNow = (scroll: boolean): Promise<AnalysisResult | null> =>
    new Promise((resolve) => {
      const target = path.trim();
      const streamId = makeScriptStreamId();
      streamIdRef.current = streamId;
      const key = inputKey;
      const finish = (r: AnalysisResult | null) => {
        pendingAnalysisRef.current = null;
        resolve(r);
      };
      pendingAnalysisRef.current = finish;
      setStatus({ kind: "analyzing" });
      setProgress(null);
      setAnalysis(null);
      setExcluded(new Set());
      void (async () => {
        try {
          const unlisten = await listenScriptStream(streamId, {
            onProgress: (e) => setProgress(e),
            onAnalyzed: (e) => {
              cleanupStream();
              const result = { event: e, key };
              setAnalysis(result);
              setStatus({ kind: "idle" });
              setProgress(null);
              // 結果は折りたたみの下に出るので、見える位置へスクロールする。
              if (scroll) requestAnimationFrame(() => analysisRef.current?.scrollIntoView?.({ block: "start" }));
              finish(result);
            },
            onError: (e) => {
              cleanupStream();
              setStatus({ kind: "analysisError", message: describeScriptError(e).message });
              setProgress(null);
              finish(null);
            },
            onCancelled: () => {
              cleanupStream();
              setStatus({ kind: "idle" });
              setProgress(null);
              finish(null);
            },
          });
          if (unmountedRef.current || streamIdRef.current !== streamId) {
            unlisten();
            finish(null);
            return;
          }
          unlistenRef.current = unlisten;
          await api.analyzeSqlScript({ sessionId, streamId, path: target, encoding: options.encoding });
        } catch (e) {
          cleanupStream();
          setStatus({ kind: "analysisError", message: String(e) });
          setProgress(null);
          finish(null);
        }
      })();
    });

  const handleAnalyze = async () => {
    if (!path.trim() || busy) return;
    await analyzeNow(true);
  };

  /** `override` は再開位置など、状態を介さずに今回だけ差し替えるオプション。 */
  const handleRun = async (override?: Partial<ScriptOptions>) => {
    const target = path.trim();
    if (!target || busy) return;
    const startAt = override?.startAtStatement ?? parseStartAt(startAtText);
    // 新しい事前確認が無ければ、実行の前に自動で走らせる (危険文の確認を飛ばさせない)。
    const checked: AnalysisResult | null = analysisFresh ? analysis : await analyzeNow(false);
    if (!checked) return;
    if (unmountedRef.current) return;
    const skip = analysisFresh ? excluded : new Set<number>();
    {
      const dangerous = remainingDangerous(checked.event.analysis, skip, startAt);
      if (dangerous > 0) {
        const ok = await confirm({
          title: t("scriptDangerConfirmTitle"),
          message: t("scriptDangerConfirmMessage", { count: dangerous.toLocaleString() }),
          confirmLabel: t("scriptDangerConfirmOk"),
          tone: "danger",
        });
        if (!ok) return;
      }
    }
    if (isProduction) {
      const ok = await confirm({
        title: t("scriptProductionConfirmTitle"),
        message: t("scriptProductionConfirmMessage", { file: basename(target) }),
        confirmLabel: t("scriptProductionConfirmOk"),
        tone: "warning",
      });
      if (!ok) return;
    }
    const runOptions: ScriptOptions = {
      ...options,
      ...override,
      startAtStatement: startAt,
      skipStatements: skipList(skip),
      // 事前確認のときのファイルと違えば、文番号がずれるのでバックエンドが実行前にエラーにする。
      expectedFile: checked.event.fileStamp,
    };
    const streamId = makeScriptStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "running" });
    setProgress(null);
    try {
      // 購読してから開始する (初回の進捗イベントを取りこぼさない)。
      const unlisten = await listenScriptStream(streamId, {
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
          setStatus({ kind: "error", event: e, runOptions });
          setProgress(null);
          toast.error(t("scriptError", { error: describeScriptError(e).message }));
        },
        onCancelled: () => {
          cleanupStream();
          setStatus({ kind: "idle" });
          setProgress(null);
        },
      });
      // 購読の await 中にアンマウント/キャンセルされたら、購読を外して開始しない
      // (受信者のいないまま書き込み文が完走するのを防ぐ)。
      if (unmountedRef.current || streamIdRef.current !== streamId) {
        // 別の実行の購読/状態には触れず、この実行の購読だけ外す。
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
      await api.runSqlScript({ sessionId, streamId, database, path: target, options: runOptions });
    } catch (e) {
      // 購読・開始 (入力検証) の失敗は終端イベントが来ないので、ここで UI を戻す。
      cleanupStream();
      setProgress(null);
      if (isAnalysisStaleError(String(e))) {
        // 事前確認のあとでファイルが変わった: 結果と除外を捨て、次の実行で確認し直させる。
        setAnalysis(null);
        setExcluded(new Set());
        setStatus({ kind: "setupError", message: t("scriptAnalysisFileChanged") });
        toast.error(t("scriptAnalysisFileChanged"));
      } else {
        setStatus({ kind: "setupError", message: String(e) });
        toast.error(t("scriptError", { error: String(e) }));
      }
    }
  };

  /** 失敗した文 (または次の文) から再開する。開始文番号の欄にも反映する。 */
  const handleResume = (startAt: number) => {
    setStartAtText(String(startAt));
    return handleRun({ startAtStatement: startAt });
  };

  const handleCancelRun = async () => {
    const streamId = streamIdRef.current;
    if (!streamId) return;
    const analyzing = isAnalyzing;
    // 先に購読を外し、バックエンドの cancelled イベントと二重に処理しない
    // (Dump / Export と同じキャンセル手順)。確定済み文数は戻り値から読む。
    cleanupStream();
    setStatus({ kind: "idle" });
    setProgress(null);
    pendingAnalysisRef.current?.(null);
    const res = await api.cancelStream(streamId).catch(() => null);
    if (analyzing) toast.info(t("scriptAnalysisCancelled"));
    else toast.info(t("scriptCancelled", { count: res?.deliveredRows ?? 0 }));
  };

  const percent = progress ? scriptProgressPercent(progress) : null;
  // 再開の可否は、その実行で使ったオプションで決める (実行後に画面のスイッチを触っても変わらない)。
  const resumeAt = status.kind === "error" ? resumeStartAt(status.event, status.runOptions) : null;
  const resumeSkipAt = status.kind === "error" ? resumeStartAt(status.event, status.runOptions, true) : null;
  const resumeBeginAt = status.kind === "error" ? resumeFromBeginAt(status.event, status.runOptions) : null;
  // 開始文番号が BEGIN〜COMMIT の途中なら警告する (事前確認の結果があるときだけ判定できる)。
  const startTxBegin =
    analysisFresh && analysis && !options.wrapInTransaction
      ? startInsideTransaction(analysis.event.analysis, parseStartAt(startAtText))
      : null;

  return (
    <Modal onSubmit={() => handleRun()} submitDisabled={busy || !path.trim()} width="640px" onClose={onClose} closeOnInteractOutside={!busy} closeOnEscape={!busy}>
      <ModalHeader onClose={onClose} closeLabel={t("scriptClose")} closeDisabled={busy}>
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
              disabled={busy}
            />
            <Button type="button" onClick={handleBrowse} disabled={busy}>
              {t("scriptBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        <FormSection flexDirection="row" flexWrap="wrap" gap="4" alignItems="flex-start">
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="script-encoding">{t("scriptEncodingLabel")}</FieldLabel>
            <Select
              id="script-encoding"
              minW="160px"
              value={options.encoding ?? ""}
              onChange={(e) => setOptions((prev) => ({ ...prev, encoding: parseTextEncodingId(e.target.value) }))}
              disabled={busy}
            >
              <option value="">{t("scriptEncodingAuto")}</option>
              {TEXT_ENCODING_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </chakra.div>
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            <FieldLabel htmlFor="script-start-at">{t("scriptStartAtLabel")}</FieldLabel>
            <Input
              id="script-start-at"
              maxW="140px"
              type="text"
              inputMode="numeric"
              value={startAtText}
              onChange={(e) => setStartAtText(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1"
              disabled={busy}
            />
          </chakra.div>
          <chakra.div color="app.textMuted" textStyle="caption" lineHeight="snug" flexBasis="100%">
            {t("scriptEncodingHint")} {t("scriptStartAtHint")}
          </chakra.div>
          {startTxBegin != null && (
            <chakra.div flexBasis="100%">
              <Callout tone="warning" role="status">
                {t("scriptStartInTransactionWarning", {
                  start: parseStartAt(startAtText),
                  begin: startTxBegin,
                })}
              </Callout>
            </chakra.div>
          )}
        </FormSection>

        {analysis && status.kind !== "analyzing" && (
          <div ref={analysisRef}>
            <ScriptAnalysisPanel
              event={analysis.event}
              excluded={excluded}
              stale={!analysisFresh}
              disabled={busy || !analysisFresh}
              onToggle={(index) => setExcluded((prev) => toggleExcluded(prev, index))}
              onExcludeDangerous={(exclude) =>
                setExcluded((prev) => setDangerousExcluded(prev, analysis.event.analysis, exclude))
              }
            />
          </div>
        )}

        <FormSection>
          <FieldLabel as="div">{t("scriptOptionsLabel")}</FieldLabel>
          <chakra.div display="flex" flexDirection="column" gap="1.5">
            {OPTION_ROWS.map((row) => (
              <chakra.div key={row.key} display="flex" alignItems="flex-start" gap="2" py="1">
                <chakra.span mt="0.5" flex="none">
                  <Switch
                    checked={options[row.key]}
                    onChange={() => setOptions((prev) => toggleScriptOption(prev, row.key))}
                    disabled={busy}
                    size="sm"
                    aria-label={t(row.label)}
                  />
                </chakra.span>
                <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0}>
                  <chakra.span fontSize="md" color="app.text">
                    {t(row.label)}
                  </chakra.span>
                  <chakra.span color="app.textMuted" textStyle="caption" lineHeight="snug">
                    {t(row.hint)}
                  </chakra.span>
                </chakra.span>
              </chakra.div>
            ))}
          </chakra.div>
          <chakra.div color="app.textMuted" textStyle="caption" lineHeight="snug">
            {t("scriptSessionNote")}
          </chakra.div>
        </FormSection>

        <StreamProgressBar active={busy} />

        <div ref={statusRef}>
        <AnimatePresence mode="wait" initial={false}>
          {(isRunning || isAnalyzing) && (
            <motion.div
              key="script-progress"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.div fontSize="sm" color="app.textMuted" display="flex" flexWrap="wrap" alignItems="center" gap="2">
                <chakra.span fontWeight={500} color="app.text">
                  {isAnalyzing
                    ? progress
                      ? t("scriptAnalyzingProgress", { count: progress.executed.toLocaleString() })
                      : t("scriptAnalyzing")
                    : progress
                      ? t("scriptProgress", { executed: progress.executed })
                      : t("scriptRunning")}
                </chakra.span>
                {isRunning && progress && progress.failed > 0 && (
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
              <ScriptErrorSummary
                event={status.event}
                resumeAt={resumeAt}
                resumeSkipAt={resumeSkipAt}
                resumeBeginAt={resumeBeginAt}
                onResume={handleResume}
              />
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
          {status.kind === "analysisError" && (
            <motion.div
              key="script-analysis-error"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <ErrorNote>{t("scriptAnalysisFailed", { error: status.message })}</ErrorNote>
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </ModalBody>

      <ModalFooter>
        <LoadingButton
          pressable
          type="button"
          variant="secondary"
          loading={isAnalyzing}
          onClick={handleAnalyze}
          disabled={busy || !path.trim()}
        >
          {isAnalyzing ? t("scriptAnalyzing") : t("scriptAnalyze")}
        </LoadingButton>
        <div style={{ flex: 1 }} />
        {busy ? (
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
          onClick={() => handleRun()}
          disabled={busy || !path.trim()}
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
        <chakra.div color="app.textMuted" textStyle="caption">
          {t("scriptDoneSkippedControl", { count: event.skippedControl })}
        </chakra.div>
      )}
      {event.skippedExcluded > 0 && (
        <chakra.div color="app.textMuted" textStyle="caption">
          {t("scriptDoneSkippedExcluded", { count: event.skippedExcluded.toLocaleString() })}
        </chakra.div>
      )}
      {event.skippedBeforeStart > 0 && (
        <chakra.div color="app.textMuted" textStyle="caption">
          {t("scriptDoneSkippedBefore", { count: event.skippedBeforeStart.toLocaleString() })}
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
                <chakra.span color="app.textMuted" textStyle="caption" fontFamily="mono" wordBreak="break-all">
                  {f.sql}
                </chakra.span>
              </chakra.li>
            ))}
          </chakra.ul>
          {omitted > 0 && (
            <chakra.div color="app.textMuted" textStyle="caption">
              {t("scriptFailuresOmitted", { count: omitted })}
            </chakra.div>
          )}
        </chakra.div>
      )}
    </chakra.div>
  );
}

function ScriptErrorSummary({
  event,
  resumeAt,
  resumeSkipAt,
  resumeBeginAt,
  onResume,
}: {
  event: ScriptErrorEvent;
  /** 失敗した文から再開できるときの開始文番号。`null` は再開できない。 */
  resumeAt: number | null;
  resumeSkipAt: number | null;
  /** トランザクションの途中で失敗したとき、その BEGIN 文の番号 (そこから再開できる)。 */
  resumeBeginAt: number | null;
  onResume: (startAt: number) => void;
}) {
  const t = useT();
  const d = describeScriptError(event);
  return (
    <chakra.div display="flex" flexDirection="column" gap="2">
      <ErrorNote>
        <chakra.div display="flex" flexDirection="column" gap="1">
          <chakra.span>
            {d.index != null && d.line != null
              ? t("scriptErrorAtIndex", { index: d.index, line: d.line, error: d.message })
              : d.line != null
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
      {resumeAt != null && resumeSkipAt != null && (
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.div display="flex" flexWrap="wrap" gap="2">
            <Button type="button" variant="secondary" onClick={() => onResume(resumeAt)}>
              {t("scriptResume")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => onResume(resumeSkipAt)}>
              {t("scriptResumeSkip")}
            </Button>
          </chakra.div>
          <chakra.div color="app.textMuted" textStyle="caption" lineHeight="snug">
            {t("scriptResumeHint", { index: resumeAt })}
          </chakra.div>
        </chakra.div>
      )}
      {resumeAt == null && resumeBeginAt != null && (
        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.div display="flex" flexWrap="wrap" gap="2">
            <Button type="button" variant="secondary" onClick={() => onResume(resumeBeginAt)}>
              {t("scriptResumeFromBegin", { index: resumeBeginAt })}
            </Button>
          </chakra.div>
          <chakra.div color="app.textMuted" textStyle="caption" lineHeight="snug">
            {t("scriptResumeFromBeginHint", { begin: resumeBeginAt })}
          </chakra.div>
        </chakra.div>
      )}
      {resumeAt == null && resumeBeginAt == null && d.index != null && (
        <chakra.div color="app.textMuted" textStyle="caption" lineHeight="snug">
          {event.inTransaction ? t("scriptResumeInTransactionUnavailable") : t("scriptResumeUnavailable")}
        </chakra.div>
      )}
    </chakra.div>
  );
}
