import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import {
  api,
  listenTaskRunEvents,
  listenTaskRunProgress,
  type Assertion,
  type ConnectionProfile,
  type DumpOptions,
  type ExportFormat,
  type TaskAction,
  type TaskDefinition,
  type TaskRun,
  type TaskRunProgressEvent,
  type TaskSchedule,
} from "../api/tauri";
import { useLocale, useT, type I18nKey } from "../i18n";
import { isReadOnlySql } from "../dangerousSql";
import { semanticColorToken } from "../semanticColors";
import {
  buildAssertionTrends,
  deviceTimeZone,
  draftFromSchedule,
  previewOutputPath,
  relativeNextRun,
  scheduleFromDraft,
  sortTasksForDisplay,
  summarizeAction,
  summarizeSchedule,
  type AssertionTrend,
  type ScheduleDraft,
} from "../taskFormat";
import { TaskScheduleEditor } from "./TaskScheduleEditor";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalHeader } from "./Modal";
import { ErrorNote, FieldError, FieldLabel, FormSection, PathRow } from "./modalForm";
import { isModalSubmitKey, pickModalKeys } from "./modalKeys";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Input, Select, Switch, Textarea } from "./ui";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { ExportMaskingSection } from "./ExportMaskingSection";
import { sanitizeMaskRule, type ExportColumnMask, type ExportMaskOverrides } from "./exportMasking";

/** 連続失敗で自動停止する回数の既定 (新規タスク) と上限。バックエンドの `MAX_PAUSE_AFTER_FAILURES` と揃える。 */
const DEFAULT_PAUSE_AFTER_FAILURES = 5;
const MAX_PAUSE_AFTER_FAILURES = 100;

/** 接続リトライの間隔入力の上限 (秒)。バックエンドの `MAX_RETRY_DELAY_SECS` (15 分) と揃える。 */
const MAX_RETRY_INTERVAL_SECS = 15 * 60;

const DEFAULT_DUMP_OPTIONS: DumpOptions = {
  singleTransaction: true,
  routines: true,
  events: true,
  triggers: true,
  addDropTable: true,
  extendedInsert: true,
  completeInsert: false,
  noData: false,
  noCreateInfo: false,
};

const EXPORT_FORMATS: ExportFormat[] = ["csv", "json", "ndjson", "markdown", "sql", "xlsx"];

const EXPORT_FORMAT_LABEL_KEYS: Record<ExportFormat, I18nKey> = {
  csv: "exportFormatCsv",
  json: "exportFormatJson",
  ndjson: "exportFormatNdjson",
  markdown: "exportFormatMarkdown",
  sql: "exportFormatSql",
  xlsx: "exportFormatXlsx",
};

/**
 * タスクスケジューラの管理画面 (#730)。一覧 (次回実行・最終結果)・作成/編集
 * フォーム・実行履歴・手動即時実行を 1 画面にまとめる。`SettingsView` と同じ
 * `Modal` ベースの全体レイアウトに乗せる。
 */
export function TaskManager({ profiles, onClose }: { profiles: ConnectionProfile[]; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  // 初回描画で「タスクがありません」を一瞬出さないよう、読み込み中から始める。
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TaskDefinition | null>(null);
  // true のとき `editing` を雛形にした新規タスクを作る (複製, #1621)。
  const [duplicating, setDuplicating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  // 「今すぐ実行」の中断用 ID と進捗 (#1534)。
  const [runningStreamId, setRunningStreamId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<TaskRunProgressEvent | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [catchUpMissed, setCatchUpMissed] = useState(false);
  // スケジューラ設定を取得できるまでは false (未取得) の値を見せない。取得前/失敗時に
  // 実際は true の設定がオフに見え、オンにしようとして逆の値を保存しかねないため (#1534)。
  const [catchUpLoaded, setCatchUpLoaded] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 初回のみ取得する (toast / t は安定でなくても再取得しない)
  useEffect(() => {
    let active = true;
    api
      .getSchedulerSettings()
      .then((s) => {
        if (!active) return;
        setCatchUpMissed(s.catch_up_missed);
        setCatchUpLoaded(true);
      })
      .catch((e) => {
        if (active) toast.error(t("taskSchedulerSettingsLoadError", { error: String(e) }));
      });
    return () => {
      active = false;
    };
  }, []);

  const handleToggleCatchUp = async (next: boolean) => {
    setCatchUpMissed(next);
    try {
      await api.setSchedulerSettings({ catch_up_missed: next });
    } catch (e) {
      setCatchUpMissed(!next);
      toast.error(String(e));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api.listTasks());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 履歴取得の連番。タスクを切り替えた後に届く古い応答は捨てる。
  const runsSeqRef = useRef(0);
  const loadRuns = useCallback(
    async (taskId: string) => {
      const seq = ++runsSeqRef.current;
      setRunsLoading(true);
      try {
        const rows = await api.listTaskRuns(taskId, 50);
        if (seq === runsSeqRef.current) setRuns(rows);
      } catch (e) {
        if (seq === runsSeqRef.current) toast.error(String(e));
      } finally {
        if (seq === runsSeqRef.current) setRunsLoading(false);
      }
    },
    [toast],
  );

  // バックグラウンドスケジューラの発火 (このビューを開いたまま待っているとき) と、
  // 他タブ相当の手動実行のどちらでも一覧/履歴を追従させる。
  // 履歴の開閉で購読し直さないよう、開いているタスクは ref で参照する。
  const historyTaskIdRef = useRef<string | null>(null);
  historyTaskIdRef.current = historyTaskId;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    const refresh = () => {
      void load();
      const openId = historyTaskIdRef.current;
      if (openId) void loadRuns(openId);
    };
    void listenTaskRunEvents({
      onDone: refresh,
      onError: refresh,
    }).then((un) => {
      if (active) unlisten = un;
      else un();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [load, loadRuns]);

  // 相対表示 ("30 min" 等) を分単位で追従させる。取得しなおさず表示だけ更新する。
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(h);
  }, []);

  const toggleHistory = (taskId: string) => {
    // 副作用 (取得) は更新関数の外で行う (StrictMode の二重実行で取得が重複しないように)。
    const next = historyTaskIdRef.current === taskId ? null : taskId;
    setHistoryTaskId(next);
    if (next) void loadRuns(next);
  };

  const handleToggleEnabled = async (task: TaskDefinition) => {
    try {
      await api.setTaskEnabled(task.id, !task.enabled);
      await load();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDelete = async (task: TaskDefinition) => {
    const ok = await confirm({
      title: t("taskDeleteConfirmTitle"),
      message: t("taskDeleteConfirmMessage", { name: task.name }),
      confirmLabel: t("taskDeleteConfirmOk"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.deleteTask(task.id);
      toast.success(t("taskDeleted", { name: task.name }));
      if (historyTaskId === task.id) setHistoryTaskId(null);
      await load();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleRunNow = async (task: TaskDefinition) => {
    const streamId = `task_${task.id}_${Date.now().toString(36)}`;
    setRunningId(task.id);
    setRunningStreamId(streamId);
    setRunProgress(null);
    let unlistenProgress: (() => void) | undefined;
    try {
      unlistenProgress = await listenTaskRunProgress(streamId, setRunProgress);
    } catch {
      // 進捗が見られないだけで実行自体は続けられる。
    }
    try {
      const run = await api.runTaskNow(task.id, streamId);
      if (run.status === "ok") {
        toast.success(t("taskRunOk", { name: task.name }));
      } else {
        toast.error(t("taskRunFailed", { name: task.name, error: run.error ?? "" }));
      }
      await load();
      if (historyTaskId === task.id) void loadRuns(task.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      unlistenProgress?.();
      setRunningId(null);
      setRunningStreamId(null);
      setRunProgress(null);
    }
  };

  const handleStopRun = () => {
    if (runningStreamId) void api.cancelStream(runningStreamId).catch(() => {});
  };

  const handleClearRuns = async (task: TaskDefinition) => {
    const ok = await confirm({
      title: t("taskHistoryClear"),
      message: t("taskHistoryClearConfirm", { name: task.name }),
      confirmLabel: t("taskHistoryClear"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.clearTaskRuns(task.id);
      setRuns([]);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const sorted = useMemo(() => sortTasksForDisplay(tasks), [tasks]);
  const openCreateForm = () => {
    setEditing(null);
    setDuplicating(false);
    setShowForm(true);
  };
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <Modal
        // no-submit: 一覧 + 行内フォーム。フォームは自身の Cmd/Ctrl+Enter で保存する
        onClose={onClose}
        width="880px"
      >
        <ModalHeader onClose={onClose} closeLabel={t("taskManagerClose")}>
          {t("taskManagerTitle")}
        </ModalHeader>
        <ModalBody>
          {showForm ? (
            <TaskForm
              profiles={profiles}
              task={editing}
              duplicate={duplicating}
              onCancel={() => {
                setShowForm(false);
                setEditing(null);
                setDuplicating(false);
              }}
              onSaved={async () => {
                setShowForm(false);
                setEditing(null);
                setDuplicating(false);
                await load();
              }}
            />
          ) : (
            <>
              <Flex justify="space-between" align="center" marginBottom="3" gap="3" flexWrap="wrap">
                <chakra.p margin={0} fontSize="sm" color="app.textMuted" flex="1" minW="240px">
                  {t("taskManagerDesc")}
                </chakra.p>
                <Button
                  type="button"
                  variant="primary"
                  disabled={profiles.length === 0}
                  onClick={openCreateForm}
                >
                  <Icon name="plus" size={ICON_SIZES.sm} /> {t("taskCreate")}
                </Button>
              </Flex>

              {profiles.length === 0 && (
                <chakra.p margin={0} marginBottom="3" fontSize="sm" color="app.textMuted">
                  {t("taskNoProfiles")}
                </chakra.p>
              )}

              <chakra.label display="inline-flex" alignItems="center" gap="1.5" marginBottom="3">
                <Switch
                  checked={catchUpMissed}
                  onChange={(v) => void handleToggleCatchUp(v)}
                  disabled={!catchUpLoaded}
                  size="sm"
                />
                <chakra.span fontSize="sm" color="app.textSecondary">
                  {t("taskCatchUpMissed")}
                </chakra.span>
              </chakra.label>

              {error ? (
                <EmptyState
                  illustration={errorIllustration(error)}
                  icon="warning"
                  title={t("taskLoadError", { error })}
                  action={{ label: t("taskRetry"), onClick: () => void load() }}
                />
              ) : sorted.length === 0 && !loading ? (
                <EmptyState
                  illustration={<NoResultsIllustration />}
                  icon="clock"
                  title={t("taskEmpty")}
                  // プロファイルが無いと作成できない (ヘッダの「新規タスク」も無効) ため CTA は出さない
                  action={
                    profiles.length > 0 ? { label: t("taskCreate"), onClick: openCreateForm } : undefined
                  }
                />
              ) : (
                <chakra.div display="flex" flexDirection="column" gap="2">
                  {sorted.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      profileName={profileName(task.profile_id)}
                      now={now}
                      running={runningId === task.id}
                      runDisabled={runningId !== null}
                      progress={runningId === task.id ? runProgress : null}
                      onStopRun={handleStopRun}
                      expanded={historyTaskId === task.id}
                      runs={historyTaskId === task.id ? runs : []}
                      runsLoading={historyTaskId === task.id && runsLoading}
                      onToggleEnabled={() => void handleToggleEnabled(task)}
                      onEdit={() => {
                        setEditing(task);
                        setDuplicating(false);
                        setShowForm(true);
                      }}
                      onDuplicate={() => {
                        setEditing(task);
                        setDuplicating(true);
                        setShowForm(true);
                      }}
                      onDelete={() => void handleDelete(task)}
                      onRunNow={() => void handleRunNow(task)}
                      onToggleHistory={() => toggleHistory(task.id)}
                      onClearHistory={() => void handleClearRuns(task)}
                    />
                  ))}
                </chakra.div>
              )}
            </>
          )}
        </ModalBody>
      </Modal>
      {dialog}
    </>
  );
}

/** 進捗の件数を単位つきの文字列にする (行数 / バイト / 件)。 */
function formatTaskProgress(p: TaskRunProgressEvent, t: ReturnType<typeof useT>): string {
  const key: I18nKey =
    p.unit === "rows"
      ? "taskRunProgressRows"
      : p.unit === "bytes"
        ? "taskRunProgressBytes"
        : "taskRunProgressItems";
  return t(key, { count: p.count.toLocaleString() });
}

function TaskRow({
  task,
  profileName,
  now,
  running,
  runDisabled,
  progress,
  onStopRun,
  expanded,
  runs,
  runsLoading,
  onToggleEnabled,
  onEdit,
  onDuplicate,
  onDelete,
  onRunNow,
  onToggleHistory,
  onClearHistory,
}: {
  task: TaskDefinition;
  profileName: string;
  now: Date;
  running: boolean;
  /** どれかのタスクが実行中のあいだ全行の「今すぐ実行」を無効にする (実行は 1 本ずつ)。 */
  runDisabled: boolean;
  /** 実行中の進捗 (届くまで null)。 */
  progress: TaskRunProgressEvent | null;
  onStopRun: () => void;
  expanded: boolean;
  runs: TaskRun[];
  runsLoading: boolean;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onToggleHistory: () => void;
  onClearHistory: () => void;
}) {
  const t = useT();
  const rel = relativeNextRun(task.next_run_at, now, t);
  const locale = useLocale();
  return (
    <chakra.div border="1px solid" borderColor="app.border" borderRadius="md" overflow="hidden">
      <Flex align="center" gap="3" px="3" py="2.5" flexWrap="wrap">
        <Switch
          checked={task.enabled}
          onChange={onToggleEnabled}
          aria-label={t("taskToggleEnabled", { name: task.name })}
        />
        <chakra.div flex="1" minW="180px">
          <chakra.div fontWeight={600} color="app.text">
            {task.name}
          </chakra.div>
          <chakra.div fontSize="xs" color="app.textMuted">
            {profileName} · {summarizeAction(task.action, t)} ·{" "}
            {summarizeSchedule(task.schedule, t, {
              now: task.next_run_at ? new Date(task.next_run_at) : now,
              locale,
            })}
          </chakra.div>
          {task.auto_paused_at && !task.enabled && (
            <chakra.div
              fontSize="xs"
              color={semanticColorToken("warning", "text")}
              data-testid="task-auto-paused"
            >
              {t("taskAutoPausedBadge", { n: task.pause_after_failures || task.consecutive_failures })}
            </chakra.div>
          )}
        </chakra.div>
        <chakra.div fontSize="xs" color="app.textMuted" minW="90px" textAlign="right" textStyle="numeric">
          {task.enabled ? (
            <>
              {t("taskNextRun")}: {rel ? rel : "–"}
            </>
          ) : (
            t("taskDisabled")
          )}
        </chakra.div>
        <chakra.div fontSize="xs" minW="70px" textAlign="right">
          {running && (
            <chakra.span color="app.textMuted" data-testid="task-run-progress">
              {progress
                ? t("taskRunProgress", { progress: formatTaskProgress(progress, t) })
                : t("taskRunning")}
            </chakra.span>
          )}
          {!running && task.last_status === "ok" && (
            <chakra.span color="app.textMuted">{t("taskLastOk")}</chakra.span>
          )}
          {!running && task.last_status === "error" && (
            <chakra.span color={semanticColorToken("danger", "text")}>{t("taskLastError")}</chakra.span>
          )}
          {!running && !task.last_status && <chakra.span color="app.textMuted">–</chakra.span>}
        </chakra.div>
        <Flex gap="1.5">
          <Tooltip
            label={runDisabled && !running ? t("taskRunBlockedByOther") : t("taskRunNow")}
            focusableWrapper={runDisabled && !running}
          >
            <Button
              type="button"
              onClick={onRunNow}
              disabled={runDisabled || running}
              aria-label={t("taskRunNow")}
            >
              {running ? <Spinner size={14} decorative /> : <Icon name="query" size={ICON_SIZES.sm} />}
            </Button>
          </Tooltip>
          {running && (
            <Tooltip label={t("taskRunStopTitle")}>
              <Button type="button" variant="warning" onClick={onStopRun} aria-label={t("taskRunStop")}>
                {t("taskRunStop")}
              </Button>
            </Tooltip>
          )}
          <Tooltip label={t("taskHistory")}>
            <Button
              type="button"
              onClick={onToggleHistory}
              aria-label={t("taskHistory")}
              aria-expanded={expanded}
              aria-controls={expanded ? `task-history-${task.id}` : undefined}
            >
              <Icon name="clock" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
          <Tooltip label={t("taskEdit")}>
            <Button type="button" onClick={onEdit} aria-label={t("taskEdit")}>
              <Icon name="tools" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
          <Tooltip label={t("taskDuplicate")}>
            <Button type="button" onClick={onDuplicate} aria-label={t("taskDuplicate")}>
              <Icon name="copy" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
          <Tooltip label={t("taskDelete")}>
            <Button type="button" variant="danger" onClick={onDelete} aria-label={t("taskDelete")}>
              <Icon name="close" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
        </Flex>
      </Flex>
      {expanded && (
        <chakra.div
          id={`task-history-${task.id}`}
          borderTop="1px solid"
          borderColor="app.border"
          bg="app.toolbar"
          px="3"
          py="2.5"
        >
          {runsLoading ? (
            <Spinner size={14} />
          ) : runs.length === 0 ? (
            <chakra.p margin={0} fontSize="xs" color="app.textMuted">
              {t("taskHistoryEmpty")}
            </chakra.p>
          ) : (
            <chakra.div display="flex" flexDirection="column" gap="1.5">
              {task.action.kind === "run_assertions" && (
                <AssertionTrendList taskId={task.id} refreshKey={runs} />
              )}
              <Flex justify="flex-end">
                <Button type="button" variant="danger" size="sm" onClick={onClearHistory}>
                  {t("taskHistoryClear")}
                </Button>
              </Flex>
              {runs.map((r) => (
                <chakra.div
                  key={r.id}
                  display="flex"
                  gap="2"
                  fontSize="xs"
                  fontFamily="var(--font-mono)"
                  textStyle="numeric"
                  color={
                    r.status === "ok" || r.status === "skipped"
                      ? "app.textMuted"
                      : semanticColorToken("danger", "text")
                  }
                >
                  <chakra.span minW="170px">{new Date(r.started_at).toLocaleString()}</chakra.span>
                  <chakra.span minW="50px">
                    {r.status === "skipped" ? t("taskRunStatusSkipped") : r.status}
                  </chakra.span>
                  {r.catch_up && <chakra.span>({t("taskRunCatchUp")})</chakra.span>}
                  {r.attempts > 1 && <chakra.span>({t("taskRunAttempts", { n: r.attempts })})</chakra.span>}
                  {r.output_path && (
                    <chakra.span flex="1" wordBreak="break-all">
                      {r.output_path}
                    </chakra.span>
                  )}
                  {r.rows != null && <chakra.span>{t("taskRunRows", { rows: r.rows })}</chakra.span>}
                  {r.bytes != null && <chakra.span>{t("taskRunBytes", { bytes: r.bytes })}</chakra.span>}
                  {r.status === "skipped" ? (
                    <chakra.span flex="1" wordBreak="break-all">
                      {t("taskRunSkippedReason")}
                    </chakra.span>
                  ) : (
                    r.error && (
                      <chakra.span flex="1" wordBreak="break-all">
                        {r.error}
                      </chakra.span>
                    )
                  )}
                </chakra.div>
              ))}
            </chakra.div>
          )}
        </chakra.div>
      )}
    </chakra.div>
  );
}

/** アサーション実行タスクの合否推移 (#1170)。`refreshKey` が変わる (= 実行履歴が
 *  更新される) たびに取り直す。 */
function AssertionTrendList({ taskId, refreshKey }: { taskId: string; refreshKey: unknown }) {
  const t = useT();
  const [trends, setTrends] = useState<AssertionTrend[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は本体では使わず、実行履歴の更新で推移を取り直すためのトリガー
  useEffect(() => {
    let active = true;
    void api
      .listAssertionRuns({ taskId, limit: 500 })
      .then((records) => {
        if (active) setTrends(buildAssertionTrends(records));
      })
      .catch(() => {
        if (active) setTrends([]);
      });
    return () => {
      active = false;
    };
  }, [taskId, refreshKey]);

  if (trends === null) return null;
  return (
    <chakra.div display="flex" flexDirection="column" gap="1" marginBottom="2">
      <chakra.div textStyle="overline" color="app.textMuted">
        {t("taskAssertionTrendTitle")}
      </chakra.div>
      {trends.length === 0 ? (
        <chakra.p margin={0} fontSize="xs" color="app.textMuted">
          {t("taskAssertionTrendEmpty")}
        </chakra.p>
      ) : (
        trends.map((tr) => (
          <Flex key={tr.assertionId} align="center" gap="2" fontSize="xs" flexWrap="wrap">
            <chakra.span minW="160px" flex="1" color="app.text" wordBreak="break-all">
              {tr.name}
            </chakra.span>
            <Flex
              gap="0.5"
              role="img"
              aria-label={tr.dots
                .map((d) => (d ? t("taskAssertionPass") : t("taskAssertionFail")))
                .join(", ")}
            >
              {tr.dots.map((passed, i) => (
                <chakra.span
                  key={i}
                  w="8px"
                  h="14px"
                  borderRadius="xs"
                  bg={semanticColorToken(passed ? "success" : "danger", "solid")}
                />
              ))}
            </Flex>
            <chakra.span minW="90px" textAlign="right" color="app.textMuted" textStyle="numeric">
              {tr.lastError
                ? tr.lastError
                : tr.lastObserved != null
                  ? t("taskAssertionTrendObserved", { observed: tr.lastObserved })
                  : "–"}
            </chakra.span>
            <chakra.span minW="70px" textAlign="right" color="app.textMuted" textStyle="numeric">
              {t("taskAssertionTrendRate", { rate: Math.round(tr.passRate * 100) })}
            </chakra.span>
          </Flex>
        ))
      )}
    </chakra.div>
  );
}

type ActionKind = TaskAction["kind"];

function overridesHaveRule(overrides: ExportMaskOverrides, column: string): boolean {
  return !!overrides[column] && sanitizeMaskRule(overrides[column]) !== null;
}

/** 画面の列一覧 + 上書きから、保存するマスクルール (ルールが空の列は除く) を作る (#1836)。 */
function collectMasks(columns: readonly string[], overrides: ExportMaskOverrides): ExportColumnMask[] {
  const out: ExportColumnMask[] = [];
  for (const column of columns) {
    const rule = overrides[column] ? sanitizeMaskRule(overrides[column]) : null;
    if (rule) out.push({ column, rule });
  }
  return out;
}

function TaskForm({
  profiles,
  task,
  duplicate = false,
  onCancel,
  onSaved,
}: {
  profiles: ConnectionProfile[];
  task: TaskDefinition | null;
  /** true なら `task` を雛形にした**新規**タスクとして開く (複製, #1621)。 */
  duplicate?: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [name, setName] = useState(
    task ? (duplicate ? t("taskDuplicateName", { name: task.name }) : task.name) : "",
  );
  const [profileId, setProfileId] = useState(task?.profile_id ?? profiles[0]?.id ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);

  const [actionKind, setActionKind] = useState<ActionKind>(task?.action.kind ?? "export_query");
  const [sql, setSql] = useState(task?.action.kind === "export_query" ? task.action.sql : "");
  const [database, setDatabase] = useState(
    task?.action.kind === "export_query" || task?.action.kind === "run_assertions"
      ? (task.action.database ?? "")
      : task?.action.kind === "dump"
        ? task.action.database
        : "",
  );
  const [format, setFormat] = useState<ExportFormat>(
    task?.action.kind === "export_query" ? task.action.format : "csv",
  );
  const [sqlTable, setSqlTable] = useState(
    task?.action.kind === "export_query" ? (task.action.sql_table ?? "") : "",
  );
  const [sqlBatchSize, setSqlBatchSize] = useState(
    task?.action.kind === "export_query" && task.action.sql_batch_size
      ? String(task.action.sql_batch_size)
      : "",
  );
  // 列マスク (#1836)。列は SQL の結果列が実行時まで分からないので、名前を手入力で足す。
  const initialMasks = task?.action.kind === "export_query" ? (task.action.masks ?? []) : [];
  const [maskEnabled, setMaskEnabled] = useState(initialMasks.length > 0);
  const [maskColumns, setMaskColumns] = useState<string[]>(() => initialMasks.map((m) => m.column));
  const [maskOverrides, setMaskOverrides] = useState<ExportMaskOverrides>(() =>
    Object.fromEntries(initialMasks.map((m) => [m.column, m.rule])),
  );
  const [maskColumnInput, setMaskColumnInput] = useState("");
  const [maskError, setMaskError] = useState<string | null>(null);
  const removeMaskColumn = (column: string) => {
    setMaskColumns((cur) => cur.filter((c) => c !== column));
    setMaskOverrides((cur) => {
      const next = { ...cur };
      delete next[column];
      return next;
    });
  };
  const addMaskColumn = () => {
    const name = maskColumnInput.trim();
    if (name === "") return;
    setMaskColumns((cur) => (cur.includes(name) ? cur : [...cur, name]));
    setMaskColumnInput("");
  };
  const [outputPath, setOutputPath] = useState(
    task && (task.action.kind === "export_query" || task.action.kind === "dump")
      ? task.action.output_path
      : "",
  );
  // 出力先を持つのはファイルを書くアクションだけ (#1537 で増えた取得系アクションは持たない)。
  const needsOutputPath = actionKind === "export_query" || actionKind === "dump";
  const [notifyOnlyIncrease, setNotifyOnlyIncrease] = useState(
    task?.action.kind === "run_assertions" ? (task.action.notify_only_on_increase ?? false) : false,
  );
  const [timelapseMaxGenerations, setTimelapseMaxGenerations] = useState(
    task?.action.kind === "timelapse_capture" && task.action.max_generations
      ? String(task.action.max_generations)
      : "",
  );
  const [connectRetries, setConnectRetries] = useState(String(task?.connect_retry?.max_retries ?? 0));
  const [connectRetryInterval, setConnectRetryInterval] = useState(
    String(task?.connect_retry?.interval_secs ?? 30),
  );
  const [assertions, setAssertions] = useState<Assertion[]>([]);
  const [pickAssertions, setPickAssertions] = useState(
    task?.action.kind === "run_assertions" && task.action.assertion_ids.length > 0,
  );
  const [assertionIds, setAssertionIds] = useState<string[]>(
    task?.action.kind === "run_assertions" ? task.action.assertion_ids : [],
  );
  useEffect(() => {
    void api
      .listAssertions()
      .then(setAssertions)
      .catch(() => setAssertions([]));
  }, []);
  const [dumpOptions, setDumpOptions] = useState<DumpOptions>(
    task?.action.kind === "dump" ? task.action.options : DEFAULT_DUMP_OPTIONS,
  );

  // スケジュールの編集状態 (#1621)。新規は端末のタイムゾーンの 9:00。旧データ (タイムゾーンなし = UTC) は UTC として開く。
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() =>
    draftFromSchedule(task?.schedule, deviceTimeZone()),
  );
  const legacyUtc = task?.schedule.kind === "daily" && !task.schedule.timezone;
  const [pauseAfterFailures, setPauseAfterFailures] = useState(
    String(task ? task.pause_after_failures : DEFAULT_PAUSE_AFTER_FAILURES),
  );

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedProfile = profiles.find((p) => p.id === profileId) ?? null;
  // ドライバを渡さない (= 保守的なマスク) のは意図的: バックエンドの
  // `commands::tasks::validate_action` / `tasks::executor::run_once` も、
  // プロファイル解決前に同じドライバ非依存の判定で弾くため (#852)。ここで
  // MySQL 解釈を使うと、UI が通した SQL を保存時にバックエンドが拒否しうる。
  const sqlLooksReadOnly = actionKind !== "export_query" || sql.trim() === "" || isReadOnlySql(sql);
  const preview = outputPath ? previewOutputPath(outputPath, new Date()) : "";

  const browseOutputPath = async () => {
    const ext =
      actionKind === "dump"
        ? "sql"
        : format === "json"
          ? "json"
          : format === "ndjson"
            ? "ndjson"
            : format === "markdown"
              ? "md"
              : format === "sql"
                ? "sql"
                : format === "xlsx"
                  ? "xlsx"
                  : "csv";
    const picked = await saveFileDialog({
      title: t("taskOutputPathBrowseTitle"),
      defaultPath: `${name || "task"}.${ext}`,
    }).catch(() => null);
    if (picked) setOutputPath(picked);
  };

  const handleSubmit = async () => {
    setFormError(null);
    if (name.trim() === "") {
      setFormError(t("taskFormNameRequired"));
      return;
    }
    if (!profileId) {
      setFormError(t("taskFormProfileRequired"));
      return;
    }
    if (needsOutputPath && outputPath.trim() === "") {
      setFormError(t("taskFormOutputPathRequired"));
      return;
    }
    let action: TaskAction;
    if (actionKind === "export_query") {
      if (sql.trim() === "") {
        setFormError(t("taskFormSqlRequired"));
        return;
      }
      // 上と同じ理由でドライバ非依存 (#852)。
      if (!isReadOnlySql(sql)) {
        setFormError(t("taskFormSqlNotReadOnly"));
        return;
      }
      // ルールが「なし」のままの列は黙って捨てず、保存を止める (#1836)。
      const unruled = maskEnabled ? maskColumns.filter((c) => !overridesHaveRule(maskOverrides, c)) : [];
      if (unruled.length > 0) {
        setMaskError(t("taskFormMaskNoRule", { columns: unruled.join(", ") }));
        return;
      }
      setMaskError(null);
      action = {
        kind: "export_query",
        sql,
        database: database.trim() === "" ? null : database.trim(),
        format,
        output_path: outputPath,
        sql_table: format === "sql" && sqlTable.trim() !== "" ? sqlTable.trim() : null,
        sql_batch_size: format === "sql" && sqlBatchSize.trim() !== "" ? Number(sqlBatchSize) : null,
        masks: maskEnabled ? collectMasks(maskColumns, maskOverrides) : [],
      };
    } else if (actionKind === "run_assertions") {
      if (pickAssertions && assertionIds.length === 0) {
        setFormError(t("taskFormAssertionsRequired"));
        return;
      }
      action = {
        kind: "run_assertions",
        database: database.trim() === "" ? null : database.trim(),
        assertion_ids: pickAssertions ? assertionIds : [],
        notify_only_on_increase: notifyOnlyIncrease,
      };
    } else if (actionKind === "timelapse_capture") {
      const n = Number(timelapseMaxGenerations);
      action = {
        kind: "timelapse_capture",
        max_generations:
          timelapseMaxGenerations.trim() !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null,
      };
    } else if (actionKind === "refresh_plan_watch") {
      // ウォッチ中のものすべて (スニペット単位の絞り込み UI は持たない)。
      action = { kind: "refresh_plan_watch", snippet_ids: [] };
    } else {
      if (database.trim() === "") {
        setFormError(t("taskFormDatabaseRequired"));
        return;
      }
      action = {
        kind: "dump",
        database: database.trim(),
        output_path: outputPath,
        options: dumpOptions,
      };
    }

    const built = scheduleFromDraft(scheduleDraft);
    if (!built.ok) {
      setFormError(t("taskScheduleWeekdaysRequired"));
      return;
    }
    const schedule: TaskSchedule = built.schedule;

    if (selectedProfile?.is_production) {
      const ok = await confirm({
        title: t("taskProductionConfirmTitle"),
        message: t("taskProductionConfirmMessage", { name: selectedProfile.name }),
        confirmLabel: t("taskProductionConfirmOk"),
        tone: "warning",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      await api.saveTask({
        id: duplicate ? null : (task?.id ?? null),
        name: name.trim(),
        profile_id: profileId,
        action,
        schedule,
        enabled,
        pause_after_failures: Math.min(
          MAX_PAUSE_AFTER_FAILURES,
          Math.max(0, Math.floor(Number(pauseAfterFailures) || 0)),
        ),
        connect_retry: {
          max_retries: Math.max(0, Math.floor(Number(connectRetries) || 0)),
          interval_secs: Math.min(
            MAX_RETRY_INTERVAL_SECS,
            Math.max(1, Math.floor(Number(connectRetryInterval) || 30)),
          ),
        },
      });
      toast.success(t("taskSaved", { name: name.trim() }));
      onSaved();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <chakra.div
      display="flex"
      flexDirection="column"
      gap="3.5"
      // モーダル / 接続フォームと同じく Cmd/Ctrl+Enter で保存する (#1114)。
      onKeyDown={(e) => {
        if (saving) return;
        // {dialog} (確認ダイアログ) はポータル描画。そこからのキーで再送信しない (#1604)。
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (!isModalSubmitKey(pickModalKeys(e))) return;
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <FormSection>
        <FieldLabel htmlFor="task-name">{t("taskFormName")}</FieldLabel>
        <Input id="task-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </FormSection>

      <FormSection>
        <FieldLabel htmlFor="task-profile">{t("taskFormProfile")}</FieldLabel>
        <Select id="task-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.is_production ? ` (${t("taskFormProductionBadge")})` : ""}
            </option>
          ))}
        </Select>
      </FormSection>

      <FormSection>
        <FieldLabel as="div">{t("taskFormActionKind")}</FieldLabel>
        <Select value={actionKind} onChange={(e) => setActionKind(e.target.value as ActionKind)}>
          <option value="export_query">{t("taskFormActionExport")}</option>
          <option value="dump">{t("taskFormActionDump")}</option>
          <option value="run_assertions">{t("taskFormActionAssertions")}</option>
          <option value="timelapse_capture">{t("taskFormActionTimelapse")}</option>
          <option value="refresh_plan_watch">{t("taskFormActionPlanWatch")}</option>
        </Select>
      </FormSection>

      {actionKind === "export_query" ? (
        <>
          <FormSection>
            <FieldLabel htmlFor="task-sql">{t("taskFormSql")}</FieldLabel>
            <Textarea
              id="task-sql"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={5}
              fontFamily="var(--font-mono)"
              placeholder="SELECT ..."
            />
            {!sqlLooksReadOnly && (
              <chakra.p margin={0} marginTop="1" fontSize="xs" color={semanticColorToken("danger", "text")}>
                {t("taskFormSqlNotReadOnly")}
              </chakra.p>
            )}
          </FormSection>
          <FormSection>
            <FieldLabel htmlFor="task-database">{t("taskFormDatabaseOptional")}</FieldLabel>
            <Input id="task-database" value={database} onChange={(e) => setDatabase(e.target.value)} />
          </FormSection>
          <FormSection>
            <FieldLabel htmlFor="task-format">{t("exportFormat")}</FieldLabel>
            <Select
              id="task-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {EXPORT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(EXPORT_FORMAT_LABEL_KEYS[f])}
                </option>
              ))}
            </Select>
          </FormSection>
          <ExportMaskingSection
            columnNames={maskColumns}
            enabled={maskEnabled}
            onEnabledChange={setMaskEnabled}
            presets={[]}
            overrides={maskOverrides}
            onOverridesChange={setMaskOverrides}
            hint={t("taskFormMaskHint")}
            onRemoveColumn={removeMaskColumn}
            footer={
              <Flex gap="2" alignItems="center">
                <Input
                  value={maskColumnInput}
                  aria-label={t("taskFormMaskAddColumn")}
                  placeholder={t("taskFormMaskAddColumn")}
                  onChange={(e) => setMaskColumnInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      addMaskColumn();
                    }
                  }}
                />
                <Button type="button" variant="secondary" size="sm" onClick={addMaskColumn}>
                  {t("taskFormMaskAdd")}
                </Button>
              </Flex>
            }
          />
          {maskError && <FieldError>{maskError}</FieldError>}
          {format === "sql" && (
            <Flex gap="3" flexWrap="wrap">
              <FormSection flex="1" minW="160px">
                <FieldLabel htmlFor="task-sql-table">{t("exportSqlTable")}</FieldLabel>
                <Input id="task-sql-table" value={sqlTable} onChange={(e) => setSqlTable(e.target.value)} />
              </FormSection>
              <FormSection flex="1" minW="120px">
                <FieldLabel htmlFor="task-sql-batch">{t("exportSqlBatch")}</FieldLabel>
                <Input
                  id="task-sql-batch"
                  type="number"
                  min={1}
                  value={sqlBatchSize}
                  onChange={(e) => setSqlBatchSize(e.target.value)}
                />
              </FormSection>
            </Flex>
          )}
        </>
      ) : actionKind === "timelapse_capture" ? (
        <>
          <chakra.p margin={0} textStyle="caption" color="app.textMuted">
            {t("taskFormTimelapseHint")}
          </chakra.p>
          <FormSection>
            <FieldLabel htmlFor="task-timelapse-generations">
              {t("taskFormTimelapseMaxGenerations")}
            </FieldLabel>
            <Input
              id="task-timelapse-generations"
              type="number"
              min={1}
              width="120px"
              value={timelapseMaxGenerations}
              onChange={(e) => setTimelapseMaxGenerations(e.target.value)}
            />
          </FormSection>
        </>
      ) : actionKind === "refresh_plan_watch" ? (
        <chakra.p margin={0} textStyle="caption" color="app.textMuted">
          {t("taskFormPlanWatchHint")}
        </chakra.p>
      ) : actionKind === "run_assertions" ? (
        <>
          <chakra.p margin={0} fontSize="xs" color="app.textMuted">
            {t("taskFormAssertionsHint")}
          </chakra.p>
          <FormSection>
            <FieldLabel htmlFor="task-database-assert">{t("taskFormDatabaseOptional")}</FieldLabel>
            <Input id="task-database-assert" value={database} onChange={(e) => setDatabase(e.target.value)} />
          </FormSection>
          <FormSection>
            <FieldLabel as="div">{t("taskFormActionAssertions")}</FieldLabel>
            <Select
              aria-label={t("taskFormActionAssertions")}
              value={pickAssertions ? "pick" : "all"}
              onChange={(e) => setPickAssertions(e.target.value === "pick")}
            >
              <option value="all">{t("taskFormAssertionsAll")}</option>
              <option value="pick">{t("taskFormAssertionsPick")}</option>
            </Select>
            {pickAssertions &&
              (assertions.length === 0 ? (
                <chakra.p margin={0} marginTop="1" fontSize="xs" color="app.textMuted">
                  {t("taskFormAssertionsNone")}
                </chakra.p>
              ) : (
                <chakra.div display="flex" flexDirection="column" gap="1" marginTop="1.5">
                  {assertions.map((a) => (
                    <chakra.label
                      key={a.id}
                      display="inline-flex"
                      alignItems="center"
                      gap="1.5"
                      fontSize="sm"
                      color="app.textSecondary"
                    >
                      <Checkbox
                        checked={assertionIds.includes(a.id)}
                        onChange={(e) =>
                          setAssertionIds((cur) =>
                            e.target.checked ? [...cur, a.id] : cur.filter((id) => id !== a.id),
                          )
                        }
                      />
                      {a.name}
                    </chakra.label>
                  ))}
                </chakra.div>
              ))}
          </FormSection>
          <chakra.label display="inline-flex" alignItems="center" gap="1.5">
            <Switch checked={notifyOnlyIncrease} onChange={setNotifyOnlyIncrease} />
            <chakra.span fontSize="sm" color="app.textSecondary">
              {t("taskFormNotifyOnlyIncrease")}
            </chakra.span>
          </chakra.label>
          <chakra.p margin={0} textStyle="caption" color="app.textMuted">
            {t("taskFormNotifyOnlyIncreaseHint")}
          </chakra.p>
        </>
      ) : (
        <>
          <FormSection>
            <FieldLabel htmlFor="task-database-dump">{t("taskFormDatabase")}</FieldLabel>
            <Input id="task-database-dump" value={database} onChange={(e) => setDatabase(e.target.value)} />
          </FormSection>
          <FormSection>
            <FieldLabel as="div">{t("dumpOptionsLabel")}</FieldLabel>
            <chakra.div display="grid" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap="1.5">
              {(
                [
                  ["singleTransaction", "dumpOptSingleTransaction"],
                  ["routines", "dumpOptRoutines"],
                  ["events", "dumpOptEvents"],
                  ["triggers", "dumpOptTriggers"],
                  ["addDropTable", "dumpOptAddDropTable"],
                  ["extendedInsert", "dumpOptExtendedInsert"],
                  ["completeInsert", "dumpOptCompleteInsert"],
                  ["noData", "dumpOptNoData"],
                  ["noCreateInfo", "dumpOptNoCreateInfo"],
                ] as const
              ).map(([key, labelKey]) => (
                <chakra.label
                  key={key}
                  display="inline-flex"
                  alignItems="center"
                  gap="1.5"
                  fontSize="sm"
                  color="app.textSecondary"
                >
                  <Checkbox
                    checked={dumpOptions[key]}
                    onChange={(e) => setDumpOptions((cur) => ({ ...cur, [key]: e.target.checked }))}
                  />
                  {t(labelKey)}
                </chakra.label>
              ))}
            </chakra.div>
          </FormSection>
        </>
      )}

      {needsOutputPath && (
        <FormSection>
          <FieldLabel htmlFor="task-output-path">{t("taskFormOutputPath")}</FieldLabel>
          <PathRow>
            <Input
              id="task-output-path"
              value={outputPath}
              onChange={(e) => setOutputPath(e.target.value)}
              placeholder={t("taskFormOutputPathPlaceholder")}
            />
            <Button type="button" onClick={() => void browseOutputPath()}>
              {t("dumpBrowse")}
            </Button>
          </PathRow>
          <chakra.p margin={0} marginTop="1" fontSize="xs" color="app.textMuted">
            {t("taskFormOutputPathHint")}
            {preview && preview !== outputPath && <> — {t("taskFormOutputPathPreview", { path: preview })}</>}
          </chakra.p>
        </FormSection>
      )}

      <FormSection>
        <FieldLabel as="div">{t("taskFormSchedule")}</FieldLabel>
        <TaskScheduleEditor draft={scheduleDraft} onChange={setScheduleDraft} legacyUtc={legacyUtc} />
      </FormSection>

      <FormSection>
        <FieldLabel as="div">{t("taskFormConnectRetries")}</FieldLabel>
        <Flex gap="3" align="center" flexWrap="wrap">
          <Input
            type="number"
            min={0}
            max={10}
            width="90px"
            aria-label={t("taskFormConnectRetries")}
            value={connectRetries}
            onChange={(e) => setConnectRetries(e.target.value)}
          />
          <Flex align="center" gap="1.5">
            <chakra.span fontSize="sm" color="app.textMuted">
              {t("taskFormConnectRetryInterval")}
            </chakra.span>
            <Input
              type="number"
              min={5}
              max={MAX_RETRY_INTERVAL_SECS}
              width="90px"
              aria-label={t("taskFormConnectRetryInterval")}
              value={connectRetryInterval}
              onChange={(e) => setConnectRetryInterval(e.target.value)}
            />
          </Flex>
        </Flex>
        <chakra.p margin={0} marginTop="1" textStyle="caption" color="app.textMuted">
          {t("taskFormConnectRetryHint")}
        </chakra.p>
      </FormSection>

      <FormSection>
        <FieldLabel htmlFor="task-pause-after-failures">{t("taskFormPauseAfterFailures")}</FieldLabel>
        <Flex align="center" gap="1.5" flexWrap="wrap">
          <Input
            id="task-pause-after-failures"
            type="number"
            min={0}
            max={MAX_PAUSE_AFTER_FAILURES}
            width="90px"
            value={pauseAfterFailures}
            onChange={(e) => setPauseAfterFailures(e.target.value)}
          />
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("taskFormPauseAfterFailuresSuffix")}
          </chakra.span>
        </Flex>
        <chakra.p margin={0} marginTop="1" textStyle="caption">
          {t("taskFormPauseAfterFailuresHint")}
        </chakra.p>
      </FormSection>

      <chakra.label display="inline-flex" alignItems="center" gap="1.5">
        <Switch checked={enabled} onChange={setEnabled} />
        <chakra.span fontSize="sm" color="app.textSecondary">
          {t("taskFormEnabled")}
        </chakra.span>
      </chakra.label>

      {formError && <ErrorNote role="alert">{formError}</ErrorNote>}

      <Flex gap="2" justify="flex-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          {t("taskFormCancel")}
        </Button>
        <LoadingButton type="button" variant="primary" loading={saving} onClick={() => void handleSubmit()}>
          {t("taskFormSave")}
        </LoadingButton>
      </Flex>
      {dialog}
    </chakra.div>
  );
}
