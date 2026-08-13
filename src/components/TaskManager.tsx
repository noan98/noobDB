import { useCallback, useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import {
  api,
  listenTaskRunEvents,
  type ConnectionProfile,
  type DumpOptions,
  type ExportFormat,
  type TaskAction,
  type TaskDefinition,
  type TaskRun,
  type TaskSchedule,
} from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { isReadOnlySql } from "../dangerousSql";
import { previewOutputPath, relativeNextRun, sortTasksForDisplay, summarizeAction, summarizeSchedule } from "../taskFormat";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Input, Select, Switch, Textarea } from "./ui";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

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

const EXPORT_FORMATS: ExportFormat[] = ["csv", "json", "ndjson", "markdown", "sql"];

const EXPORT_FORMAT_LABEL_KEYS: Record<ExportFormat, I18nKey> = {
  csv: "exportFormatCsv",
  json: "exportFormatJson",
  ndjson: "exportFormatNdjson",
  markdown: "exportFormatMarkdown",
  sql: "exportFormatSql",
};

/**
 * タスクスケジューラの管理画面 (#730)。一覧 (次回実行・最終結果)・作成/編集
 * フォーム・実行履歴・手動即時実行を 1 画面にまとめる。`SettingsView` と同じ
 * `Modal` ベースの全体レイアウトに乗せる。
 */
export function TaskManager({
  profiles,
  onClose,
}: {
  profiles: ConnectionProfile[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TaskDefinition | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [catchUpMissed, setCatchUpMissed] = useState(false);

  useEffect(() => {
    void api.getSchedulerSettings().then((s) => setCatchUpMissed(s.catch_up_missed));
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

  const loadRuns = useCallback(async (taskId: string) => {
    setRunsLoading(true);
    try {
      setRuns(await api.listTaskRuns(taskId, 50));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRunsLoading(false);
    }
  }, [toast]);

  // バックグラウンドスケジューラの発火 (このビューを開いたまま待っているとき) と、
  // 他タブ相当の手動実行のどちらでも一覧/履歴を追従させる。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void listenTaskRunEvents({
      onDone: () => {
        void load();
        if (historyTaskId) void loadRuns(historyTaskId);
      },
      onError: () => {
        void load();
        if (historyTaskId) void loadRuns(historyTaskId);
      },
    }).then((un) => {
      if (active) unlisten = un;
      else un();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [load, loadRuns, historyTaskId]);

  // 相対表示 ("30 min" 等) を分単位で追従させる。取得しなおさず表示だけ更新する。
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(h);
  }, []);

  const toggleHistory = (taskId: string) => {
    setHistoryTaskId((cur) => {
      const next = cur === taskId ? null : taskId;
      if (next) void loadRuns(next);
      return next;
    });
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
    setRunningId(task.id);
    try {
      const run = await api.runTaskNow(task.id);
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
      setRunningId(null);
    }
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
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <Modal onClose={onClose} width="880px">
        <ModalHeader onClose={onClose} closeLabel={t("taskManagerClose")}>
          {t("taskManagerTitle")}
        </ModalHeader>
        <ModalBody>
          {showForm ? (
            <TaskForm
              profiles={profiles}
              task={editing}
              onCancel={() => {
                setShowForm(false);
                setEditing(null);
              }}
              onSaved={async () => {
                setShowForm(false);
                setEditing(null);
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
                  onClick={() => {
                    setEditing(null);
                    setShowForm(true);
                  }}
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
                <Switch checked={catchUpMissed} onChange={(v) => void handleToggleCatchUp(v)} size="sm" />
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
                <EmptyState illustration={<NoResultsIllustration />} icon="clock" title={t("taskEmpty")} />
              ) : (
                <chakra.div display="flex" flexDirection="column" gap="2">
                  {sorted.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      profileName={profileName(task.profile_id)}
                      now={now}
                      running={runningId === task.id}
                      expanded={historyTaskId === task.id}
                      runs={historyTaskId === task.id ? runs : []}
                      runsLoading={historyTaskId === task.id && runsLoading}
                      onToggleEnabled={() => void handleToggleEnabled(task)}
                      onEdit={() => {
                        setEditing(task);
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

function TaskRow({
  task,
  profileName,
  now,
  running,
  expanded,
  runs,
  runsLoading,
  onToggleEnabled,
  onEdit,
  onDelete,
  onRunNow,
  onToggleHistory,
  onClearHistory,
}: {
  task: TaskDefinition;
  profileName: string;
  now: Date;
  running: boolean;
  expanded: boolean;
  runs: TaskRun[];
  runsLoading: boolean;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onToggleHistory: () => void;
  onClearHistory: () => void;
}) {
  const t = useT();
  const rel = relativeNextRun(task.next_run_at, now);
  return (
    <chakra.div border="1px solid" borderColor="app.border" borderRadius="md" overflow="hidden">
      <Flex align="center" gap="3" px="3" py="2.5" flexWrap="wrap">
        <Switch checked={task.enabled} onChange={onToggleEnabled} aria-label={t("taskToggleEnabled", { name: task.name })} />
        <chakra.div flex="1" minW="180px">
          <chakra.div fontWeight={600} color="app.text">
            {task.name}
          </chakra.div>
          <chakra.div fontSize="xs" color="app.textMuted">
            {profileName} · {summarizeAction(task.action)} · {summarizeSchedule(task.schedule)}
          </chakra.div>
        </chakra.div>
        <chakra.div fontSize="xs" color="app.textMuted" minW="90px" textAlign="right">
          {task.enabled ? (
            <>
              {t("taskNextRun")}: {rel ? rel : "–"}
            </>
          ) : (
            t("taskDisabled")
          )}
        </chakra.div>
        <chakra.div fontSize="xs" minW="70px" textAlign="right">
          {task.last_status === "ok" && (
            <chakra.span color="app.textMuted">{t("taskLastOk")}</chakra.span>
          )}
          {task.last_status === "error" && (
            <chakra.span color="var(--status-error)">{t("taskLastError")}</chakra.span>
          )}
          {!task.last_status && <chakra.span color="app.textMuted">–</chakra.span>}
        </chakra.div>
        <Flex gap="1.5">
          <Tooltip label={t("taskRunNow")}>
            <Button type="button" onClick={onRunNow} disabled={running} aria-label={t("taskRunNow")}>
              {running ? <Spinner size={14} /> : <Icon name="query" size={ICON_SIZES.sm} />}
            </Button>
          </Tooltip>
          <Tooltip label={t("taskHistory")}>
            <Button type="button" onClick={onToggleHistory} aria-label={t("taskHistory")}>
              <Icon name="clock" size={ICON_SIZES.sm} />
            </Button>
          </Tooltip>
          <Tooltip label={t("taskEdit")}>
            <Button type="button" onClick={onEdit} aria-label={t("taskEdit")}>
              <Icon name="tools" size={ICON_SIZES.sm} />
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
        <chakra.div borderTop="1px solid" borderColor="app.border" bg="app.toolbar" px="3" py="2.5">
          {runsLoading ? (
            <Spinner size={14} />
          ) : runs.length === 0 ? (
            <chakra.p margin={0} fontSize="xs" color="app.textMuted">
              {t("taskHistoryEmpty")}
            </chakra.p>
          ) : (
            <chakra.div display="flex" flexDirection="column" gap="1.5">
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
                  color={r.status === "ok" ? "app.textMuted" : "var(--status-error)"}
                >
                  <chakra.span minW="170px">{new Date(r.started_at).toLocaleString()}</chakra.span>
                  <chakra.span minW="50px">{r.status}</chakra.span>
                  {r.catch_up && <chakra.span>({t("taskRunCatchUp")})</chakra.span>}
                  {r.output_path && <chakra.span flex="1" wordBreak="break-all">{r.output_path}</chakra.span>}
                  {r.rows != null && <chakra.span>{t("taskRunRows", { rows: r.rows })}</chakra.span>}
                  {r.bytes != null && <chakra.span>{t("taskRunBytes", { bytes: r.bytes })}</chakra.span>}
                  {r.error && <chakra.span flex="1" wordBreak="break-all">{r.error}</chakra.span>}
                </chakra.div>
              ))}
            </chakra.div>
          )}
        </chakra.div>
      )}
    </chakra.div>
  );
}

type ActionKind = TaskAction["kind"];
type ScheduleKind = TaskSchedule["kind"];

function TaskForm({
  profiles,
  task,
  onCancel,
  onSaved,
}: {
  profiles: ConnectionProfile[];
  task: TaskDefinition | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [name, setName] = useState(task?.name ?? "");
  const [profileId, setProfileId] = useState(task?.profile_id ?? profiles[0]?.id ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);

  const [actionKind, setActionKind] = useState<ActionKind>(task?.action.kind ?? "export_query");
  const [sql, setSql] = useState(task?.action.kind === "export_query" ? task.action.sql : "");
  const [database, setDatabase] = useState(
    task?.action.kind === "export_query" ? task.action.database ?? "" : task?.action.kind === "dump" ? task.action.database : "",
  );
  const [format, setFormat] = useState<ExportFormat>(
    task?.action.kind === "export_query" ? task.action.format : "csv",
  );
  const [sqlTable, setSqlTable] = useState(
    task?.action.kind === "export_query" ? task.action.sql_table ?? "" : "",
  );
  const [sqlBatchSize, setSqlBatchSize] = useState(
    task?.action.kind === "export_query" && task.action.sql_batch_size ? String(task.action.sql_batch_size) : "",
  );
  const [outputPath, setOutputPath] = useState(task?.action.output_path ?? "");
  const [dumpOptions, setDumpOptions] = useState<DumpOptions>(
    task?.action.kind === "dump" ? task.action.options : DEFAULT_DUMP_OPTIONS,
  );

  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(task?.schedule.kind ?? "interval");
  const [intervalMinutes, setIntervalMinutes] = useState(
    task?.schedule.kind === "interval" ? String(task.schedule.minutes) : "60",
  );
  const [dailyHour, setDailyHour] = useState(task?.schedule.kind === "daily" ? String(task.schedule.hour) : "9");
  const [dailyMinute, setDailyMinute] = useState(task?.schedule.kind === "daily" ? String(task.schedule.minute) : "0");

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
    const ext = actionKind === "dump" ? "sql" : format === "json" ? "json" : format === "ndjson" ? "ndjson" : format === "markdown" ? "md" : format === "sql" ? "sql" : "csv";
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
    if (outputPath.trim() === "") {
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
      action = {
        kind: "export_query",
        sql,
        database: database.trim() === "" ? null : database.trim(),
        format,
        output_path: outputPath,
        sql_table: format === "sql" && sqlTable.trim() !== "" ? sqlTable.trim() : null,
        sql_batch_size: format === "sql" && sqlBatchSize.trim() !== "" ? Number(sqlBatchSize) : null,
      };
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

    const schedule: TaskSchedule =
      scheduleKind === "interval"
        ? { kind: "interval", minutes: Math.max(1, Number(intervalMinutes) || 1) }
        : {
            kind: "daily",
            hour: Math.min(23, Math.max(0, Number(dailyHour) || 0)),
            minute: Math.min(59, Math.max(0, Number(dailyMinute) || 0)),
          };

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
        id: task?.id ?? null,
        name: name.trim(),
        profile_id: profileId,
        action,
        schedule,
        enabled,
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
    <chakra.div display="flex" flexDirection="column" gap="14px">
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
              <chakra.p margin={0} marginTop="1" fontSize="xs" color="var(--status-error)">
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
            <Select id="task-format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
              {EXPORT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(EXPORT_FORMAT_LABEL_KEYS[f])}
                </option>
              ))}
            </Select>
          </FormSection>
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
                <chakra.label key={key} display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" color="app.textSecondary">
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

      <FormSection>
        <FieldLabel as="div">{t("taskFormSchedule")}</FieldLabel>
        <Flex gap="3" align="center" flexWrap="wrap">
          <Select
            value={scheduleKind}
            onChange={(e) => setScheduleKind(e.target.value as ScheduleKind)}
            width="auto"
          >
            <option value="interval">{t("taskScheduleInterval")}</option>
            <option value="daily">{t("taskScheduleDaily")}</option>
          </Select>
          {scheduleKind === "interval" ? (
            <Flex align="center" gap="1.5">
              <Input
                type="number"
                min={1}
                width="90px"
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
              />
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("taskScheduleMinutes")}
              </chakra.span>
            </Flex>
          ) : (
            <Flex align="center" gap="1.5">
              <Input
                type="number"
                min={0}
                max={23}
                width="70px"
                value={dailyHour}
                onChange={(e) => setDailyHour(e.target.value)}
              />
              <chakra.span>:</chakra.span>
              <Input
                type="number"
                min={0}
                max={59}
                width="70px"
                value={dailyMinute}
                onChange={(e) => setDailyMinute(e.target.value)}
              />
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("taskScheduleUtcHint")}
              </chakra.span>
            </Flex>
          )}
        </Flex>
      </FormSection>

      <chakra.label display="inline-flex" alignItems="center" gap="1.5">
        <Switch checked={enabled} onChange={setEnabled} />
        <chakra.span fontSize="sm" color="app.textSecondary">
          {t("taskFormEnabled")}
        </chakra.span>
      </chakra.label>

      {formError && <ErrorNote>{formError}</ErrorNote>}

      <Flex gap="2" justify="flex-end">
        <Button type="button" onClick={onCancel} disabled={saving}>
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
