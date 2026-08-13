import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { TaskDefinition, TaskRun } from "../api/tauri";

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
};

// `vi.mock` のファクトリはファイル先頭へホイストされるため、`TASK`/`RUN` の
// ような通常の const 初期化より先に評価される。ファクトリの中で直接参照すると
// TDZ (Cannot access before initialization) になるので、ここでは `vi.fn()`
// の参照だけをクロージャ越しに渡し、実際の戻り値は `beforeEach` (モジュール
// 初期化が終わったあと) で設定する。
const listTasks = vi.fn();
const listTaskRuns = vi.fn();
const clearTaskRuns = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTasks: (...args: unknown[]) => listTasks(...args),
      listTaskRuns: (...args: unknown[]) => listTaskRuns(...(args as [string, number])),
      clearTaskRuns: (...args: unknown[]) => clearTaskRuns(...(args as [string])),
      getSchedulerSettings: vi.fn().mockResolvedValue({ catch_up_missed: false }),
      setSchedulerSettings: vi.fn(),
    },
    listenTaskRunEvents: vi.fn().mockResolvedValue(() => {}),
  };
});

import { TaskManager } from "../components/TaskManager";

beforeEach(() => {
  vi.clearAllMocks();
  listTasks.mockResolvedValue([TASK]);
  listTaskRuns.mockResolvedValue([RUN]);
  clearTaskRuns.mockResolvedValue(1);
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
