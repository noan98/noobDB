// `src-tauri/src/commands/tasks.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  TaskDefinition,
  SaveTaskRequest,
  TaskRun,
  AssertionRunRecord,
  SchedulerSettings,
} from "../tauri";

export const tasksCommands = {

  // --- タスクスケジューラ (#730) ---

  listTasks: () =>
    invoke<TaskDefinition[]>("list_tasks").then((r) =>
      parseResponse(schemas.taskDefinitionArray, r, "list_tasks"),
    ),
  saveTask: (req: SaveTaskRequest) =>
    invoke<TaskDefinition>("save_task", { req }).then((r) =>
      parseResponse(schemas.taskDefinition, r, "save_task"),
    ),
  deleteTask: (id: string) => invoke<void>("delete_task", { id }),
  setTaskEnabled: (id: string, enabled: boolean) =>
    invoke<TaskDefinition>("set_task_enabled", { id, enabled }).then((r) =>
      parseResponse(schemas.taskDefinition, r, "set_task_enabled"),
    ),
  /** タスクを即座に 1 回実行する (有効/無効を問わない)。完了までブロックする —
   *  ダンプ等は数分かかりうるので、呼び出し側で進行中表示を出すこと。 */
  runTaskNow: (id: string) =>
    invoke<TaskRun>("run_task_now", { id }).then((r) =>
      parseResponse(schemas.taskRun, r, "run_task_now"),
    ),
  listTaskRuns: (taskId?: string | null, limit?: number) =>
    invoke<TaskRun[]>("list_task_runs", {
      taskId: taskId ?? null,
      limit: limit ?? null,
    }).then((r) => parseResponse(schemas.taskRunArray, r, "list_task_runs")),
  /** アサーション実行タスクの合否履歴 (新しい順、#1170)。 */
  listAssertionRuns: (params: {
    taskId?: string | null;
    assertionId?: string | null;
    limit?: number;
  }) =>
    invoke<AssertionRunRecord[]>("list_assertion_runs", {
      taskId: params.taskId ?? null,
      assertionId: params.assertionId ?? null,
      limit: params.limit ?? null,
    }).then((r) =>
      parseResponse(schemas.assertionRunRecordArray, r, "list_assertion_runs"),
    ),
  clearTaskRuns: (taskId?: string | null) =>
    invoke<number>("clear_task_runs", { taskId: taskId ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "clear_task_runs"),
    ),
  getSchedulerSettings: () =>
    invoke<SchedulerSettings>("get_scheduler_settings").then((r) =>
      parseResponse(schemas.schedulerSettings, r, "get_scheduler_settings"),
    ),
  setSchedulerSettings: (settings: SchedulerSettings) =>
    invoke<SchedulerSettings>("set_scheduler_settings", { settings }).then((r) =>
      parseResponse(schemas.schedulerSettings, r, "set_scheduler_settings"),
    ),
};
