import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
import { BroadcastModal } from "../components/BroadcastModal";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import { api, type BroadcastDiff, type BroadcastHandlers } from "../api/tauri";

const handlers = new Map<string, BroadcastHandlers>();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenBroadcast: vi.fn(async (runId: string, h: BroadcastHandlers) => {
      handlers.set(runId, h);
      return () => {};
    }),
    api: {
      ...actual.api,
      broadcastCompare: vi.fn().mockResolvedValue(undefined),
      broadcastSyncSql: vi.fn(),
      cancelStream: vi.fn().mockResolvedValue(undefined),
      releaseDataDiffs: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const BASE = makeProfile({ id: "p-base", name: "Base" });
const ENV = makeProfile({ id: "p-env", name: "Staging" });
const COLUMNS = [
  { name: "id", type_name: "int" },
  { name: "v", type_name: "text" },
];

function diff(partial: Partial<BroadcastDiff>): BroadcastDiff {
  return {
    comparable: true,
    mode: "pk",
    changedCells: [],
    changedCellCount: 0,
    addedRowIndices: [],
    removedCount: 0,
    removedRowIndices: [],
    truncated: false,
    hasDiff: false,
    ...partial,
  };
}

function env(
  sessionId: string,
  status: "done" | "error",
  d: BroadcastDiff | null,
  rows: (number | string)[][],
) {
  return {
    kind: "env" as const,
    sessionId,
    status,
    columns: status === "error" ? [] : COLUMNS,
    rows,
    totalRows: rows.length,
    elapsedMs: 5,
    error: status === "error" ? "connection refused" : null,
    diff: d,
  };
}

function lastRunId(): string {
  const calls = vi.mocked(api.broadcastCompare).mock.calls;
  return calls[calls.length - 1][0].runId;
}

function mount(extra: { table?: string | null; database?: string | null } = {}) {
  return renderWithProviders(
    <BroadcastModal
      sql="SELECT * FROM users"
      driver="mysql"
      baselineSessionId="s-base"
      baselineProfile={BASE}
      candidates={[{ sessionId: "s-env", profile: ENV }]}
      tableColumns={null}
      table={extra.table ?? null}
      database={extra.database ?? null}
      autoLimit={null}
      queryTimeoutSecs={30}
      confirm={vi.fn().mockResolvedValue(true)}
      onClose={() => {}}
    />,
  );
}

async function runAndDeliver(envMsg: ReturnType<typeof env>) {
  fireEvent.click(screen.getByRole("button", { name: t("broadcastPickerRun") }));
  await waitFor(() => expect(api.broadcastCompare).toHaveBeenCalled());
  const h = handlers.get(lastRunId());
  expect(h).toBeDefined();
  act(() => {
    h?.onEnv?.(
      env("s-base", "done", null, [
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ]),
    );
    h?.onEnv?.(envMsg);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
});

describe("BroadcastModal の追加操作 (#1625)", () => {
  it("失敗した環境だけを、基準 + その環境の 1 件で再実行する", async () => {
    mount();
    await runAndDeliver(env("s-env", "error", null, []));
    const rerun = await screen.findByRole("button", { name: t("broadcastRerunEntry") });
    vi.mocked(api.broadcastCompare).mockClear();
    fireEvent.click(rerun);
    await waitFor(() => expect(api.broadcastCompare).toHaveBeenCalledTimes(1));
    const params = vi.mocked(api.broadcastCompare).mock.calls[0][0];
    expect(params.baselineSessionId).toBe("s-base");
    expect(params.targetSessionIds).toEqual(["s-env"]);
    // 再実行の結果で、この環境のカードだけが更新される。
    const h = handlers.get(params.runId);
    act(() => {
      h?.onEnv?.(
        env("s-env", "done", diff({}), [
          [1, "a"],
          [2, "b"],
          [3, "c"],
        ]),
      );
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: t("broadcastRerunEntry") })).toBeNull());
  });

  it("基準にだけある行を『欠落行の例』として出す", async () => {
    mount();
    await runAndDeliver(
      env(
        "s-env",
        "done",
        diff({ mode: "hash", hasDiff: true, removedCount: 2, removedRowIndices: [0, 2] }),
        [[2, "b"]],
      ),
    );
    expect(await screen.findByText(t("broadcastRemovedSamplesTitle"))).toBeInTheDocument();
    expect(screen.getByText("id=1, v=a")).toBeInTheDocument();
    expect(screen.getByText("id=3, v=c")).toBeInTheDocument();
  });

  it("表名が分かる差分から同期 SQL をプレビューする (実行はしない)", async () => {
    vi.mocked(api.broadcastSyncSql).mockResolvedValue({
      statements: [
        {
          sql: "INSERT INTO `users` (`id`) VALUES (1)",
          table: "users",
          kind: "insert_row",
          destructive: false,
        },
      ],
      warnings: [],
    });
    mount({ table: "users", database: "app" });
    await runAndDeliver(
      env("s-env", "done", diff({ hasDiff: true, removedCount: 1, removedRowIndices: [0] }), [
        [2, "b"],
        [3, "c"],
      ]),
    );
    fireEvent.click(await screen.findByRole("button", { name: t("broadcastSyncGenerate") }));
    await waitFor(() => expect(api.broadcastSyncSql).toHaveBeenCalled());
    const params = vi.mocked(api.broadcastSyncSql).mock.calls[0][0];
    expect(params.table).toBe("users");
    expect(params.allowDelete).toBe(false);
    expect(params.baselineRows).toHaveLength(3);
    expect(params.targetRows).toHaveLength(2);
    expect(await screen.findByLabelText(t("broadcastSyncPreviewLabel"))).toHaveTextContent(
      "INSERT INTO `users`",
    );
  });

  it("表名が無いときは同期 SQL ではなく案内を出す", async () => {
    mount();
    await runAndDeliver(
      env("s-env", "done", diff({ hasDiff: true, removedCount: 1, removedRowIndices: [0] }), [[2, "b"]]),
    );
    expect(await screen.findByText(t("broadcastSyncNeedsTable"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("broadcastSyncGenerate") })).toBeNull();
  });

  it("打ち切られた比較は、表名があれば全行比較を案内する", async () => {
    mount({ table: "users", database: "app" });
    await runAndDeliver(env("s-env", "done", diff({ truncated: true }), [[1, "a"]]));
    expect(await screen.findByRole("button", { name: t("broadcastFullRun") })).toBeInTheDocument();
  });
});
