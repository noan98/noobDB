import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import { Box, chakra, Flex } from "@chakra-ui/react";
import { api, UndoConflict, WriteCaptureSummary } from "../api/tauri";
import { localizedErrorMessage } from "../errorHints";
import { useT } from "../i18n";
import { EmptyState } from "./EmptyState";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview } from "./modalForm";
import { Button, PressableButton } from "./ui";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";
import { batchUndoIsPartial } from "../flightRecorder";
import { reducedMotionActive, staggerContainer, variants } from "../motion";
import { prefersStaticMotion } from "./revealOrigin";

/**
 * 記録一覧の入場 (#1875): `staggerContainer` / `variants.staggerItem` で先頭 `STAGGER_CAP` 件だけ
 * 順次フェードインする (件数が多い一覧を全件遅延させると体感が重いため、残りは即時表示)。
 * Undo / Redo の適用に成功した行は `apply-flash` (`.flash-ring`) で一度だけ光らせ、「取消済み」
 * バッジは `variants.slideUp` で出入りする。静止化は `useReducedMotion()` (stagger) と
 * `reducedMotionActive()` / `prefersStaticMotion()` (フラッシュ。ハイコントラスト / forced-colors 含む)。
 */
const STAGGER_CAP = 20;
/** `apply-flash` の再生時間 (App.css の `.flash-ring::after` の 0.7s) に合わせる。 */
const FLASH_MS = 700;

const MotionUl = chakra(motion.ul, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionLi = chakra(motion.li, {}, { forwardProps: ["variants"] });
const MotionBadge = chakra(motion.span, {}, { forwardProps: ["variants", "initial", "animate", "exit"] });

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
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reduced = useReducedMotion() ?? false;
  // 適用に成功した行の id。`FLASH_MS` 後に外す。
  const [flashIds, setFlashIds] = useState<ReadonlySet<number>>(() => new Set());
  const flashTimer = useRef<number | null>(null);
  const loadedScope = useRef<string | null | undefined>(undefined);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const flashRows = (ids: number[]) => {
    if (reducedMotionActive() || prefersStaticMotion() || ids.length === 0) return;
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlashIds(new Set(ids));
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlashIds(new Set());
    }, FLASH_MS);
  };

  const scopeId = showAll ? null : profileId;

  // 同じバッチ (複数文スクリプト / UPSERT) の記録 (#1626)。2 件以上あるものだけをバッチとして扱い、
  // 一覧の最も新しい行にだけ「バッチを巻き戻す」を出す。
  const batches = useMemo(() => {
    const map = new Map<string, { count: number; allUndone: boolean; firstId: number }>();
    for (const e of entries) {
      if (!e.batch_id) continue;
      const cur = map.get(e.batch_id);
      if (cur) {
        cur.count += 1;
        cur.allUndone = cur.allUndone && e.undone;
      } else {
        map.set(e.batch_id, { count: 1, allUndone: e.undone, firstId: e.id });
      }
    }
    for (const [k, v] of map) if (v.count < 2) map.delete(k);
    return map;
  }, [entries]);
  const hasPinned = entries.some((e) => e.pinned);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey の変化で再読み込みするトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    let cancelled = false;
    // 適用後の再読み込みでは一覧を「読み込み中」に差し替えない (行が作り直されて、フラッシュと
    // 入場が再生し直しになるため)。範囲を切り替えたときだけ読み込み表示にする。
    if (loadedScope.current !== scopeId) setLoading(true);
    api
      .listFlightRecords(scopeId)
      .then((rows) => {
        if (!cancelled) {
          loadedScope.current = scopeId;
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

  // Undo (巻き戻し) と Redo (やり直し, #1536) は同じ「プレビュー → 確認 → 適用」の流れで、
  // 呼ぶ IPC と文言だけが違う。
  const handleApply = async (entry: WriteCaptureSummary, mode: "undo" | "redo") => {
    if (!sessionId) return;
    const redo = mode === "redo";
    setBusyId(entry.id);
    try {
      const preview = redo
        ? await api.previewRedo(sessionId, entry.id)
        : await api.previewUndo(sessionId, entry.id);
      if (preview.statements.length === 0 && preview.conflicts.length === 0) {
        // 目的の状態が既に成立している (行が既に無い・手動で戻し済みなど)。警告が無ければ
        // 適用 API を呼んで記録を取り消し済み / やり直し済みにする。そうしないと記録が
        // 永久に未取り消しのまま残り、押すたびに同じ通知が出るだけになる (#1600)。
        if (preview.warnings.length === 0) {
          const settled = redo
            ? await api.redoFlightRecord(sessionId, entry.id, false)
            : await api.undoFlightRecord(sessionId, entry.id, false);
          if (settled.applied) {
            flashRows([entry.id]);
            setReloadKey((k) => k + 1);
          }
          for (const w of settled.warnings ?? []) toast.info(w, 8000);
          if (settled.applied && settled.rowsAffected > 0) {
            toast.success(
              t(redo ? "flightRecorderRedoApplied" : "flightRecorderUndoApplied", {
                rows: settled.rowsAffected,
              }),
            );
          } else {
            toast.info(
              t(
                settled.applied
                  ? "flightRecorderAlreadyRestored"
                  : redo
                    ? "flightRecorderNothingToRedo"
                    : "flightRecorderNothingToUndo",
              ),
            );
          }
          return;
        }
        toast.info(t(redo ? "flightRecorderNothingToRedo" : "flightRecorderNothingToUndo"));
        return;
      }
      const message = (
        <Box>
          <chakra.p m={0}>
            {t(redo ? "flightRecorderRedoConfirmBody" : "flightRecorderUndoConfirmBody", {
              table: entry.table,
            })}
          </chakra.p>
          <CodePreview wrap mt="2" maxH="160px">
            {preview.statements.join(";\n") || t("flightRecorderNoStatements")}
          </CodePreview>
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
        title: t(redo ? "flightRecorderRedoConfirmTitle" : "flightRecorderUndoConfirmTitle"),
        message,
        confirmLabel: preview.conflicts.length > 0 ? t("flightRecorderForceApply") : t("flightRecorderApply"),
        tone: preview.conflicts.length > 0 ? "danger" : "warning",
      });
      if (!ok) return;

      const force = preview.conflicts.length > 0;
      if (force) {
        // 強制適用はバックエンドが適用時に計画を組み直し、競合行をすべて上書きする。確認
        // ダイアログを開いている間に増えた競合は一度も表示されていないので、適用の直前に
        // もう一度プレビューを取り、表示済みでない競合が現れていたら中止する (#1600)。
        const fresh = redo
          ? await api.previewRedo(sessionId, entry.id)
          : await api.previewUndo(sessionId, entry.id);
        // キーだけでなく現在値も比べる (同じ行が別の値へ変わった場合も、表示した内容と違う)。
        const sig = (c: (typeof preview.conflicts)[number]) => JSON.stringify([c.key, c.current]);
        const shown = new Set(preview.conflicts.map(sig));
        if (fresh.conflicts.some((c) => !shown.has(sig(c)))) {
          toast.error(t("flightRecorderConflictsChanged"));
          return;
        }
      }
      const outcome = redo
        ? await api.redoFlightRecord(sessionId, entry.id, force)
        : await api.undoFlightRecord(sessionId, entry.id, force);
      if (outcome.applied) {
        if (outcome.rowsAffected > 0) {
          toast.success(
            t(redo ? "flightRecorderRedoApplied" : "flightRecorderUndoApplied", {
              rows: outcome.rowsAffected,
            }),
          );
        } else {
          toast.info(t("flightRecorderAlreadyRestored"));
        }
        flashRows([entry.id]);
        setReloadKey((k) => k + 1);
        // 逆 SQL は適用済みだが記録の状態を保存できなかった等の警告を利用者へ伝える (#1600)。
        for (const w of outcome.warnings ?? []) toast.info(w, 8000);
      } else {
        toast.error(t("flightRecorderUndoBlocked"));
      }
    } catch (e) {
      toast.error(localizedErrorMessage(e, t));
    } finally {
      setBusyId(null);
    }
  };

  // 取り消し / やり直しの SQL を .sql に保存する (#1626)。適用はしない。
  const handleExportPlan = async (entry: WriteCaptureSummary, batchId: string | null) => {
    if (!sessionId) return;
    try {
      const path = await save({
        defaultPath: batchId ? `undo-batch-${batchId}.sql` : `undo-${entry.table}-${entry.id}.sql`,
        title: t("flightRecorderExportPlanAction"),
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (typeof path !== "string" || !path) return;
      const out = await api.exportFlightPlanSql({
        sessionId,
        id: batchId ? null : entry.id,
        batchId,
        redo: batchId ? (batches.get(batchId)?.allUndone ?? false) : entry.undone,
        force: false,
        path,
      });
      toast.success(t("flightRecorderExportPlanDone", { statements: out.statements, path }));
      if (out.conflicts > 0)
        toast.info(t("flightRecorderExportPlanConflicts", { conflicts: out.conflicts }), 8000);
    } catch (e) {
      toast.error(localizedErrorMessage(e, t));
    }
  };

  // 一覧の記録を CSV / NDJSON に書き出す (#1626)。形式は保存先の拡張子で決める。
  const handleExportRecords = async () => {
    try {
      const path = await save({
        defaultPath: "flight-records.csv",
        title: t("flightRecorderExportRecordsAction"),
        filters: [
          { name: "CSV", extensions: ["csv"] },
          { name: "NDJSON", extensions: ["ndjson"] },
        ],
      });
      if (typeof path !== "string" || !path) return;
      const format = path.toLowerCase().endsWith(".ndjson") ? "ndjson" : "csv";
      const count = await api.exportFlightRecords({
        path,
        format,
        ids: entries.map((e) => e.id),
      });
      toast.success(t("flightRecorderExportRecordsDone", { count, path }));
    } catch (e) {
      toast.error(localizedErrorMessage(e, t));
    }
  };

  const handleTogglePin = async (entry: WriteCaptureSummary) => {
    try {
      await api.pinFlightRecord(entry.id, !entry.pinned);
      setEntries((rows) => rows.map((r) => (r.id === entry.id ? { ...r, pinned: !entry.pinned } : r)));
    } catch (e) {
      toast.error(t("flightRecorderPinFailed", { error: localizedErrorMessage(e, t) }));
    }
  };

  // バッチ (#1626) の取り消し / やり直し。単発と同じ「プレビュー → 確認 → 適用」だが、
  // 全記録の逆 SQL を 1 つのトランザクションで適用する。
  const batchEntryIds = (batchId: string) => entries.filter((e) => e.batch_id === batchId).map((e) => e.id);

  const handleApplyBatch = async (batchId: string, mode: "undo" | "redo") => {
    if (!sessionId) return;
    const redo = mode === "redo";
    const count = batches.get(batchId)?.count ?? 0;
    setBusyBatch(batchId);
    try {
      const preview = await api.previewFlightBatch(sessionId, batchId, redo);
      if (preview.statements.length === 0 && preview.conflicts.length === 0) {
        if (preview.warnings.length === 0) {
          const settled = await api.applyFlightBatch(sessionId, batchId, false, redo);
          if (settled.applied) {
            flashRows(batchEntryIds(batchId));
            setReloadKey((k) => k + 1);
          }
          toast.info(t(settled.applied ? "flightRecorderAlreadyRestored" : "flightRecorderNothingToUndo"));
          return;
        }
        toast.info(t(redo ? "flightRecorderNothingToRedo" : "flightRecorderNothingToUndo"));
        return;
      }
      const ok = await confirm({
        title: t(redo ? "flightRecorderBatchRedoConfirmTitle" : "flightRecorderBatchUndoConfirmTitle"),
        message: (
          <Box>
            <chakra.p m={0}>
              {t(redo ? "flightRecorderBatchRedoConfirmBody" : "flightRecorderBatchUndoConfirmBody", {
                count: preview.recordIds.length || count,
              })}
            </chakra.p>
            <CodePreview wrap mt="2" maxH="160px">
              {preview.statements.join(";\n") || t("flightRecorderNoStatements")}
            </CodePreview>
            {!redo && batchUndoIsPartial(batchId, preview.recordIds.length) && (
              <chakra.p m={0} mt="2" color="app.textWarning" textStyle="caption">
                {t("flightRecorderBatchPartialNote")}
              </chakra.p>
            )}
            {preview.conflicts.length > 0 && (
              <>
                <chakra.p m={0} mt="2" color="app.textError" fontWeight={600}>
                  {t("flightRecorderConflictsFound", { count: preview.conflicts.length })}
                </chakra.p>
                <ConflictList conflicts={preview.conflicts} t={t} />
                <chakra.p m={0} mt="2" textStyle="caption">
                  {t("flightRecorderBatchOverlapHint")}
                </chakra.p>
              </>
            )}
          </Box>
        ),
        confirmLabel: preview.conflicts.length > 0 ? t("flightRecorderForceApply") : t("flightRecorderApply"),
        tone: preview.conflicts.length > 0 ? "danger" : "warning",
      });
      if (!ok) return;
      const force = preview.conflicts.length > 0;
      if (force) {
        // 確認中に増えた競合を、見せないまま上書きしない (単発の強制適用と同じ)。
        const fresh = await api.previewFlightBatch(sessionId, batchId, redo);
        const sig = (c: (typeof preview.conflicts)[number]) => JSON.stringify([c.key, c.current]);
        const shown = new Set(preview.conflicts.map(sig));
        if (fresh.conflicts.some((c) => !shown.has(sig(c)))) {
          toast.error(t("flightRecorderConflictsChanged"));
          return;
        }
      }
      const outcome = await api.applyFlightBatch(sessionId, batchId, force, redo);
      if (outcome.applied) {
        if (outcome.rowsAffected > 0) {
          toast.success(
            t(redo ? "flightRecorderRedoApplied" : "flightRecorderUndoApplied", {
              rows: outcome.rowsAffected,
            }),
          );
        } else {
          toast.info(t("flightRecorderAlreadyRestored"));
        }
        flashRows(batchEntryIds(batchId));
        setReloadKey((k) => k + 1);
        for (const w of outcome.warnings ?? []) toast.info(w, 8000);
      } else {
        toast.error(t("flightRecorderUndoBlocked"));
      }
    } catch (e) {
      toast.error(localizedErrorMessage(e, t));
    } finally {
      setBusyBatch(null);
    }
  };

  const handleClear = async () => {
    const ok = await confirm({
      title: t("flightRecorderClearAction"),
      message: `${scopeId ? t("flightRecorderClearConfirmProfile") : t("flightRecorderClearConfirmAll")}${
        hasPinned ? ` ${t("flightRecorderClearKeepsPinned")}` : ""
      }`,
      confirmLabel: t("flightRecorderClearAction"),
      tone: "danger",
    });
    if (!ok) return;
    setClearing(true);
    try {
      await api.clearFlightRecords(scopeId);
      // ピン留めした記録は残る (#1626) ので、空にせず取り直す。
      setReloadKey((k) => k + 1);
      setError(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setClearing(false);
    }
  };

  return (
    <Modal
      // no-submit: 閲覧画面 (閉じるのみ)。Undo は行ごとの確認ダイアログを通す
      onClose={onClose}
      width="820px"
    >
      <ModalHeader onClose={onClose} closeLabel={t("flightRecorderClose")}>
        {t("flightRecorderTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="2" minHeight="50vh">
        <chakra.p m={0} textStyle="caption">
          {t("flightRecorderIntro")}
        </chakra.p>
        <Flex align="center" justify="space-between" gap="2" flexWrap="wrap">
          {profileId ? (
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
          ) : (
            <Box />
          )}
          {entries.length > 0 && (
            <Flex align="center" gap="2">
              <Tooltip label={t("flightRecorderExportRecordsTip")}>
                <PressableButton type="button" variant="secondary" onClick={() => void handleExportRecords()}>
                  <Icon name="download" size={ICON_SIZES.sm} /> {t("flightRecorderExportRecordsAction")}
                </PressableButton>
              </Tooltip>
              <PressableButton
                type="button"
                variant="danger"
                onClick={() => void handleClear()}
                disabled={clearing}
              >
                {t("flightRecorderClearAction")}
              </PressableButton>
            </Flex>
          )}
        </Flex>
        <Box
          flex="1"
          minHeight={0}
          overflowY="auto"
          border="1px solid"
          borderColor="app.border"
          borderRadius="md"
        >
          {error ? (
            <chakra.p m={0} p="3" color="app.textError">
              {error}
            </chakra.p>
          ) : loading ? (
            <chakra.p m={0} p="3" textStyle="body" color="app.textMuted">
              {t("flightRecorderLoading")}
            </chakra.p>
          ) : entries.length === 0 ? (
            <EmptyState
              icon="clock"
              title={t("flightRecorderEmptyTitle")}
              description={t("flightRecorderEmpty")}
            />
          ) : (
            <MotionUl
              // 範囲 (このプロファイル / すべて) を切り替えたら作り直して入場を再生する。
              key={scopeId ?? "__all__"}
              variants={staggerContainer(reduced)}
              initial="initial"
              animate="animate"
              m={0}
              p={0}
              listStyleType="none"
            >
              {entries.map((entry, i) => (
                <MotionLi
                  key={entry.id}
                  variants={i < STAGGER_CAP ? variants.staggerItem : undefined}
                  className={flashIds.has(entry.id) ? "flash-ring" : undefined}
                  data-flash={flashIds.has(entry.id) ? "" : undefined}
                  position="relative"
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
                      <AnimatePresence initial={false}>
                        {entry.undone && (
                          <MotionBadge
                            key="undone"
                            display="inline-block"
                            whiteSpace="pre"
                            variants={variants.slideUp}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                          >
                            {` · ${t("flightRecorderUndoneBadge")}`}
                          </MotionBadge>
                        )}
                      </AnimatePresence>
                      {entry.pinned && ` · ${t("flightRecorderPinnedBadge")}`}
                      {entry.batch_id &&
                        batches.has(entry.batch_id) &&
                        ` · ${t("flightRecorderBatchBadge", { count: batches.get(entry.batch_id)?.count ?? 0 })}`}
                    </chakra.div>
                  </Box>
                  <Tooltip label={entry.pinned ? t("flightRecorderUnpinAction") : t("flightRecorderPinTip")}>
                    <PressableButton
                      type="button"
                      variant="secondary"
                      aria-pressed={entry.pinned}
                      aria-label={
                        entry.pinned ? t("flightRecorderUnpinAction") : t("flightRecorderPinAction")
                      }
                      onClick={() => void handleTogglePin(entry)}
                    >
                      <Icon name="pin" size={ICON_SIZES.sm} />
                    </PressableButton>
                  </Tooltip>
                  <Tooltip label={t("flightRecorderExportPlanTip")}>
                    <PressableButton
                      type="button"
                      variant="secondary"
                      disabled={!sessionId}
                      aria-label={t("flightRecorderExportPlanAction")}
                      onClick={() => void handleExportPlan(entry, null)}
                    >
                      <Icon name="download" size={ICON_SIZES.sm} />
                    </PressableButton>
                  </Tooltip>
                  {entry.batch_id && batches.get(entry.batch_id)?.firstId === entry.id && (
                    <>
                      <Tooltip label={t("flightRecorderExportPlanBatchTip")}>
                        <PressableButton
                          type="button"
                          variant="secondary"
                          disabled={!sessionId}
                          onClick={() => void handleExportPlan(entry, entry.batch_id)}
                        >
                          <Icon name="download" size={ICON_SIZES.sm} /> {t("flightRecorderExportPlanAction")}
                        </PressableButton>
                      </Tooltip>
                      <PressableButton
                        type="button"
                        variant="secondary"
                        disabled={!sessionId || busyBatch === entry.batch_id}
                        onClick={() =>
                          void handleApplyBatch(
                            entry.batch_id as string,
                            batches.get(entry.batch_id as string)?.allUndone ? "redo" : "undo",
                          )
                        }
                      >
                        {batches.get(entry.batch_id)?.allUndone
                          ? t("flightRecorderBatchRedoAction")
                          : t("flightRecorderBatchUndoAction")}
                      </PressableButton>
                    </>
                  )}
                  <PressableButton
                    type="button"
                    variant="secondary"
                    disabled={!sessionId || busyId === entry.id}
                    onClick={() => void handleApply(entry, entry.undone ? "redo" : "undo")}
                  >
                    <Icon name={entry.undone ? "redo" : "undo"} size={ICON_SIZES.sm} />{" "}
                    {busyId === entry.id
                      ? t(entry.undone ? "flightRecorderRedoing" : "flightRecorderUndoing")
                      : t(entry.undone ? "flightRecorderRedoAction" : "flightRecorderUndoAction")}
                  </PressableButton>
                </MotionLi>
              ))}
            </MotionUl>
          )}
        </Box>
        {!sessionId && entries.length > 0 && (
          <chakra.p m={0} textStyle="caption">
            {t("flightRecorderNeedConnection")}
          </chakra.p>
        )}
      </ModalBody>
      <ModalFooter>
        <Box flex="1" />
        <Button variant="primary" onClick={onClose}>
          {t("flightRecorderClose")}
        </Button>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
