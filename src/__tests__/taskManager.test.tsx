import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { clearTaskFormatCache } from "../taskFormat";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor, within } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import { api, type TaskDefinition, type TaskRun } from "../api/tauri";

/**
 * タスクスケジューラ管理画面の実行履歴消去アクション (#910)。
 * `clear_task_runs` は既にバックエンド/`tauri.ts` ラッパーとも実装済みで、
 * このパネルからの導線が欠けていた分を埋める。危険確認 (`useConfirm`, tone
 * "danger") を経ること、確認後に一覧が空になること、履歴が元々空のときは
 * 消去アクション自体を出さないことを固定する。
 */

const TASK: TaskDefinition = {
  id: "task-1",
  name: "Nightly export",
  profile_id: "p-test",
  action: {
    kind: "export_query",
    sql: "SELECT 1",
    database: null,
    format: "csv",
    output_path: "/tmp/out.csv",
  },
  schedule: { kind: "interval", minutes: 60 },
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  next_run_at: null,
  last_run_at: null,
  last_status: "ok",
  connect_retry: { max_retries: 0, interval_secs: 30 },
  pause_after_failures: 0,
  consecutive_failures: 0,
  auto_paused_at: null,
};

const RUN: TaskRun = {
  id: 1,
  task_id: "task-1",
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:05Z",
  status: "ok",
  error: null,
  output_path: "/tmp/out.csv",
  rows: 10,
  bytes: 100,
  elapsed_ms: 5000,
  catch_up: false,
  attempts: 1,
};

// `vi.mock` のファクトリはファイル先頭へホイストされるため、`TASK`/`RUN` の
// ような通常の const 初期化より先に評価される。ファクトリの中で直接参照すると
// TDZ (Cannot access before initialization) になるので、ここでは `vi.fn()`
// の参照だけをクロージャ越しに渡し、実際の戻り値は `beforeEach` (モジュール
// 初期化が終わったあと) で設定する。
const listTasks = vi.fn();
const listTaskRuns = vi.fn();
const clearTaskRuns = vi.fn();
const runTaskNow = vi.fn();
const cancelStream = vi.fn();
let progressHandler: ((e: import("../api/tauri").TaskRunProgressEvent) => void) | null = null;
const getSchedulerSettings = vi.fn();
const previewTaskSchedule = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTasks: (...args: unknown[]) => listTasks(...args),
      listTaskRuns: (...args: unknown[]) => listTaskRuns(...(args as [string, number])),
      clearTaskRuns: (...args: unknown[]) => clearTaskRuns(...(args as [string])),
      saveTask: vi.fn(),
      previewTaskSchedule: (...args: unknown[]) => previewTaskSchedule(...args),
      getSchedulerSettings: (...args: unknown[]) => getSchedulerSettings(...args),
      setSchedulerSettings: vi.fn(),
      runTaskNow: (...args: unknown[]) => runTaskNow(...args),
      cancelStream: (...args: unknown[]) => cancelStream(...args),
    },
    listenTaskRunEvents: vi.fn().mockResolvedValue(() => {}),
    listenTaskRunProgress: vi.fn(
      async (_id: string, h: (e: import("../api/tauri").TaskRunProgressEvent) => void) => {
        progressHandler = h;
        return () => {};
      },
    ),
  };
});

import { TaskManager } from "../components/TaskManager";

beforeEach(() => {
  vi.clearAllMocks();
  listTasks.mockResolvedValue([TASK]);
  listTaskRuns.mockResolvedValue([RUN]);
  clearTaskRuns.mockResolvedValue(1);
  getSchedulerSettings.mockResolvedValue({ catch_up_missed: false });
});

describe("TaskManager 今すぐ実行の中断・進捗 (#1534)", () => {
  it("実行中は進捗を表示し、中断ボタンで streamId を cancelStream へ渡す", async () => {
    let finish: (r: typeof RUN) => void = () => {};
    runTaskNow.mockImplementation(() => new Promise<typeof RUN>((res) => (finish = res)));
    cancelStream.mockResolvedValue({ cancelled: true, deliveredRows: 0 });
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: t("taskRunNow") }));
    await waitFor(() => expect(runTaskNow).toHaveBeenCalledTimes(1));
    const [taskId, streamId] = runTaskNow.mock.calls[0];
    expect(taskId).toBe("task-1");
    expect(typeof streamId).toBe("string");

    await waitFor(() => expect(progressHandler).not.toBeNull());
    act(() => progressHandler?.({ streamId, taskId: "task-1", count: 1234, unit: "rows" }));
    expect(screen.getByTestId("task-run-progress").textContent).toContain("1,234");

    await user.click(screen.getByRole("button", { name: t("taskRunStop") }));
    expect(cancelStream).toHaveBeenCalledWith(streamId);

    // 中断された実行は error の TaskRun として返り、進行中表示が消える。
    await act(async () => finish({ ...RUN, status: "error", error: "cancelled by user" }));
    await waitFor(() => expect(screen.queryByTestId("task-run-progress")).toBeNull());
  });

  it("どれかが実行中のあいだは全タスクの「今すぐ実行」が無効になり、終了後に戻る", async () => {
    let finish: (r: typeof RUN) => void = () => {};
    runTaskNow.mockImplementation(() => new Promise<typeof RUN>((res) => (finish = res)));
    listTasks.mockResolvedValue([TASK, { ...TASK, id: "task-2", name: "Second task" }]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Second task")).toBeInTheDocument());

    const runButtons = () => screen.getAllByRole("button", { name: t("taskRunNow") });
    expect(runButtons()).toHaveLength(2);
    await user.click(runButtons()[0]);
    await waitFor(() => expect(runTaskNow).toHaveBeenCalledTimes(1));
    for (const b of runButtons()) expect(b).toBeDisabled();
    expect(screen.getAllByRole("button", { name: t("taskRunStop") })).toHaveLength(1);

    await act(async () => finish(RUN));
    await waitFor(() => {
      for (const b of runButtons()) expect(b).toBeEnabled();
    });
  });
});

describe("TaskManager 実行履歴の消去 (#910)", () => {
  it("危険確認を経て clearTaskRuns を呼び、一覧が空になる", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: t("taskHistory") }));
    await waitFor(() => expect(listTaskRuns).toHaveBeenCalledWith("task-1", 50));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("taskHistoryClear") })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: t("taskHistoryClear") }));

    const dialogs = await screen.findAllByRole("dialog");
    const confirmDialog = within(dialogs[dialogs.length - 1]);
    await user.click(confirmDialog.getByRole("button", { name: t("taskHistoryClear") }));

    await waitFor(() => expect(clearTaskRuns).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(screen.getByText(t("taskHistoryEmpty"))).toBeInTheDocument());
  });

  it("実行履歴が空のときは消去アクションを表示しない", async () => {
    listTaskRuns.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: t("taskHistory") }));

    await waitFor(() => expect(screen.getByText(t("taskHistoryEmpty"))).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: t("taskHistoryClear") })).not.toBeInTheDocument();
  });
});

describe("TaskManager 実行履歴の取得競合 (#1594)", () => {
  it("履歴の応答が遅れても、後から開いた別タスクの欄に前のタスクの履歴は入らない", async () => {
    let resolveA: (r: TaskRun[]) => void = () => {};
    listTasks.mockResolvedValue([TASK, { ...TASK, id: "task-2", name: "Second task" }]);
    listTaskRuns.mockImplementation((id: string) =>
      id === "task-1"
        ? new Promise<TaskRun[]>((res) => (resolveA = res))
        : Promise.resolve([{ ...RUN, id: 2, task_id: "task-2", output_path: "/tmp/b.csv" }]),
    );
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Second task")).toBeInTheDocument());

    const buttons = screen.getAllByRole("button", { name: t("taskHistory") });
    await user.click(buttons[0]);
    await user.click(buttons[1]);
    await waitFor(() => expect(screen.getByText("/tmp/b.csv")).toBeInTheDocument());

    await act(async () => resolveA([{ ...RUN, id: 1, output_path: "/tmp/a.csv" }]));
    expect(screen.queryByText("/tmp/a.csv")).toBeNull();
    expect(screen.getByText("/tmp/b.csv")).toBeInTheDocument();
  });
});

describe("TaskManager 空状態の CTA (#1272)", () => {
  it("タスクが 0 件のとき空状態の「新規タスク」から作成フォームを開ける", async () => {
    listTasks.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(t("taskEmpty"))).toBeInTheDocument());
    // ヘッダ + 空状態の 2 つ
    const buttons = screen.getAllByRole("button", { name: t("taskCreate") });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);
    await waitFor(() => expect(screen.getByText(t("taskFormName"))).toBeInTheDocument());
  });

  it("プロファイルが無いときは空状態に CTA を出さない", async () => {
    listTasks.mockResolvedValue([]);
    renderWithProviders(<TaskManager profiles={[]} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(t("taskEmpty"))).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: t("taskCreate") })).toHaveLength(1);
  });
});

describe("TaskManager スケジューラ設定の取得 (#1534)", () => {
  it("取得に失敗したらエラーを知らせ、取得できるまで追い掛け実行のトグルを無効にする", async () => {
    getSchedulerSettings.mockRejectedValue("settings store unavailable");
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());
    await waitFor(() =>
      expect(
        screen.getByText(t("taskSchedulerSettingsLoadError", { error: "settings store unavailable" })),
      ).toBeInTheDocument(),
    );
    const toggle = screen.getByRole("switch", { name: t("taskCatchUpMissed") });
    expect(toggle).toBeDisabled();
  });

  it("取得できたら実際の値を反映し、トグルを操作できる", async () => {
    getSchedulerSettings.mockResolvedValue({ catch_up_missed: true });
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);

    const toggle = await screen.findByRole("switch", { name: t("taskCatchUpMissed") });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

describe("TaskForm 日次スケジュールの保存 (#1621)", () => {
  const prevTz = process.env.TZ;
  beforeAll(() => {
    // 端末のタイムゾーンを JST に固定する (新規の既定タイムゾーンに使われる)。
    process.env.TZ = "Asia/Tokyo";
    clearTaskFormatCache();
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
    clearTaskFormatCache();
  });
  beforeEach(() => {
    previewTaskSchedule.mockResolvedValue([
      "2026-01-05T00:00:00Z",
      "2026-01-06T00:00:00Z",
      "2026-01-07T00:00:00Z",
      "2026-01-08T00:00:00Z",
      "2026-01-09T00:00:00Z",
    ]);
  });

  it("旧データ (タイムゾーンなし) は UTC として開き、時刻・タイムゾーン・曜日・停止回数がそのまま saveTask に渡る", async () => {
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockResolvedValue(TASK);
    listTasks.mockResolvedValue([{ ...TASK, schedule: { kind: "daily", hour: 0, minute: 5 } }]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: t("taskEdit") }));

    // 保存済みの UTC 00:05 は、換算せずそのまま UTC として見える。
    const hour = await screen.findByLabelText(t("taskScheduleHour"));
    const minute = screen.getByLabelText(t("taskScheduleMinute"));
    expect(hour).toHaveValue(0);
    expect(minute).toHaveValue(5);
    expect(screen.getByLabelText(t("taskScheduleTimezone"))).toHaveValue("UTC");
    expect(screen.getByText(t("taskScheduleLegacyUtcNote"))).toBeInTheDocument();

    // タイムゾーンを東京、時刻 10:30、平日のみに変える。
    await user.selectOptions(screen.getByLabelText(t("taskScheduleTimezone")), "Asia/Tokyo");
    await user.clear(hour);
    await user.type(hour, "10");
    await user.clear(minute);
    await user.type(minute, "30");
    await user.click(screen.getByRole("button", { name: t("taskScheduleWorkdaysPreset") }));
    await user.clear(screen.getByLabelText(t("taskFormPauseAfterFailures")));
    await user.type(screen.getByLabelText(t("taskFormPauseAfterFailures")), "3");
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));

    await waitFor(() => expect(saveTask).toHaveBeenCalled());
    const req = saveTask.mock.calls[0][0];
    expect(req.schedule).toEqual({
      kind: "daily",
      hour: 10,
      minute: 30,
      timezone: "Asia/Tokyo",
      weekdays: 0b001_1111,
    });
    expect(req.pause_after_failures).toBe(3);
    expect(req.id).toBe("task-1");
  });

  it("新規タスクは端末のタイムゾーンの毎日・連続失敗 5 回で始まり、曜日を全部外すと保存できない", async () => {
    listTasks.mockResolvedValue([]);
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockClear();
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(t("taskEmpty"))).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: t("taskCreate") })[0]);
    await user.type(await screen.findByLabelText(t("taskFormName")), "Weekly");
    await user.type(screen.getByLabelText(t("taskFormOutputPath")), "/tmp/out.csv");
    await user.type(screen.getByLabelText(t("taskFormSql")), "SELECT 1");
    expect(screen.getByLabelText(t("taskFormPauseAfterFailures"))).toHaveValue(5);

    await user.selectOptions(screen.getByDisplayValue(t("taskScheduleInterval")), "daily");
    expect(screen.getByLabelText(t("taskScheduleTimezone"))).toHaveValue("Asia/Tokyo");
    // 全曜日のチェックを外すと検証エラーになり、保存は呼ばれない。
    const group = screen.getByRole("group", { name: t("taskScheduleWeekdays") });
    for (const box of within(group).getAllByRole("checkbox")) await user.click(box);
    expect(screen.getByText(t("taskScheduleWeekdaysRequired"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    expect(saveTask).not.toHaveBeenCalled();
  });

  it("スケジュール編集中は、バックエンドの計算結果を端末のローカル時刻と JST で次の 5 回ぶん並べる", async () => {
    listTasks.mockResolvedValue([
      { ...TASK, schedule: { kind: "daily", hour: 9, minute: 0, timezone: "UTC", weekdays: 0 } },
    ]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: t("taskEdit") }));
    const preview = await screen.findByTestId("task-schedule-preview");
    await waitFor(() => expect(within(preview).getAllByRole("row")).toHaveLength(6)); // 見出し + 5 回
    expect(previewTaskSchedule).toHaveBeenLastCalledWith(
      { kind: "daily", hour: 9, minute: 0, timezone: "UTC", weekdays: 0 },
      5,
    );
  });

  it("複製は元の設定を雛形にした新規タスクとして保存される (id なし・名前に「コピー」)", async () => {
    previewTaskSchedule.mockResolvedValue([]);
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockClear();
    saveTask.mockResolvedValue({ ...TASK, id: "copy" });
    listTasks.mockResolvedValue([TASK]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(TASK.name)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: t("taskDuplicate") }));
    expect(await screen.findByLabelText(t("taskFormName"))).toHaveValue(
      t("taskDuplicateName", { name: TASK.name }),
    );
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    await waitFor(() => expect(saveTask).toHaveBeenCalled());
    const req = saveTask.mock.calls[0][0];
    expect(req.id).toBeNull();
    expect(req.name).toBe(t("taskDuplicateName", { name: TASK.name }));
    expect(req.action).toEqual({ ...TASK.action, sql_table: null, sql_batch_size: null });
  });

  it("連続失敗で自動停止したタスクには、その旨を行に表示する", async () => {
    listTasks.mockResolvedValue([
      {
        ...TASK,
        enabled: false,
        consecutive_failures: 5,
        pause_after_failures: 5,
        auto_paused_at: "2026-01-02T00:00:00Z",
      },
    ]);
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    expect(await screen.findByTestId("task-auto-paused")).toHaveTextContent(
      t("taskAutoPausedBadge", { n: 5 }),
    );
  });
});

describe("TaskManager 取得系アクションと接続リトライ (#1537)", () => {
  it("タイムラプス取得 + 接続リトライを選んで保存すると、出力先なしのアクションと retry 設定が渡る", async () => {
    listTasks.mockResolvedValue([]);
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockResolvedValue({ ...TASK, id: "new" });
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(t("taskEmpty"))).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: t("taskCreate") })[0]);

    await user.type(await screen.findByLabelText(t("taskFormName")), "Nightly timelapse");
    await user.selectOptions(screen.getByDisplayValue(t("taskFormActionExport")), "timelapse_capture");
    // 出力先は不要 (ファイルを書かないアクション)。
    expect(screen.queryByLabelText(t("taskFormOutputPath"))).not.toBeInTheDocument();
    expect(screen.getByText(t("taskFormTimelapseHint"))).toBeInTheDocument();

    const retries = screen.getByLabelText(t("taskFormConnectRetries"));
    await user.clear(retries);
    await user.type(retries, "3");
    const interval = screen.getByLabelText(t("taskFormConnectRetryInterval"));
    await user.clear(interval);
    await user.type(interval, "45");

    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    await waitFor(() => expect(saveTask).toHaveBeenCalledTimes(1));
    const req = saveTask.mock.calls[0][0];
    expect(req.action).toEqual({ kind: "timelapse_capture", max_generations: null });
    expect(req.connect_retry).toEqual({ max_retries: 3, interval_secs: 45 });
  });

  it("プランウォッチの要約と、接続リトライの試行回数の表示", async () => {
    listTasks.mockResolvedValue([
      {
        ...TASK,
        id: "task-pw",
        name: "Plan watch task",
        action: { kind: "refresh_plan_watch", snippet_ids: [] },
        connect_retry: { max_retries: 2, interval_secs: 30 },
      },
    ]);
    listTaskRuns.mockResolvedValue([{ ...RUN, task_id: "task-pw", attempts: 3 }]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Plan watch task")).toBeInTheDocument());
    expect(screen.getByText(t("taskSummaryPlanWatchAll"), { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("taskHistory") }));
    await waitFor(() => expect(screen.getByText(`(${t("taskRunAttempts", { n: 3 })})`)).toBeInTheDocument());
  });
});

describe("TaskManager 初回読み込み (#1617)", () => {
  it("一覧を取得するまでは「タスクがありません」を出さない", async () => {
    let resolve: (v: TaskDefinition[]) => void = () => {};
    listTasks.mockImplementation(() => new Promise<TaskDefinition[]>((res) => (resolve = res)));
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    expect(screen.queryByText(t("taskEmpty"))).toBeNull();
    await act(async () => resolve([]));
    await waitFor(() => expect(screen.getByText(t("taskEmpty"))).toBeInTheDocument());
  });
});
