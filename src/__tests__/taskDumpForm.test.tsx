import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { chooseListboxOption, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import { api, type DumpOptions, type TaskDefinition } from "../api/tauri";

/**
 * タスクスケジューラのダンプ設定が DumpModal と同じ部品で、全オプション (内蔵エンジン・gzip・
 * チェックサム・マスキング・PostgreSQL / MySQL 固有) を扱えること (#2131)。
 */

const listTasks = vi.fn();
const dumpToolStatus = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTasks: (...args: unknown[]) => listTasks(...args),
      listTaskRuns: vi.fn().mockResolvedValue([]),
      saveTask: vi.fn(),
      previewTaskSchedule: vi.fn().mockResolvedValue([]),
      getSchedulerSettings: vi.fn().mockResolvedValue({ catch_up_missed: false }),
      listAssertions: vi.fn().mockResolvedValue([]),
      dumpToolStatus: (...args: unknown[]) => dumpToolStatus(...args),
    },
    listenTaskRunEvents: vi.fn().mockResolvedValue(() => {}),
    listenTaskRunProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

import { TaskManager } from "../components/TaskManager";

const BASE_OPTIONS: DumpOptions = {
  singleTransaction: true,
  routines: false,
  events: false,
  triggers: true,
  addDropTable: true,
  extendedInsert: true,
  completeInsert: false,
  noData: false,
  noCreateInfo: false,
};

function dumpTask(options: DumpOptions): TaskDefinition {
  return {
    id: "task-d",
    name: "Nightly dump",
    profile_id: "p-test",
    action: { kind: "dump", database: "appdb", output_path: "/tmp/out.sql", options },
    schedule: { kind: "interval", minutes: 60 },
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    connect_retry: { max_retries: 0, interval_secs: 30 },
    pause_after_failures: 0,
    consecutive_failures: 0,
    auto_paused_at: null,
  };
}

async function openEdit(task: TaskDefinition, driver = "mysql") {
  listTasks.mockResolvedValue([task]);
  const user = userEvent.setup();
  renderWithProviders(<TaskManager profiles={[makeProfile({ driver })]} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText(task.name)).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: t("taskEdit") }));
  await screen.findByLabelText(t("taskFormName"));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  dumpToolStatus.mockResolvedValue({ tool: "mysqldump", path: "/usr/bin/mysqldump", install: null });
});

describe("タスクのダンプ設定 (#2131)", () => {
  it("エンジン選択・グループ化されたスイッチが DumpModal と同じ部品で出る", async () => {
    await openEdit(dumpTask(BASE_OPTIONS));
    expect(screen.getByTestId("dump-engine-native")).toBeInTheDocument();
    expect(screen.getByTestId("dump-engine-external")).toBeInTheDocument();
    for (const g of ["structure", "data", "output", "compat"]) {
      expect(screen.getByTestId(`dump-group-${g}`)).toBeInTheDocument();
    }
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: t("dumpOptChecksum") })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: t("dumpOptGtidPurgedOff") })).toBeInTheDocument();
  });

  it("保存済みの内蔵エンジン・gzip・チェックサム・マスクが編集画面で再現され、そのまま保存される", async () => {
    const options: DumpOptions = {
      ...BASE_OPTIONS,
      native: true,
      gzip: true,
      writeChecksum: true,
      masks: [{ column: "email", rule: { kind: "null" } }],
    };
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockResolvedValue(dumpTask(options));
    const user = await openEdit(dumpTask(options));

    expect(screen.getByTestId("dump-engine-native")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptChecksum") })).toBeChecked();
    expect(screen.getByText("email")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    await waitFor(() => expect(saveTask).toHaveBeenCalled());
    const saved = saveTask.mock.calls[0][0].action;
    expect(saved.kind).toBe("dump");
    if (saved.kind !== "dump") return;
    expect(saved.options).toMatchObject({
      native: true,
      gzip: true,
      writeChecksum: true,
      masks: [{ column: "email", rule: { kind: "null" } }],
      // 内蔵生成では外部ツール向けの項目が強制値になる (DumpModal と同じ)。
      singleTransaction: false,
      completeInsert: true,
    });
  });

  it("旧データ (項目が少ない) を開いても、新規の既定値を混ぜない", async () => {
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockResolvedValue(dumpTask(BASE_OPTIONS));
    const user = await openEdit(dumpTask(BASE_OPTIONS));
    expect(screen.getByTestId("dump-engine-external")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    await waitFor(() => expect(saveTask).toHaveBeenCalled());
    const saved = saveTask.mock.calls[0][0].action;
    if (saved.kind !== "dump") throw new Error("dump expected");
    expect(saved.options.native).toBeFalsy();
    expect(saved.options.masks).toBeUndefined();
    expect(saved.options.routines).toBe(false);
  });

  it("外部ツールが未導入のとき、無人実行が失敗する旨を警告する", async () => {
    dumpToolStatus.mockResolvedValue({ tool: "mysqldump", path: null, install: null });
    await openEdit(dumpTask(BASE_OPTIONS));
    expect(await screen.findByText(t("taskFormDumpToolMissing", { tool: "mysqldump" }))).toBeInTheDocument();
  });

  it("マスクが残ったまま外部ツールにすると保存を止める", async () => {
    const options: DumpOptions = {
      ...BASE_OPTIONS,
      native: true,
      masks: [{ column: "email", rule: { kind: "null" } }],
    };
    const saveTask = vi.mocked(api.saveTask);
    const user = await openEdit(dumpTask(options));
    await user.click(screen.getByTestId("dump-engine-external"));
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    expect(await screen.findByText(t("taskFormDumpMasksNeedNative"))).toBeInTheDocument();
    expect(saveTask).not.toHaveBeenCalled();
  });

  it("PostgreSQL ではスキーマ入力が出る", async () => {
    await openEdit(dumpTask(BASE_OPTIONS), "postgres");
    expect(screen.getByLabelText(t("dumpOptPgSchema"))).toBeInTheDocument();
  });

  it("SQLite はエンジン選択もマスキングも出さない", async () => {
    await openEdit(dumpTask(BASE_OPTIONS), "sqlite");
    expect(screen.queryByTestId("dump-engine-native")).toBeNull();
    expect(screen.queryByText(t("taskFormDumpMaskHint"))).toBeNull();
    expect(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") })).toBeInTheDocument();
  });

  it("SQLite ではマスクが残っていても無視して空で送る", async () => {
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockResolvedValue(dumpTask(BASE_OPTIONS));
    // 旧データ: マスクつきのタスクを SQLite プロファイルで開く (マスク欄は描かれない)。
    const user = await openEdit(
      dumpTask({ ...BASE_OPTIONS, native: true, masks: [{ column: "email", rule: { kind: "null" } }] }),
      "sqlite",
    );
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    await waitFor(() => expect(saveTask).toHaveBeenCalled());
    const saved = saveTask.mock.calls[0][0].action;
    if (saved.kind !== "dump") throw new Error("dump expected");
    expect(saved.options.masks).toBeUndefined();
  });

  it("現在のドライバで表示されない真偽値は既定値に戻して送る (SQLite のスナップショットの名残)", async () => {
    const saveTask = vi.mocked(api.saveTask);
    saveTask.mockResolvedValue(dumpTask(BASE_OPTIONS));
    const user = await openEdit(
      dumpTask({ ...BASE_OPTIONS, sqliteSnapshot: true, addDropTable: true }),
      "mysql",
    );
    await user.click(screen.getByRole("button", { name: t("taskFormSave") }));
    await waitFor(() => expect(saveTask).toHaveBeenCalled());
    const saved = saveTask.mock.calls[0][0].action;
    if (saved.kind !== "dump") throw new Error("dump expected");
    expect(saved.options.sqliteSnapshot).toBe(false);
    // スナップショットの名残で、MySQL で有効な addDropTable が強制 OFF にされない。
    expect(saved.options.addDropTable).toBe(true);
  });

  it("新規タスクで外部ツールが未導入なら内蔵エンジンが初期選択になる (既存タスクは保存値のまま)", async () => {
    dumpToolStatus.mockResolvedValue({ tool: "mysqldump", path: null, install: null });
    listTasks.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<TaskManager profiles={[makeProfile()]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(t("taskEmpty"))).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: t("taskCreate") })[0]);
    await screen.findByLabelText(t("taskFormName"));
    chooseListboxOption(screen.getByLabelText(t("taskFormActionKind")), "dump");
    await waitFor(() =>
      expect(screen.getByTestId("dump-engine-native")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("dump-engine-external")).toBeDisabled();
  });

  it("既存タスクは未導入でも保存値 (外部ツール) のまま開く", async () => {
    dumpToolStatus.mockResolvedValue({ tool: "mysqldump", path: null, install: null });
    await openEdit(dumpTask(BASE_OPTIONS));
    await screen.findByText(t("taskFormDumpToolMissing", { tool: "mysqldump" }));
    expect(screen.getByTestId("dump-engine-external")).toHaveAttribute("aria-pressed", "true");
  });

  it("gzip を切り替えると出力パスの拡張子が追従する", async () => {
    await openEdit(dumpTask(BASE_OPTIONS));
    const input = screen.getByLabelText(t("taskFormOutputPath"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: t("dumpOptGzip") }));
    expect(input).toHaveValue("/tmp/out.sql.gz");
    await user.click(screen.getByRole("switch", { name: t("dumpOptGzip") }));
    expect(input).toHaveValue("/tmp/out.sql");
    fireEvent.change(input, { target: { value: "/tmp/custom.bak" } });
    await user.click(screen.getByRole("switch", { name: t("dumpOptGzip") }));
    expect(input).toHaveValue("/tmp/custom.bak");
  });
});
