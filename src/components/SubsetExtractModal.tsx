import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { connectRequestFromProfile } from "../connectRequest";
import {
  api,
  listenSubsetStream,
  type ConnectionProfile,
  type SandboxCreateResponse,
  type SandboxRecord,
  type SubsetDoneEvent,
  type SubsetWarning,
  type SubsetExisting,
  type SubsetOutput,
  type SubsetPreview,
} from "../api/tauri";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { pickDefaultDatabase } from "./dataTransfer";
import { ExportMaskingSection } from "./ExportMaskingSection";
import type { ExportMaskOverrides } from "./exportMasking";
import { JobOutcome, JobPresence, JobProgressDetail, useJobClock } from "./JobProgress";
import { ListboxSelect } from "./ListboxSelect";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { FieldError, FieldLabel, FormSection, PathRow } from "./modalForm";
import { Spinner } from "./Spinner";
import { StreamProgressBar } from "./StreamProgressBar";
import {
  buildSubsetRequest,
  defaultSubsetScriptName,
  makeSubsetStreamId,
  maskableColumns,
  needsWriteConfirm,
  parseBoundedInt,
  previewMatches,
  resolveSubsetMasks,
  SUBSET_DEFAULT_CHILD_DEPTH,
  SUBSET_DEFAULT_CHILD_LIMIT,
  SUBSET_DEFAULT_ROOT_LIMIT,
  SUBSET_MAX_CHILD_DEPTH,
  SUBSET_MAX_CHILD_LIMIT,
  subsetRootMax,
  subsetWarningMessage,
} from "./subsetExtract";
import { useToast } from "./Toast";
import { Button, Checkbox, Input } from "./ui";

/**
 * サブセット抽出 (#2241)。起点の表と条件で選んだ行から、外部キーを行単位で辿って
 * 参照整合性を保ったまま一部の行だけを取り出し、別の接続 / INSERT スクリプト /
 * サンドボックスへ出す。計画の組み立て (親は最後まで・子は段数と件数の上限つき) と
 * 取得はバックエンド (`db/subset.rs` / `commands/subset.rs`) が行い、ここは指定の入力・
 * プレビュー (表ごとの件数・循環・上限超過)・マスキング・実行/中断を担う。
 * 判定の純ロジックは `subsetExtract.ts`。
 */
interface Props {
  sessionId: string;
  sourceProfileId: string | null;
  database: string | null;
  table: string;
  profiles: ConnectionProfile[];
  /** サンドボックスを出力先にしたとき、作成後の接続を開く。 */
  onSandboxRegistered: (res: SandboxCreateResponse) => void;
  /** 作成済みのサンドボックスへ接続して開く (完了表示のボタンから)。 */
  onOpenSandbox: (sandbox: SandboxRecord) => void;
  /** 転送先の接続へ切り替えて、その表を開く (転送出力の完了表示から)。 */
  onOpenTransferTarget?: (profile: ConnectionProfile, database: string | null, table: string) => void;
  onClose: () => void;
}

type OutputKind = SubsetOutput["kind"] | "sandbox";

type Status =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "running"; phase: "collect" | "write"; rows: number };

/** 実行の結末。モーダルは自動で閉じず、完了・中断・失敗のどれでもここに残す (#2264)。 */
type Outcome =
  | {
      kind: "done";
      output: OutputKind;
      rows: number | null;
      elapsedMs: number;
      tables: { table: string; rows: number | null }[];
      warnings: SubsetWarning[];
      /** 完了メッセージ用 (スクリプト出力のときだけ)。 */
      path: string | null;
      sandbox: SandboxRecord | null;
      /** 実行時点の転送先 (完了後にフォームを触っても変わらない)。 */
      transfer: { profile: ConnectionProfile; database: string | null } | null;
      truncatedTables: string[];
    }
  | { kind: "cancelled"; rows: number; elapsedMs: number; total: number | null }
  | { kind: "error"; message: string; rows: number; elapsedMs: number; total: number | null };

/** 表別の内訳の先頭何件まで順次入場させるか (多い一覧を全件遅延させない)。 */
const STAGGER_CAP = 20;

const MotionDiv = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });

export function SubsetExtractModal({
  sessionId,
  sourceProfileId,
  database,
  table,
  profiles,
  onSandboxRegistered,
  onOpenSandbox,
  onOpenTransferTarget,
  onClose,
}: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [whereClause, setWhereClause] = useState("");
  const [rootLimit, setRootLimit] = useState(String(SUBSET_DEFAULT_ROOT_LIMIT));
  const [childrenEnabled, setChildrenEnabled] = useState(false);
  const [childDepth, setChildDepth] = useState(String(SUBSET_DEFAULT_CHILD_DEPTH));
  const [childLimit, setChildLimit] = useState(String(SUBSET_DEFAULT_CHILD_LIMIT));

  const [preview, setPreview] = useState<SubsetPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // 実行開始時のプレビュー総行数 (確定進捗の分母)。サンドボックスは進捗イベントが無いので使わない。
  const [runTotal, setRunTotal] = useState<number | null>(null);
  const runStartRef = useRef(0);
  // 実行ごとに増やす番号。遅れて返った中断応答が次の実行の結果を上書きしないように使う。
  const runSeqRef = useRef(0);
  const reduced = useReducedMotion() ?? false;

  const [maskEnabled, setMaskEnabled] = useState(false);
  const [maskOverrides, setMaskOverrides] = useState<ExportMaskOverrides>({});

  const [output, setOutput] = useState<OutputKind>("transfer");
  const [existing, setExisting] = useState<SubsetExisting>("skip");
  const [scriptPath, setScriptPath] = useState("");
  const [sandboxName, setSandboxName] = useState(`${table} (subset)`);

  const [profileId, setProfileId] = useState("");
  const [targetSession, setTargetSession] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [targetDatabase, setTargetDatabase] = useState<string | null>(null);

  const ownedSessionRef = useRef<string | null>(null);
  const unmountedRef = useRef(false);
  const selectSeqRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // 読み込み中にモーダルが閉じた / 条件が変わったときに、古いプレビューの結果を捨てる印。
  const previewSeqRef = useRef(0);

  const isRunning = status.kind === "running";
  const isPreviewing = status.kind === "previewing";
  const busy = isRunning || isPreviewing;
  const jobElapsedMs = useJobClock(isRunning);
  const targetProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId],
  );

  const releaseSession = useCallback(() => {
    const sid = ownedSessionRef.current;
    ownedSessionRef.current = null;
    if (sid) api.disconnect(sid).catch(() => {});
  }, []);

  // アンマウント時: 実行中の抽出を止め、購読と専用セッションを片付ける。
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const sid = streamIdRef.current;
      if (sid) void api.cancelStream(sid).catch(() => {});
      unlistenRef.current?.();
      unlistenRef.current = null;
      streamIdRef.current = null;
      releaseSession();
    };
  }, [releaseSession]);

  const request = useMemo(
    () =>
      buildSubsetRequest({
        sessionId,
        database,
        table,
        whereClause,
        rootLimit,
        // サンドボックスは子の方向を辿らない。
        childrenEnabled: childrenEnabled && output !== "sandbox",
        childDepth,
        childLimit,
        sandbox: output === "sandbox",
      }),
    [sessionId, database, table, whereClause, rootLimit, childrenEnabled, output, childDepth, childLimit],
  );
  const previewFresh = previewMatches(previewKey, request);
  const visiblePreview = previewFresh ? preview : null;

  const rootLimitInvalid = parseBoundedInt(rootLimit, 1, subsetRootMax(output === "sandbox")) === null;
  const childDepthInvalid =
    childrenEnabled &&
    output !== "sandbox" &&
    parseBoundedInt(childDepth, 1, SUBSET_MAX_CHILD_DEPTH) === null;
  const childLimitInvalid =
    childrenEnabled &&
    output !== "sandbox" &&
    parseBoundedInt(childLimit, 1, SUBSET_MAX_CHILD_LIMIT) === null;

  const maskTargets = useMemo(
    () => (visiblePreview ? maskableColumns(visiblePreview) : []),
    [visiblePreview],
  );
  const masks = useMemo(
    () => resolveSubsetMasks(visiblePreview, maskEnabled && output !== "sandbox", maskOverrides),
    [visiblePreview, maskEnabled, output, maskOverrides],
  );

  const runPreview = async () => {
    if (!request || busy) return;
    const seq = ++previewSeqRef.current;
    setStatus({ kind: "previewing" });
    setPreviewError(null);
    try {
      const p = await api.previewSubset(request);
      if (unmountedRef.current || seq !== previewSeqRef.current) return;
      setPreview(p);
      setPreviewKey(JSON.stringify(request));
      setStatus({ kind: "idle" });
    } catch (e) {
      if (unmountedRef.current || seq !== previewSeqRef.current) return;
      setPreview(null);
      setPreviewKey(null);
      setPreviewError(String(e));
      setStatus({ kind: "idle" });
    }
  };

  const selectProfile = useCallback(
    async (id: string) => {
      releaseSession();
      const seq = ++selectSeqRef.current;
      setProfileId(id);
      setTargetSession(null);
      setDatabases(null);
      setTargetDatabase(null);
      setConnectError(null);
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return;
      setConnecting(true);
      try {
        // read_only はプロファイルから取る (読み取り専用ならバックエンドが書き込みを拒否する)。
        const res = await api.connect(connectRequestFromProfile(profile));
        if (unmountedRef.current || seq !== selectSeqRef.current) {
          api.disconnect(res.session_id).catch(() => {});
          return;
        }
        ownedSessionRef.current = res.session_id;
        setTargetSession(res.session_id);
        const dbs = await api.listDatabases(res.session_id).catch(() => [] as string[]);
        if (unmountedRef.current || seq !== selectSeqRef.current) return;
        setDatabases(dbs);
        setTargetDatabase(pickDefaultDatabase(dbs, profile.database));
      } catch (e) {
        if (!unmountedRef.current && seq === selectSeqRef.current) setConnectError(String(e));
      } finally {
        if (!unmountedRef.current && seq === selectSeqRef.current) setConnecting(false);
      }
    },
    [profiles, releaseSession],
  );

  const handleBrowse = async () => {
    const selected = await save({
      defaultPath: scriptPath || defaultSubsetScriptName(table),
      title: t("subsetPickFileTitle"),
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (typeof selected === "string" && selected) setScriptPath(selected);
  };

  const sameTarget =
    output === "transfer" &&
    !!targetSession &&
    !!sourceProfileId &&
    sourceProfileId === profileId &&
    (database ?? "") === (targetDatabase ?? "");
  const outputReady =
    output === "transfer"
      ? !!targetSession && !!targetProfile && !targetProfile.read_only && !connecting && !sameTarget
      : output === "script"
        ? scriptPath.trim() !== ""
        : sandboxName.trim() !== "";
  const hasRows = !!visiblePreview && visiblePreview.totalRows > 0;
  const canRun = !busy && request !== null && previewFresh && hasRows && outputReady;

  const cleanupStream = () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamIdRef.current = null;
  };

  const runSandbox = async () => {
    if (!request) return;
    runSeqRef.current += 1;
    setStatus({ kind: "running", phase: "write", rows: 0 });
    setOutcome(null);
    setRunTotal(null);
    runStartRef.current = Date.now();
    try {
      const res = await api.createSandbox({
        sourceSessionId: sessionId,
        sourceDatabase: database,
        name: sandboxName.trim(),
        tables: [{ name: table, filter: request.whereClause ?? null }],
        // 起点の行が参照する親の行を、行単位で必ず含める。
        includeRelated: true,
        rowLimit: request.rootRowLimit ?? null,
      });
      // 登録 (一覧への追加・作成用セッションの切断・トースト) は完了時に必ず行う。
      // 完了表示のボタンを押さずに閉じても、セッションがリークしないように。
      onSandboxRegistered(res);
      if (unmountedRef.current) return;
      setStatus({ kind: "idle" });
      setOutcome({
        kind: "done",
        output: "sandbox",
        rows: null,
        elapsedMs: Date.now() - runStartRef.current,
        tables: res.sandbox.tables.map((name) => ({ table: name, rows: null })),
        warnings: [],
        path: null,
        sandbox: res.sandbox,
        transfer: null,
        truncatedTables: res.sandbox.truncated_tables,
      });
    } catch (e) {
      if (unmountedRef.current) return;
      setStatus({ kind: "idle" });
      setOutcome({
        kind: "error",
        message: String(e),
        rows: 0,
        elapsedMs: Date.now() - runStartRef.current,
        total: null,
      });
    }
  };

  const run = async () => {
    if (!canRun || !request) return;
    if (output === "sandbox") {
      await runSandbox();
      return;
    }
    let subsetOutput: SubsetOutput;
    if (output === "transfer") {
      if (!targetSession || !targetProfile) return;
      if (needsWriteConfirm(targetProfile)) {
        const ok = await confirm({
          title: t("productionConfirmTitle"),
          message: t("subsetProductionConfirm", { name: targetProfile.name }),
          tone: "warning",
        });
        if (!ok) return;
      }
      subsetOutput = { kind: "transfer", targetSessionId: targetSession, targetDatabase, existing };
    } else {
      subsetOutput = { kind: "script", path: scriptPath.trim(), existing };
    }

    const streamId = makeSubsetStreamId();
    streamIdRef.current = streamId;
    runSeqRef.current += 1;
    setOutcome(null);
    setRunTotal(visiblePreview?.totalRows ?? null);
    runStartRef.current = Date.now();
    setStatus({ kind: "running", phase: "collect", rows: 0 });
    const runTotalNow = visiblePreview?.totalRows ?? null;
    const failWith = (message: string, rows: number) => {
      cleanupStream();
      setStatus({ kind: "idle" });
      setOutcome({
        kind: "error",
        message,
        rows,
        elapsedMs: Date.now() - runStartRef.current,
        total: runTotalNow,
      });
    };
    try {
      unlistenRef.current = await listenSubsetStream(streamId, {
        onProgress: (e) => setStatus({ kind: "running", phase: e.phase, rows: e.rows }),
        onDone: (e: SubsetDoneEvent) => {
          cleanupStream();
          setStatus({ kind: "idle" });
          setOutcome({
            kind: "done",
            output,
            rows: e.rows,
            elapsedMs: e.elapsedMs,
            tables: e.tables,
            warnings: e.warnings,
            path: e.path,
            sandbox: null,
            transfer:
              output === "transfer" && targetProfile
                ? { profile: targetProfile, database: targetDatabase }
                : null,
            truncatedTables: [],
          });
        },
        onError: (e) => failWith(e.message, e.rows),
        // 中断の完了表示は cancelRun が cancel_stream の応答で出す (ここで二重に出さない)。
        onCancelled: () => {},
      });
      await api.runSubset(streamId, request, subsetOutput, masks);
    } catch (e) {
      failWith(String(e), 0);
    }
  };

  const cancelRun = async () => {
    const streamId = streamIdRef.current;
    if (!streamId) return;
    const rows = status.kind === "running" ? status.rows : 0;
    const seq = runSeqRef.current;
    const startedAt = runStartRef.current;
    const total = runTotal;
    cleanupStream();
    setStatus({ kind: "idle" });
    const res = await api.cancelStream(streamId).catch(() => null);
    // 応答を待つ間に次の実行が始まっていたら、古い中断結果は捨てる。
    if (unmountedRef.current || runSeqRef.current !== seq) return;
    setOutcome({
      kind: "cancelled",
      rows: res?.deliveredRows ?? rows,
      elapsedMs: Date.now() - startedAt,
      total,
    });
  };

  const openScriptDir = (path: string) => {
    api.revealInFileManager(path).catch((e) => toast.error(t("subsetOpenFailed", { error: String(e) })));
  };

  const renderOutcome = () => {
    if (!outcome) return null;
    if (outcome.kind === "cancelled") {
      return (
        <JobOutcome
          kind="cancelled"
          testId="subset-outcome"
          detail={{
            done: outcome.rows,
            total: outcome.total,
            elapsedMs: outcome.elapsedMs,
            stats: [{ label: t("jobStatRows"), value: outcome.rows }],
          }}
          message={t("subsetCancelled", { rows: outcome.rows })}
        />
      );
    }
    if (outcome.kind === "error") {
      return (
        <JobOutcome
          kind="error"
          testId="subset-outcome"
          detail={{
            done: outcome.rows,
            total: outcome.total,
            elapsedMs: outcome.elapsedMs,
            stats: [{ label: t("jobStatRows"), value: outcome.rows }],
          }}
          message={t("subsetError", { error: outcome.message })}
        />
      );
    }
    const rowsKnown = outcome.rows !== null;
    const message = outcome.sandbox
      ? t("subsetDoneSandbox", { name: outcome.sandbox.name, tables: outcome.tables.length })
      : outcome.path
        ? t("subsetDoneScript", {
            rows: outcome.rows ?? 0,
            tables: outcome.tables.length,
            path: outcome.path,
          })
        : t("subsetDone", { rows: outcome.rows ?? 0, tables: outcome.tables.length });
    const { path, sandbox } = outcome;
    const transfer = outcome.transfer;
    return (
      <JobOutcome
        kind="done"
        testId="subset-outcome"
        tone={outcome.warnings.length > 0 || outcome.truncatedTables.length > 0 ? "warning" : "success"}
        detail={{
          done: outcome.rows ?? 0,
          total: rowsKnown ? outcome.rows : null,
          elapsedMs: outcome.elapsedMs,
          stats: [
            ...(rowsKnown ? [{ label: t("jobStatRows"), value: outcome.rows as number }] : []),
            { label: t("jobStatTables"), value: outcome.tables.length },
          ],
          rate: rowsKnown ? { label: t("jobStatRowsPerSec"), count: outcome.rows as number } : undefined,
        }}
        message={message}
      >
        {outcome.tables.length > 0 && (
          <MotionDiv
            data-testid="subset-outcome-tables"
            variants={staggerContainer(reduced)}
            initial="initial"
            animate="animate"
            display="flex"
            flexDirection="column"
            border="1px solid"
            borderColor="app.border"
            borderRadius="md"
            overflow="hidden"
          >
            {outcome.tables.map((row, i) => (
              <MotionDiv
                key={row.table}
                data-testid="subset-outcome-row"
                variants={i < STAGGER_CAP ? variants.staggerItem : undefined}
                display="flex"
                alignItems="baseline"
                gap="3"
                px="3"
                py="1.5"
                borderBottom="1px solid"
                borderColor="app.border"
                fontSize="sm"
              >
                <chakra.span flex="1" minW="0" fontFamily="mono" wordBreak="break-all">
                  {row.table}
                </chakra.span>
                {row.rows !== null && (
                  <chakra.span fontFamily="mono" minW="64px" textAlign="right">
                    {row.rows}
                  </chakra.span>
                )}
              </MotionDiv>
            ))}
          </MotionDiv>
        )}
        {outcome.warnings.map((w) => {
          const m = subsetWarningMessage(w);
          return (
            <Callout key={JSON.stringify(w)} tone="warning" role="status">
              {t(m.key, m.params)}
            </Callout>
          );
        })}
        {outcome.truncatedTables.length > 0 && (
          <Callout tone="warning" role="status">
            {t("subsetSandboxTruncated", { tables: outcome.truncatedTables.join(", ") })}
          </Callout>
        )}
        {(path || sandbox || (transfer && onOpenTransferTarget)) && (
          <Flex gap="2" justify="flex-end">
            {path && (
              <Button type="button" variant="secondary" onClick={() => openScriptDir(path)}>
                {t("subsetOpenScriptDir")}
              </Button>
            )}
            {sandbox && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  onOpenSandbox(sandbox);
                  onClose();
                }}
              >
                {t("subsetOpenSandbox")}
              </Button>
            )}
            {transfer && onOpenTransferTarget && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  onOpenTransferTarget(transfer.profile, transfer.database, table);
                  onClose();
                }}
              >
                {t("subsetOpenTransferTarget")}
              </Button>
            )}
          </Flex>
        )}
      </JobOutcome>
    );
  };

  const maskLabels = useMemo(() => maskTargets.map((m) => m.label), [maskTargets]);

  return (
    <Modal
      onSubmit={() => void run()}
      submitDisabled={!canRun}
      submitBusy={isRunning}
      width="640px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("subsetClose")} closeDisabled={isRunning}>
        {t("subsetTitle")}
      </ModalHeader>
      <StreamProgressBar active={isRunning || isPreviewing} />
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight="normal">
          {t("subsetNote")}
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("subsetStartLabel")}</FieldLabel>
          <chakra.div
            data-testid="subset-start"
            fontFamily="mono"
            fontSize="sm"
            color="app.text"
            bg="app.surfaceMuted"
            borderRadius="md"
            px="3"
            py="2"
            wordBreak="break-all"
          >
            {[database, table].filter(Boolean).join(" / ")}
          </chakra.div>
          <FieldLabel htmlFor="subset-where">{t("subsetWhereLabel")}</FieldLabel>
          <Input
            id="subset-where"
            value={whereClause}
            onChange={(e) => setWhereClause(e.target.value)}
            placeholder={t("subsetWherePlaceholder")}
            disabled={busy}
            fontFamily="mono"
          />
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("subsetWhereHint")}
          </chakra.span>
          <FieldLabel htmlFor="subset-root-limit">{t("subsetRootLimit")}</FieldLabel>
          <Input
            id="subset-root-limit"
            w="120px"
            inputMode="numeric"
            value={rootLimit}
            onChange={(e) => setRootLimit(e.target.value)}
            disabled={busy}
          />
          {rootLimitInvalid && (
            <FieldError>
              {t("subsetInvalidNumber", { min: 1, max: subsetRootMax(output === "sandbox") })}
            </FieldError>
          )}
        </FormSection>

        <FormSection>
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("subsetParentsNote")}
          </chakra.span>
          <chakra.label display="inline-flex" alignItems="center" gap="2" cursor="pointer" fontSize="md">
            <Checkbox
              checked={childrenEnabled && output !== "sandbox"}
              onChange={(e) => setChildrenEnabled(e.target.checked)}
              disabled={busy || output === "sandbox"}
            />
            <span>{t("subsetChildrenLabel")}</span>
          </chakra.label>
          {childrenEnabled && output !== "sandbox" && (
            <Flex gap="3" align="center" flexWrap="wrap">
              <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm">
                <span>{t("subsetChildDepth")}</span>
                <Input
                  w="72px"
                  inputMode="numeric"
                  value={childDepth}
                  onChange={(e) => setChildDepth(e.target.value)}
                  disabled={busy}
                />
              </chakra.label>
              <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm">
                <span>{t("subsetChildLimit")}</span>
                <Input
                  w="120px"
                  inputMode="numeric"
                  value={childLimit}
                  onChange={(e) => setChildLimit(e.target.value)}
                  disabled={busy}
                />
              </chakra.label>
            </Flex>
          )}
          {childDepthInvalid && (
            <FieldError>{t("subsetInvalidNumber", { min: 1, max: SUBSET_MAX_CHILD_DEPTH })}</FieldError>
          )}
          {childLimitInvalid && (
            <FieldError>{t("subsetInvalidNumber", { min: 1, max: SUBSET_MAX_CHILD_LIMIT })}</FieldError>
          )}
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("subsetChildrenHint")}
          </chakra.span>
        </FormSection>

        <FormSection>
          <Flex align="center" gap="2">
            <FieldLabel as="div" mb={0}>
              {t("subsetPreviewTitle")}
            </FieldLabel>
            {isPreviewing && <Spinner size={14} />}
          </Flex>
          {previewError && <FieldError>{t("subsetPreviewError", { error: previewError })}</FieldError>}
          {!previewFresh && preview && !previewError && (
            <Callout tone="info" role="status">
              {t("subsetPreviewStale")}
            </Callout>
          )}
          {!preview && !previewError && !isPreviewing && (
            <chakra.span textStyle="caption" color="app.textMuted">
              {t("subsetPreviewNeeded")}
            </chakra.span>
          )}
          {visiblePreview && visiblePreview.totalRows === 0 && (
            <Callout tone="warning" role="status">
              {t("subsetPreviewEmpty")}
            </Callout>
          )}
          {visiblePreview && visiblePreview.totalRows > 0 && (
            <>
              <chakra.div
                data-testid="subset-preview"
                display="flex"
                flexDirection="column"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                overflow="hidden"
              >
                {visiblePreview.tables.map((row) => (
                  <chakra.div
                    key={row.table}
                    data-testid="subset-preview-row"
                    display="flex"
                    alignItems="baseline"
                    gap="3"
                    px="3"
                    py="1.5"
                    borderBottom="1px solid"
                    borderColor="app.border"
                    fontSize="sm"
                  >
                    <chakra.span flex="1" minW="0" fontFamily="mono" wordBreak="break-all">
                      {row.table}
                    </chakra.span>
                    <chakra.span textStyle="caption" color="app.textMuted">
                      {t("subsetPreviewRoles", {
                        root: row.rootRows,
                        child: row.childRows,
                        parent: row.parentRows,
                      })}
                    </chakra.span>
                    <chakra.span fontFamily="mono" minW="64px" textAlign="right">
                      {row.rows}
                    </chakra.span>
                  </chakra.div>
                ))}
              </chakra.div>
              <chakra.span textStyle="caption" color="app.textMuted">
                {t("subsetPreviewTotal", {
                  rows: visiblePreview.totalRows,
                  tables: visiblePreview.tables.length,
                })}
              </chakra.span>
            </>
          )}
          {visiblePreview?.warnings.map((w) => {
            const m = subsetWarningMessage(w);
            return (
              <Callout key={JSON.stringify(w)} tone="warning" role="status">
                {t(m.key, m.params)}
              </Callout>
            );
          })}
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="subset-output">{t("subsetOutputLabel")}</FieldLabel>
          <ListboxSelect
            id="subset-output"
            value={output}
            options={[
              { value: "transfer", label: t("subsetOutputTransfer") },
              { value: "script", label: t("subsetOutputScript") },
              { value: "sandbox", label: t("subsetOutputSandbox") },
            ]}
            onChange={(v) => setOutput(v as OutputKind)}
            disabled={busy}
            css={{ width: "100%" }}
          />
          <chakra.span textStyle="caption" color="app.textMuted">
            {output === "transfer"
              ? t("subsetOutputTransferHint")
              : output === "script"
                ? t("subsetOutputScriptHint")
                : t("subsetOutputSandboxHint")}
          </chakra.span>
        </FormSection>

        {output === "transfer" && (
          <FormSection>
            <FieldLabel htmlFor="subset-target-profile">{t("transferTargetProfile")}</FieldLabel>
            <Flex align="center" gap="2">
              <ListboxSelect
                id="subset-target-profile"
                css={{ flex: "1" }}
                value={profileId}
                options={[
                  { value: "", label: t("transferSelectProfile") },
                  ...profiles.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={(v) => void selectProfile(v)}
                disabled={busy || connecting}
              />
              {connecting && <Spinner size={14} />}
            </Flex>
            {connectError && <FieldError>{t("transferConnectError", { error: connectError })}</FieldError>}
            {targetProfile?.read_only && <FieldError>{t("transferTargetReadOnly")}</FieldError>}
            {databases && databases.length > 0 && (
              <>
                <FieldLabel htmlFor="subset-target-db">{t("transferTargetDatabase")}</FieldLabel>
                <ListboxSelect
                  id="subset-target-db"
                  value={targetDatabase ?? ""}
                  options={databases.map((d) => ({ value: d }))}
                  onChange={(v) => setTargetDatabase(v || null)}
                  disabled={busy}
                  css={{ width: "100%" }}
                />
              </>
            )}
            {sameTarget && <FieldError>{t("subsetSameTarget")}</FieldError>}
          </FormSection>
        )}

        {output === "script" && (
          <FormSection>
            <FieldLabel htmlFor="subset-path">{t("subsetSavePath")}</FieldLabel>
            <PathRow>
              <Input
                id="subset-path"
                flex="1"
                minW={0}
                value={scriptPath}
                onChange={(e) => setScriptPath(e.target.value)}
                placeholder={defaultSubsetScriptName(table)}
                disabled={busy}
              />
              <Button type="button" onClick={() => void handleBrowse()} disabled={busy}>
                {t("exportBrowse")}
              </Button>
            </PathRow>
          </FormSection>
        )}

        {output === "sandbox" && (
          <FormSection>
            <FieldLabel htmlFor="subset-sandbox-name">{t("subsetSandboxName")}</FieldLabel>
            <Input
              id="subset-sandbox-name"
              value={sandboxName}
              onChange={(e) => setSandboxName(e.target.value)}
              disabled={busy}
            />
          </FormSection>
        )}

        {output !== "sandbox" && (
          <FormSection>
            <FieldLabel htmlFor="subset-existing">{t("subsetExistingLabel")}</FieldLabel>
            <ListboxSelect
              id="subset-existing"
              value={existing}
              options={[
                { value: "skip", label: t("subsetExistingSkip") },
                { value: "fail", label: t("subsetExistingFail") },
              ]}
              onChange={(v) => setExisting(v as SubsetExisting)}
              disabled={busy}
              css={{ width: "100%" }}
            />
          </FormSection>
        )}

        {output !== "sandbox" && visiblePreview && maskLabels.length > 0 && (
          <ExportMaskingSection
            columnNames={maskLabels}
            enabled={maskEnabled}
            onEnabledChange={setMaskEnabled}
            presets={[]}
            overrides={maskOverrides}
            onOverridesChange={setMaskOverrides}
            hint={t("subsetMaskHint")}
            disabled={busy}
          />
        )}

        <JobPresence show={isRunning}>
          {status.kind === "running" && (
            <chakra.div display="flex" flexDirection="column" gap="2">
              <chakra.div aria-live="off">
                <JobProgressDetail
                  done={status.rows}
                  total={status.phase === "write" ? runTotal : null}
                  elapsedMs={jobElapsedMs}
                  running
                  rate={{ label: t("jobStatRowsPerSec"), count: status.rows }}
                  stats={[{ label: t("jobStatRows"), value: status.rows }]}
                  barTestId="subset-progress-bar"
                />
              </chakra.div>
              <chakra.div role="status" aria-live="polite" fontSize="sm" color="app.text">
                {status.phase === "collect" ? t("subsetRunningCollect") : t("subsetRunningWrite")}
              </chakra.div>
            </chakra.div>
          )}
        </JobPresence>
        {outcome && renderOutcome()}
      </ModalBody>
      <ModalFooter>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void runPreview()}
          disabled={busy || request === null}
        >
          {isPreviewing ? t("subsetPreviewing") : t("subsetPreviewButton")}
        </Button>
        <div style={{ flex: 1 }} />
        {isRunning && output !== "sandbox" ? (
          <Button type="button" variant="secondary" onClick={() => void cancelRun()}>
            {t("subsetCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose} disabled={isRunning}>
            {t("subsetClose")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isRunning}
          onClick={() => void run()}
          disabled={!canRun}
        >
          {isRunning ? t("subsetRunning") : t("subsetExecute")}
        </LoadingButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
