import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { connectRequestFromProfile } from "../connectRequest";
import {
  api,
  listenSubsetStream,
  type ConnectionProfile,
  type SandboxCreateResponse,
  type SubsetExisting,
  type SubsetOutput,
  type SubsetPreview,
} from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { pickDefaultDatabase } from "./dataTransfer";
import { ExportMaskingSection } from "./ExportMaskingSection";
import type { ExportMaskOverrides } from "./exportMasking";
import { JobPresence, JobProgressDetail, useJobClock } from "./JobProgress";
import { ListboxSelect } from "./ListboxSelect";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldError, FieldLabel, FormSection, PathRow } from "./modalForm";
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
  SUBSET_MAX_ROOT_LIMIT,
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
  onSandboxCreated: (res: SandboxCreateResponse) => void;
  onClose: () => void;
}

type OutputKind = SubsetOutput["kind"] | "sandbox";

type Status =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "running"; phase: "collect" | "write"; rows: number }
  | { kind: "error"; message: string };

export function SubsetExtractModal({
  sessionId,
  sourceProfileId,
  database,
  table,
  profiles,
  onSandboxCreated,
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
      }),
    [sessionId, database, table, whereClause, rootLimit, childrenEnabled, output, childDepth, childLimit],
  );
  const previewFresh = previewMatches(previewKey, request);
  const visiblePreview = previewFresh ? preview : null;

  const rootLimitInvalid = parseBoundedInt(rootLimit, 1, SUBSET_MAX_ROOT_LIMIT) === null;
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
    setStatus({ kind: "running", phase: "write", rows: 0 });
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
      if (unmountedRef.current) return;
      setStatus({ kind: "idle" });
      onSandboxCreated(res);
      onClose();
    } catch (e) {
      if (!unmountedRef.current) setStatus({ kind: "error", message: String(e) });
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
    setStatus({ kind: "running", phase: "collect", rows: 0 });
    try {
      unlistenRef.current = await listenSubsetStream(streamId, {
        onProgress: (e) => setStatus({ kind: "running", phase: e.phase, rows: e.rows }),
        onDone: (e) => {
          cleanupStream();
          setStatus({ kind: "idle" });
          toast.success(
            e.path
              ? t("subsetDoneScript", { rows: e.rows, tables: e.tables.length, path: e.path })
              : t("subsetDone", { rows: e.rows, tables: e.tables.length }),
          );
          onClose();
        },
        onError: (e) => {
          cleanupStream();
          setStatus({ kind: "error", message: e.message });
        },
        onCancelled: () => {
          cleanupStream();
          setStatus({ kind: "idle" });
        },
      });
      await api.runSubset(streamId, request, subsetOutput, masks);
    } catch (e) {
      cleanupStream();
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const cancelRun = async () => {
    const streamId = streamIdRef.current;
    if (!streamId) return;
    cleanupStream();
    setStatus({ kind: "idle" });
    const res = await api.cancelStream(streamId).catch(() => null);
    toast.info(t("subsetCancelled", { rows: res?.deliveredRows ?? 0 }));
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
            <FieldError>{t("subsetInvalidNumber", { min: 1, max: SUBSET_MAX_ROOT_LIMIT })}</FieldError>
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
                  total={null}
                  elapsedMs={jobElapsedMs}
                  running
                  rate={{ label: t("jobStatRowsPerSec"), count: status.rows }}
                  stats={[{ label: t("jobStatRows"), value: status.rows }]}
                />
              </chakra.div>
              <chakra.div role="status" aria-live="polite" fontSize="sm" color="app.text">
                {status.phase === "collect" ? t("subsetRunningCollect") : t("subsetRunningWrite")}
              </chakra.div>
            </chakra.div>
          )}
        </JobPresence>
        {status.kind === "error" && <ErrorNote>{t("subsetError", { error: status.message })}</ErrorNote>}
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
