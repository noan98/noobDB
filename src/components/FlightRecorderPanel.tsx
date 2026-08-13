import { useEffect, useState } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import { api, UndoConflict, WriteCaptureSummary } from "../api/tauri";
import { useT } from "../i18n";
import { EmptyState } from "./EmptyState";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, PressableButton } from "./ui";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";

/**
 * DML フライトレコーダ (#735) の一覧・巻き戻しパネル。`HistoryList` のツール
 * バーから開く独立モーダルとして実装している — 通常の履歴 (`query_history`)
 * とは別のローカル専用ストア (`flight_recorder.sqlite`) を持つため、既存の
 * 履歴行に統合するのではなく専用の一覧を持たせる方が、両ストアの ID を
 * 突き合わせる余計な結合を増やさずに済む (設計判断。PR 本文にも記載)。
 *
 * Undo は「プレビュー (副作用なし) → 確認ダイアログ → 適用」の 2 段階。
 * バックエンドの `preview_undo` / `undo_flight_record` が競合検査と逆 SQL
 * 生成を担い、ここは結果の表示と確認フローに徹する。適用は既存の
 * `run_query_transaction` 経路 (read-only ガード・履歴記録込み) を通るため、
 * このパネル自身は安全網を一切バイパスしない。
 */

interface Props {
  profileId: string | null;
  /** 巻き戻しの適用先セッション。未接続 (null) のときは一覧のみ閲覧可で
   *  Undo ボタンは無効化される。ドライバ不一致は適用時にバックエンドが
   *  `InvalidInput` で拒否する。 */
  sessionId: string | null;
  onClose: () => void;
}

function formatCaptured(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const KIND_ICON: Record<WriteCaptureSummary["kind"], IconName> = {
  insert: "plus",
  update: "columns",
  delete: "close",
  other: "query",
};

function ConflictList({ conflicts, t }: { conflicts: UndoConflict[]; t: ReturnType<typeof useT> }) {
  return (
    <chakra.ul m={0} mt="2" p={0} pl="4" fontSize="xs" fontFamily="mono" maxHeight="160px" overflowY="auto">
      {conflicts.slice(0, 20).map((c, i) => (
        <chakra.li key={i}>
          {t("flightRecorderConflictKey", { key: JSON.stringify(c.key) })}
          {" — "}
          {c.current === null ? t("flightRecorderConflictGone") : t("flightRecorderConflictDrifted")}
        </chakra.li>
      ))}
      {conflicts.length > 20 && (
        <chakra.li>{t("flightRecorderConflictMore", { count: conflicts.length - 20 })}</chakra.li>
      )}
    </chakra.ul>
  );
}

export function FlightRecorderPanel({ profileId, sessionId, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [showAll, setShowAll] = useState(!profileId);
  const [entries, setEntries] = useState<WriteCaptureSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const scopeId = showAll ? null : profileId;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listFlightRecords(scopeId)
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId, reloadKey]);

  const handleUndo = async (entry: WriteCaptureSummary) => {
    if (!sessionId) return;
    setBusyId(entry.id);
    try {
      const preview = await api.previewUndo(sessionId, entry.id);
      if (preview.statements.length === 0 && preview.conflicts.length === 0) {
        toast.info(t("flightRecorderNothingToUndo"));
        return;
      }
      const message = (
        <Box>
          <chakra.p m={0}>{t("flightRecorderUndoConfirmBody", { table: entry.table })}</chakra.p>
          <chakra.pre
            m={0}
            mt="2"
            p="2"
            fontSize="xs"
            fontFamily="mono"
            whiteSpace="pre-wrap"
            maxHeight="160px"
            overflowY="auto"
            bg="app.surfaceMuted"
            borderRadius="sm"
          >
            {preview.statements.join(";\n") || t("flightRecorderNoStatements")}
          </chakra.pre>
          {preview.conflicts.length > 0 && (
            <>
              <chakra.p m={0} mt="2" color="app.textError" fontWeight={600}>
                {t("flightRecorderConflictsFound", { count: preview.conflicts.length })}
              </chakra.p>
              <ConflictList conflicts={preview.conflicts} t={t} />
            </>
          )}
        </Box>
      );
      const ok = await confirm({
        title: t("flightRecorderUndoConfirmTitle"),
        message,
        confirmLabel:
          preview.conflicts.length > 0 ? t("flightRecorderForceApply") : t("flightRecorderApply"),
        tone: preview.conflicts.length > 0 ? "danger" : "warning",
      });
      if (!ok) return;

      const outcome = await api.undoFlightRecord(sessionId, entry.id, preview.conflicts.length > 0);
      if (outcome.applied) {
        toast.success(t("flightRecorderUndoApplied", { rows: outcome.rowsAffected }));
        setReloadKey((k) => k + 1);
      } else {
        toast.error(t("flightRecorderUndoBlocked"));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 記録の全消去 (#907)。バックエンドの `clear_flight_records` は #735 から
   * 存在していたが UI 導線が無く、`api.clearFlightRecords` が UI から到達不能な
   * ラッパーになっていた。`HistoryList` の「履歴をクリア」と同じく、現在の
   * 表示スコープ (この接続のみ / 全接続) をそのまま消去対象にする。
   */
  const handleClear = async () => {
    const ok = await confirm({
      title: t("flightRecorderClear"),
      message: scopeId
        ? t("flightRecorderClearConfirmProfile")
        : t("flightRecorderClearConfirmAll"),
      confirmLabel: t("flightRecorderClear"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      const removed = await api.clearFlightRecords(scopeId);
      toast.info(t("flightRecorderCleared", { count: removed }));
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal onClose={onClose} width="820px">
      <ModalHeader onClose={onClose} closeLabel={t("flightRecorderClose")}>
        {t("flightRecorderTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="2" minHeight="50vh">
        <chakra.p m={0} fontSize="xs" color="app.textMuted">
          {t("flightRecorderIntro")}
        </chakra.p>
        {profileId && (
          <Flex align="center" gap="1.5" fontSize="xs" color="app.textSecondary">
            <chakra.input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              id="flight-recorder-show-all"
            />
            <chakra.label htmlFor="flight-recorder-show-all" cursor="pointer">
              {t("historyShowAll")}
            </chakra.label>
          </Flex>
        )}
        <Box flex="1" minHeight={0} overflowY="auto" border="1px solid" borderColor="app.border" borderRadius="md">
          {error ? (
            <chakra.p m={0} p="3" color="app.textError">
              {error}
            </chakra.p>
          ) : loading ? (
            <chakra.p m={0} p="3" fontSize="sm" color="app.textMuted">
              {t("flightRecorderLoading")}
            </chakra.p>
          ) : entries.length === 0 ? (
            <EmptyState icon="clock" title={t("flightRecorderEmptyTitle")} description={t("flightRecorderEmpty")} />
          ) : (
            <chakra.ul m={0} p={0} listStyleType="none">
              {entries.map((entry) => (
                <chakra.li
                  key={entry.id}
                  display="flex"
                  alignItems="center"
                  gap="2"
                  px="3"
                  py="2"
                  borderBottom="1px solid"
                  borderColor="app.border"
                >
                  <Icon name={KIND_ICON[entry.kind]} size={ICON_SIZES.sm} aria-hidden />
                  <Box flex="1" minWidth={0}>
                    <Tooltip label={entry.sql}>
                      <chakra.div
                        fontFamily="mono"
                        fontSize="sm"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {oneLine(entry.sql)}
                      </chakra.div>
                    </Tooltip>
                    <chakra.div fontSize="2xs" color="app.textMuted">
                      {entry.table} · {formatCaptured(entry.captured_at)} ·{" "}
                      {t("flightRecorderRowsAffected", { rows: entry.rows_affected })}
                      {entry.undone && ` · ${t("flightRecorderUndoneBadge")}`}
                    </chakra.div>
                  </Box>
                  <PressableButton
                    type="button"
                    variant="secondary"
                    disabled={!sessionId || entry.undone || busyId === entry.id}
                    onClick={() => void handleUndo(entry)}
                  >
                    <Icon name="undo" size={ICON_SIZES.sm} />{" "}
                    {busyId === entry.id ? t("flightRecorderUndoing") : t("flightRecorderUndoAction")}
                  </PressableButton>
                </chakra.li>
              ))}
            </chakra.ul>
          )}
        </Box>
        {!sessionId && entries.length > 0 && (
          <chakra.p m={0} fontSize="xs" color="app.textMuted">
            {t("flightRecorderNeedConnection")}
          </chakra.p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          variant="danger"
          disabled={loading || entries.length === 0}
          onClick={() => void handleClear()}
        >
          {t("flightRecorderClear")}
        </Button>
        <Box flex="1" />
        <Button variant="primary" onClick={onClose}>
          {t("flightRecorderClose")}
        </Button>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
