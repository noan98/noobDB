import { connectRequestFromProfile } from "../connectRequest";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenTransferStream,
  type ConnectionProfile,
  type TransferLossyConversion,
  type TransferMode,
  type TransferTypeKind,
} from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Callout } from "./Callout";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, Input } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import { DraftNumberInput } from "./DraftNumberInput";
import { LoadingButton } from "./LoadingButton";
import { Spinner } from "./Spinner";
import { StreamProgressBar } from "./StreamProgressBar";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import {
  allColumnsExcluded,
  invalidDecimalColumns,
  buildTransferColumnSpecs,
  DEFAULT_TRIAL_ROWS,
  defaultColumnDraft,
  defaultTransferTableName,
  makeTransferStreamId,
  parseLimitRows,
  pickDefaultDatabase,
  toDriverKind,
  TRANSFER_TYPE_KINDS,
  type TransferColumnDraft,
  transferConfirmSteps,
  validateTransferTarget,
  writesExistingTable,
  type TransferSource,
} from "./dataTransfer";
import { tableNameCollides } from "./resultsToTable";

/**
 * 接続間データ転送 (#986)。アクティブ接続のテーブル全件 / 単一クエリの結果を、
 * 別プロファイルの接続へスキーマ + データごと永続コピーする。
 *
 * 転送先プロファイルを選ぶと専用セッションを開き (スキーマ比較の適用と同じく
 * `read_only` はプロファイルから取る — 読み取り専用ならバックエンドが転送を拒否)、
 * DB 一覧とテーブル一覧を取得して衝突を判定する。実行は `transfer_data` の
 * ストリーミングで、進捗・キャンセルは export / dump と同じ流儀。判定の純ロジックは
 * `dataTransfer.ts`。
 */
interface Props {
  sourceSessionId: string;
  sourceProfileId: string | null;
  source: TransferSource;
  profiles: ConnectionProfile[];
  onClose: () => void;
}

const LOSSY_MESSAGE_KEYS = {
  decimal_clamped: "transferLossyDecimalClamped",
  decimal_float: "transferLossyDecimalFloat",
  timestamp_tz_degraded: "transferLossyTimestampTz",
} as const;

const TYPE_LABEL_KEYS: Record<TransferTypeKind, I18nKey> = {
  boolean: "transferTypeBoolean",
  integer: "transferTypeInteger",
  float: "transferTypeFloat",
  decimal: "transferTypeDecimal",
  text: "transferTypeText",
  date: "transferTypeDate",
  time: "transferTypeTime",
  timestamp: "transferTypeTimestamp",
  timestamptz: "transferTypeTimestamptz",
  binary: "transferTypeBinary",
  json: "transferTypeJson",
  uuid: "transferTypeUuid",
};

/** プレビューの再取得を遅らせる時間 (WHERE や列名の入力 1 文字ごとの往復を避ける)。 */
const PREVIEW_DEBOUNCE_MS = 300;

type Status = { kind: "idle" } | { kind: "running"; rows: number } | { kind: "error"; message: string };

export function DataTransferModal({ sourceSessionId, sourceProfileId, source, profiles, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [profileId, setProfileId] = useState("");
  const [targetSession, setTargetSession] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [database, setDatabase] = useState<string | null>(null);
  const [existingTables, setExistingTables] = useState<string[] | null>(null);
  const [tableName, setTableName] = useState(() => defaultTransferTableName(source));
  const [mode, setMode] = useState<TransferMode>("create");
  // upsert (#1539): 衝突方針とキー列 (空なら転送先テーブルの主キー)。
  const [conflictMode, setConflictMode] = useState<"update" | "skip">("update");
  const [keyColumnsInput, setKeyColumnsInput] = useState("");
  const [lossy, setLossy] = useState<TransferLossyConversion[]>([]);
  // 列の選択・改名・型上書き (#1623)。プレビューが返すソースの全列を元に編集する。
  const [sourceColumns, setSourceColumns] = useState<
    { name: string; sourceType: string; targetType: string }[]
  >([]);
  const [colDrafts, setColDrafts] = useState<Record<string, TransferColumnDraft>>({});
  const [whereClause, setWhereClause] = useState("");
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialRows, setTrialRows] = useState(String(DEFAULT_TRIAL_ROWS));
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const ownedSessionRef = useRef<string | null>(null);
  // 接続中にモーダルが閉じられた / 別のプロファイルが選ばれたときに、遅れて完了した
  // connect の結果 (専用セッション) を捨てて切断するための印。
  const unmountedRef = useRef(false);
  const selectSeqRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const targetProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId],
  );
  const isRunning = status.kind === "running";

  const releaseSession = useCallback(() => {
    const sid = ownedSessionRef.current;
    ownedSessionRef.current = null;
    if (sid) api.disconnect(sid).catch(() => {});
  }, []);

  // アンマウント時: 実行中の転送を止め、購読と専用セッションを片付ける。
  useEffect(() => {
    // StrictMode の再マウントでも「アンマウント済み」のままにならないよう、設定時に戻す。
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

  const selectProfile = useCallback(
    async (id: string) => {
      releaseSession();
      const seq = ++selectSeqRef.current;
      setProfileId(id);
      setTargetSession(null);
      setDatabases(null);
      setDatabase(null);
      setExistingTables(null);
      setConnectError(null);
      setStatus({ kind: "idle" });
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return;
      setConnecting(true);
      try {
        const res = await api.connect(
          // read_only はプロファイルから取る (読み取り専用ならバックエンドが転送を拒否する)。
          connectRequestFromProfile(profile),
        );
        if (unmountedRef.current || seq !== selectSeqRef.current) {
          // 接続待ちの間にモーダルが閉じられた / 別のプロファイルに切り替わった。
          // 誰も解放しない専用セッション (SSH トンネル含む) が残らないよう即切断する。
          api.disconnect(res.session_id).catch(() => {});
          return;
        }
        ownedSessionRef.current = res.session_id;
        setTargetSession(res.session_id);
        const dbs = await api.listDatabases(res.session_id).catch(() => [] as string[]);
        if (unmountedRef.current || seq !== selectSeqRef.current) return;
        setDatabases(dbs);
        setDatabase(pickDefaultDatabase(dbs, profile.database));
      } catch (e) {
        if (!unmountedRef.current && seq === selectSeqRef.current) setConnectError(String(e));
      } finally {
        if (!unmountedRef.current && seq === selectSeqRef.current) setConnecting(false);
      }
    },
    [profiles, releaseSession],
  );

  // 転送先 DB が決まったら既存テーブル一覧を取り、衝突判定に使う (ベストエフォート)。
  useEffect(() => {
    if (!targetSession || !database) {
      setExistingTables(null);
      return;
    }
    let cancelled = false;
    setExistingTables(null);
    api
      .listTables(targetSession, database)
      .then((tables) => {
        if (!cancelled) setExistingTables(tables);
      })
      .catch(() => {
        if (!cancelled) setExistingTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [targetSession, database]);

  // 転送先が決まったら、書き込み前に「値や型が変わる列」を調べて出す (#1532、ベストエフォート)。
  // 列定義と縮退の判定はバックエンド (転送本体と同じ型マッピング) が返す。
  const sourceTableName = source.kind === "table" ? source.table : null;
  const sourceSqlText = source.kind === "query" ? source.sql : null;
  const sourceDatabase = source.database;
  const columnSpecs = useMemo(
    () => buildTransferColumnSpecs(sourceColumns, colDrafts),
    [sourceColumns, colDrafts],
  );
  const specsKey = JSON.stringify(columnSpecs);
  const whereTrimmed = sourceTableName ? whereClause.trim() : "";
  const limitRows = trialEnabled ? parseLimitRows(trialRows) : null;
  const trialInvalid = trialEnabled && limitRows === null;
  const noColumns = allColumnsExcluded(sourceColumns, colDrafts);
  const badDecimals = invalidDecimalColumns(sourceColumns, colDrafts);
  useEffect(() => {
    setLossy([]);
    if (!targetSession || !database) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .previewTransfer({
          sourceSessionId,
          targetSessionId: targetSession,
          sourceDatabase,
          sourceTable: sourceTableName,
          sourceSql: sourceSqlText,
          targetDatabase: database,
          targetTable: "",
          mode: "create",
          columns: JSON.parse(specsKey),
          whereClause: whereTrimmed || null,
          limitRows,
        })
        .then((p) => {
          if (cancelled) return;
          setLossy(p.lossy);
          setPreviewError(null);
          setSourceColumns((prev) =>
            JSON.stringify(prev) === JSON.stringify(p.sourceColumns) ? prev : p.sourceColumns,
          );
        })
        .catch((e) => {
          if (!cancelled) setPreviewError(String(e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    sourceSessionId,
    sourceDatabase,
    sourceTableName,
    sourceSqlText,
    targetSession,
    database,
    specsKey,
    whereTrimmed,
    limitRows,
  ]);

  const updateDraft = (name: string, patch: Partial<TransferColumnDraft>) =>
    setColDrafts((cur) => ({ ...cur, [name]: { ...(cur[name] ?? defaultColumnDraft()), ...patch } }));

  const tableExists = existingTables ? tableNameCollides(existingTables, tableName) : false;
  const validation = validateTransferTarget({
    tableName,
    mode,
    existingTables,
    sameProfileAndDatabase:
      !!sourceProfileId && sourceProfileId === profileId && (source.database ?? "") === (database ?? ""),
    sameProfile: !!sourceProfileId && sourceProfileId === profileId,
    source,
    targetDriver: targetProfile ? toDriverKind(targetProfile.driver) : null,
  });
  const canRun =
    !!targetSession &&
    !!targetProfile &&
    !targetProfile.read_only &&
    !connecting &&
    existingTables !== null &&
    validation === null &&
    !trialInvalid &&
    !noColumns &&
    badDecimals.length === 0 &&
    !isRunning;

  const cleanupStream = () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamIdRef.current = null;
  };

  const run = async () => {
    if (!canRun || !targetSession || !targetProfile) return;
    const name = tableName.trim();
    const steps = transferConfirmSteps({
      mode,
      tableExists,
      isProduction: targetProfile.is_production,
    });
    for (const step of steps) {
      let ok = false;
      if (step === "replace") {
        ok = await confirm({
          title: t("transferReplaceConfirmTitle"),
          message: t("transferReplaceConfirmBody", { table: name, name: targetProfile.name }),
          confirmLabel: t("transferReplaceConfirmOk"),
          tone: "danger",
        });
      } else if (step === "productionTyped") {
        ok = await confirm({
          title: t("transferReplaceConfirmTitle"),
          message: t("transferProductionReplaceBody", { table: name, name: targetProfile.name }),
          confirmLabel: t("transferReplaceConfirmOk"),
          tone: "danger",
          typedConfirmation: targetProfile.name,
        });
      } else {
        ok = await confirm({
          title: t("productionConfirmTitle"),
          message: t("transferProductionConfirm", { table: name, name: targetProfile.name }),
          tone: "warning",
        });
      }
      if (!ok) return;
    }

    const streamId = makeTransferStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "running", rows: 0 });
    try {
      unlistenRef.current = await listenTransferStream(streamId, {
        onProgress: (e) => setStatus({ kind: "running", rows: e.rows }),
        onDone: (e) => {
          cleanupStream();
          setStatus({ kind: "idle" });
          toast.success(t("transferDone", { rows: e.rows, table: name, name: targetProfile.name }));
          // 件数照合の食い違い (#1623) は転送前には分からないので、完了時に別に知らせる。
          for (const detail of e.integrityWarnings) {
            toast.notify({
              message: t("transferIntegrityWarning", { detail }),
              tone: "info",
              severity: "warning",
            });
          }
          // 縮退の警告は転送前の Callout (翻訳済み) で示すので、完了時のトーストは出さない。
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
      await api.transferData(streamId, {
        sourceSessionId,
        targetSessionId: targetSession,
        sourceDatabase: source.database,
        sourceTable: source.kind === "table" ? source.table : null,
        sourceSql: source.kind === "query" ? source.sql : null,
        targetDatabase: database,
        targetTable: name,
        mode,
        columns: columnSpecs,
        whereClause: whereTrimmed || null,
        limitRows,
        ...(mode === "upsert"
          ? {
              conflictMode,
              keyColumns: keyColumnsInput
                .split(",")
                .map((k) => k.trim())
                .filter((k) => k !== ""),
            }
          : {}),
      });
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
    toast.info(
      writesExistingTable(mode)
        ? t("transferCancelledAppend", { rows: res?.deliveredRows ?? 0 })
        : t("transferCancelled"),
    );
  };

  const sourceLabel =
    source.kind === "table" ? t("transferSourceTable", { table: source.table }) : t("transferSourceQuery");
  // 「どこから → どこへ」を 1 行で見せる (コピー元の接続名が出ないと、どの DB から読むのか分からない)。
  const sourceProfileName = profiles.find((p) => p.id === sourceProfileId)?.name ?? null;
  const routeFrom = [
    sourceProfileName,
    source.database,
    source.kind === "table" ? source.table : t("transferRouteQuery"),
  ]
    .filter(Boolean)
    .join(" / ");
  const routeTo = targetProfile
    ? [targetProfile.name, database, tableName.trim() || null].filter(Boolean).join(" / ")
    : t("transferRoutePending");

  const validationMessage =
    validation === "tableExists"
      ? t("transferTableExists", { table: tableName.trim() })
      : validation === "tableMissing"
        ? t("transferTableMissing", { table: tableName.trim() })
        : validation === "sameTable"
          ? t("transferSameTable")
          : validation === "queryReadsTarget"
            ? t("transferQueryReadsTarget", { table: tableName.trim() })
            : null;

  return (
    <Modal
      onSubmit={() => void run()}
      submitDisabled={isRunning || !canRun}
      submitBusy={isRunning}
      width="600px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("transferClose")} closeDisabled={isRunning}>
        {t("transferTitle")}
      </ModalHeader>
      <StreamProgressBar active={isRunning} />
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight="normal">
          {t("transferNote")}
        </chakra.div>
        <chakra.div
          data-testid="transfer-route"
          fontFamily="mono"
          fontSize="sm"
          color="app.text"
          bg="app.surfaceMuted"
          borderRadius="md"
          px="3"
          py="2"
          wordBreak="break-all"
        >
          {routeFrom} → {routeTo}
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("transferSourceLabel")}</FieldLabel>
          <chakra.div fontSize="md" color="app.text">
            {sourceLabel}
          </chakra.div>
          {source.kind === "query" && <CodePreview maxH="120px">{source.sql}</CodePreview>}
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="transfer-target-profile">{t("transferTargetProfile")}</FieldLabel>
          <Flex align="center" gap="2">
            <ListboxSelect
              id="transfer-target-profile"
              css={{ flex: "1" }}
              value={profileId}
              options={[
                { value: "", label: t("transferSelectProfile") },
                ...profiles.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(v) => void selectProfile(v)}
              disabled={isRunning || connecting}
            />
            {connecting && <Spinner size={14} />}
          </Flex>
          {connectError && <FieldError>{t("transferConnectError", { error: connectError })}</FieldError>}
          {targetProfile?.read_only && <FieldError>{t("transferTargetReadOnly")}</FieldError>}
        </FormSection>

        {databases && databases.length > 0 && (
          <FormSection>
            <FieldLabel htmlFor="transfer-target-db">{t("transferTargetDatabase")}</FieldLabel>
            <ListboxSelect
              id="transfer-target-db"
              value={database ?? ""}
              options={databases.map((d) => ({ value: d }))}
              onChange={(v) => setDatabase(v || null)}
              disabled={isRunning}
              css={{ width: "100%" }}
            />
          </FormSection>
        )}

        <FormSection>
          <FieldLabel htmlFor="transfer-target-table">{t("transferTargetTable")}</FieldLabel>
          <Input
            id="transfer-target-table"
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            disabled={isRunning}
          />
          {validationMessage && <FieldError>{validationMessage}</FieldError>}
          {validation === "tableExists" && (
            <Flex gap="2" flexWrap="wrap">
              <Button type="button" size="sm" variant="secondary" onClick={() => setMode("append")}>
                {t("transferUseAppend")}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setMode("replace")}>
                {t("transferUseReplace")}
              </Button>
            </Flex>
          )}
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="transfer-mode">{t("transferModeLabel")}</FieldLabel>
          <ListboxSelect
            id="transfer-mode"
            value={mode}
            options={[
              { value: "create", label: t("transferModeCreate") },
              { value: "replace", label: t("transferModeReplace") },
              { value: "append", label: t("transferModeAppend") },
              { value: "upsert", label: t("transferModeUpsert") },
            ]}
            onChange={(v) => setMode(v as TransferMode)}
            disabled={isRunning}
            css={{ width: "100%" }}
          />
          <chakra.span fontSize="xs" color="app.textMuted">
            {mode === "upsert"
              ? t("transferModeUpsertHint")
              : mode === "append"
                ? t("transferModeAppendHint")
                : t("transferModeCreateHint")}
          </chakra.span>
        </FormSection>

        {mode === "upsert" && (
          <FormSection>
            <FieldLabel htmlFor="transfer-conflict-mode">{t("transferConflictMode")}</FieldLabel>
            <ListboxSelect
              id="transfer-conflict-mode"
              value={conflictMode}
              options={[
                { value: "update", label: t("transferConflictUpdate") },
                { value: "skip", label: t("transferConflictSkip") },
              ]}
              onChange={(v) => setConflictMode(v as "update" | "skip")}
              disabled={isRunning}
              css={{ width: "100%" }}
            />
            <FieldLabel htmlFor="transfer-key-columns">{t("transferKeyColumns")}</FieldLabel>
            <Input
              id="transfer-key-columns"
              value={keyColumnsInput}
              onChange={(e) => setKeyColumnsInput(e.target.value)}
              placeholder={t("transferKeyColumnsPlaceholder")}
              disabled={isRunning}
            />
            <chakra.span textStyle="caption" color="app.textMuted">
              {t("transferKeyColumnsHint")}
            </chakra.span>
          </FormSection>
        )}

        <FormSection>
          <FieldLabel as="div">{t("transferRangeLabel")}</FieldLabel>
          {source.kind === "table" && (
            <>
              <FieldLabel htmlFor="transfer-where">{t("transferWhereLabel")}</FieldLabel>
              <Input
                id="transfer-where"
                value={whereClause}
                onChange={(e) => setWhereClause(e.target.value)}
                placeholder={t("transferWherePlaceholder")}
                disabled={isRunning}
                fontFamily="mono"
              />
              {whereTrimmed && previewError && (
                <FieldError>{t("transferPreviewError", { error: previewError })}</FieldError>
              )}
            </>
          )}
          <chakra.label display="inline-flex" alignItems="center" gap="2" cursor="pointer" fontSize="md">
            <Checkbox
              checked={trialEnabled}
              onChange={(e) => setTrialEnabled(e.target.checked)}
              disabled={isRunning}
            />
            <span>{t("transferTrialLabel")}</span>
            {trialEnabled && (
              <Input
                w="96px"
                value={trialRows}
                onChange={(e) => setTrialRows(e.target.value)}
                aria-label={t("transferTrialRows")}
                disabled={isRunning}
                inputMode="numeric"
              />
            )}
          </chakra.label>
          {trialInvalid && <FieldError>{t("transferTrialInvalid")}</FieldError>}
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("transferTrialHint")}
          </chakra.span>
        </FormSection>

        {sourceColumns.length > 0 && (
          <FormSection>
            <FieldLabel as="div">{t("transferColumnsLabel")}</FieldLabel>
            <chakra.div
              display="flex"
              flexDirection="column"
              gap="1.5"
              maxH="220px"
              overflowY="auto"
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
              p="2"
            >
              <chakra.div
                display="flex"
                alignItems="center"
                gap="2"
                textStyle="caption"
                color="app.textMuted"
                borderBottom="1px solid"
                borderColor="app.border"
                pb="1"
              >
                <Checkbox
                  checked={sourceColumns.every((c) => (colDrafts[c.name] ?? defaultColumnDraft()).include)}
                  onChange={(e) => {
                    const include = e.target.checked;
                    setColDrafts((cur) =>
                      Object.fromEntries(
                        sourceColumns.map((c) => [
                          c.name,
                          { ...(cur[c.name] ?? defaultColumnDraft()), include },
                        ]),
                      ),
                    );
                  }}
                  disabled={isRunning}
                  aria-label={t("transferColumnsAll")}
                />
                <chakra.span flex="1" minW="100px">
                  {t("transferColumnsHeadSource")}
                </chakra.span>
                <chakra.span w="130px">{t("transferColumnsHeadName")}</chakra.span>
                {!writesExistingTable(mode) && (
                  <chakra.span w="150px">{t("transferColumnsHeadType")}</chakra.span>
                )}
              </chakra.div>
              {sourceColumns.map((c) => {
                const d = colDrafts[c.name] ?? defaultColumnDraft();
                const typeEditable = !writesExistingTable(mode);
                return (
                  <chakra.div
                    key={c.name}
                    data-testid="transfer-column-row"
                    display="flex"
                    alignItems="center"
                    gap="2"
                    flexWrap="wrap"
                  >
                    <Checkbox
                      checked={d.include}
                      onChange={(e) => updateDraft(c.name, { include: e.target.checked })}
                      disabled={isRunning}
                      aria-label={t("transferColumnInclude", { column: c.name })}
                    />
                    <chakra.span
                      flex="1"
                      minW="100px"
                      fontFamily="mono"
                      fontSize="sm"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      title={c.sourceType}
                    >
                      {c.name}
                      <chakra.span ml="1.5" fontFamily="body" fontSize="2xs" color="app.textMuted">
                        {c.sourceType}
                      </chakra.span>
                    </chakra.span>
                    <Input
                      w="130px"
                      value={d.name}
                      placeholder={c.name}
                      onChange={(e) => updateDraft(c.name, { name: e.target.value })}
                      aria-label={t("transferColumnRename", { column: c.name })}
                      disabled={isRunning || !d.include}
                    />
                    {typeEditable && (
                      <ListboxSelect
                        css={{ width: "150px" }}
                        value={d.type}
                        options={[
                          { value: "auto", label: t("transferTypeAuto", { type: c.targetType }) },
                          ...TRANSFER_TYPE_KINDS.map((k) => ({ value: k, label: t(TYPE_LABEL_KEYS[k]) })),
                        ]}
                        onChange={(v) => updateDraft(c.name, { type: v as TransferColumnDraft["type"] })}
                        ariaLabel={t("transferColumnType", { column: c.name })}
                        disabled={isRunning || !d.include}
                      />
                    )}
                    {typeEditable && d.type === "decimal" && (
                      <chakra.span
                        display="inline-flex"
                        alignItems="center"
                        gap="1"
                        textStyle="caption"
                        color="app.textMuted"
                      >
                        <DraftNumberInput
                          min={1}
                          max={65}
                          w="56px"
                          value={d.precision}
                          aria-label={t("transferDecimalPrecision", { column: c.name })}
                          disabled={isRunning}
                          onCommit={(n) => updateDraft(c.name, { precision: n })}
                        />
                        ,
                        <DraftNumberInput
                          min={0}
                          max={30}
                          w="56px"
                          value={d.scale}
                          aria-label={t("transferDecimalScale", { column: c.name })}
                          disabled={isRunning}
                          onCommit={(n) => updateDraft(c.name, { scale: n })}
                        />
                      </chakra.span>
                    )}
                  </chakra.div>
                );
              })}
            </chakra.div>
            {noColumns && <FieldError>{t("transferAllColumnsExcluded")}</FieldError>}
            {badDecimals.map((name) => (
              <FieldError key={name}>{t("transferDecimalScaleTooLarge", { column: name })}</FieldError>
            ))}
            <chakra.span textStyle="caption" color="app.textMuted">
              {writesExistingTable(mode) ? t("transferColumnsHintAppend") : t("transferColumnsHint")}
            </chakra.span>
          </FormSection>
        )}

        {lossy.length > 0 && !writesExistingTable(mode) && !isRunning && (
          <Callout tone="warning" title={t("transferLossyTitle")} role="status">
            <chakra.ul listStyleType="disc" pl="4" m="0">
              {lossy.map((l) => (
                <li key={`${l.column}:${l.kind}`}>
                  {t(LOSSY_MESSAGE_KEYS[l.kind], {
                    column: l.column,
                    source: l.sourceType,
                    target: l.targetType,
                  })}
                </li>
              ))}
            </chakra.ul>
          </Callout>
        )}

        {isRunning && (
          <chakra.div fontSize="sm" color="app.text" textStyle="numeric">
            {t("transferProgress", { rows: status.rows })}
          </chakra.div>
        )}
        {status.kind === "error" && <ErrorNote>{t("transferError", { error: status.message })}</ErrorNote>}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        {isRunning ? (
          <Button type="button" variant="secondary" onClick={() => void cancelRun()}>
            {t("transferCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("transferClose")}
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
          {isRunning ? t("transferRunning") : t("transferExecute")}
        </LoadingButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
