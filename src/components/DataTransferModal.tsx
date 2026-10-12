import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenTransferStream,
  type ConnectionProfile,
  type TransferLossyConversion,
  type TransferMode,
} from "../api/tauri";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Callout } from "./Callout";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, Select } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Spinner } from "./Spinner";
import { StreamProgressBar } from "./StreamProgressBar";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import {
  defaultTransferTableName,
  makeTransferStreamId,
  pickDefaultDatabase,
  toDriverKind,
  transferConfirmSteps,
  validateTransferTarget,
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

type Status =
  | { kind: "idle" }
  | { kind: "running"; rows: number }
  | { kind: "error"; message: string };

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
  const [lossy, setLossy] = useState<TransferLossyConversion[]>([]);
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
        const res = await api.connect({
          profile_id: profile.id,
          driver: toDriverKind(profile.driver) ?? "mysql",
          host: profile.host,
          port: profile.port,
          user: profile.user,
          password: "",
          database: profile.database,
          ssh: profile.ssh ? { ...profile.ssh, passphrase: "" } : null,
          file_path: profile.file_path,
          // read_only はプロファイルから取る (読み取り専用ならバックエンドが転送を拒否する)。
          read_only: profile.read_only,
          skip_history: profile.skip_history,
        });
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
  useEffect(() => {
    setLossy([]);
    if (!targetSession || !database) return;
    let cancelled = false;
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
      })
      .then((p) => {
        if (!cancelled) setLossy(p.lossy);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceSessionId, sourceDatabase, sourceTableName, sourceSqlText, targetSession, database]);

  const tableExists = existingTables ? tableNameCollides(existingTables, tableName) : false;
  const validation = validateTransferTarget({
    tableName,
    mode,
    existingTables,
    sameProfileAndDatabase:
      !!sourceProfileId && sourceProfileId === profileId && (source.database ?? "") === (database ?? ""),
    source,
  });
  const canRun =
    !!targetSession &&
    !!targetProfile &&
    !targetProfile.read_only &&
    !connecting &&
    existingTables !== null &&
    validation === null &&
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
      mode === "append"
        ? t("transferCancelledAppend", { rows: res?.deliveredRows ?? 0 })
        : t("transferCancelled"),
    );
  };

  const sourceLabel =
    source.kind === "table"
      ? t("transferSourceTable", { table: source.table })
      : t("transferSourceQuery");

  const validationMessage =
    validation === "tableExists"
      ? t("transferTableExists", { table: tableName.trim() })
      : validation === "tableMissing"
        ? t("transferTableMissing", { table: tableName.trim() })
        : validation === "sameTable"
          ? t("transferSameTable")
          : null;

  return (
    <Modal
      onSubmit={() => void run()}
      submitDisabled={isRunning || !canRun}
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
            <Select
              id="transfer-target-profile"
              flex="1"
              value={profileId}
              onChange={(e) => void selectProfile(e.target.value)}
              disabled={isRunning || connecting}
            >
              <option value="">{t("transferSelectProfile")}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {connecting && <Spinner size={14} />}
          </Flex>
          {connectError && <FieldError>{t("transferConnectError", { error: connectError })}</FieldError>}
          {targetProfile?.read_only && <FieldError>{t("transferTargetReadOnly")}</FieldError>}
        </FormSection>

        {databases && databases.length > 0 && (
          <FormSection>
            <FieldLabel htmlFor="transfer-target-db">{t("transferTargetDatabase")}</FieldLabel>
            <Select
              id="transfer-target-db"
              value={database ?? ""}
              onChange={(e) => setDatabase(e.target.value || null)}
              disabled={isRunning}
            >
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
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
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="transfer-mode">{t("transferModeLabel")}</FieldLabel>
          <Select
            id="transfer-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as TransferMode)}
            disabled={isRunning}
          >
            <option value="create">{t("transferModeCreate")}</option>
            <option value="replace">{t("transferModeReplace")}</option>
            <option value="append">{t("transferModeAppend")}</option>
          </Select>
          <chakra.span fontSize="xs" color="app.textMuted">
            {mode === "append" ? t("transferModeAppendHint") : t("transferModeCreateHint")}
          </chakra.span>
        </FormSection>

        {lossy.length > 0 && mode !== "append" && !isRunning && (
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
