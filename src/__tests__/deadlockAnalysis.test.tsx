import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeadlockAnalysis, InnodbTransaction } from "../api/tauri";
import { t } from "../i18n";
import {
  classifyLockError,
  errorAgeSecs,
  followWaitCycle,
  innodbCycle,
  lockSummary,
  pgCycle,
  relationIsMismatch,
  relationNoticeKey,
  sqliteBusyHints,
  unavailableKey,
} from "../components/deadlock";
import { renderWithProviders, screen, waitFor } from "./testUtils";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, analyzeDeadlock: vi.fn() } };
});

import { api } from "../api/tauri";
import { DeadlockAnalyzeButton } from "../components/DeadlockAnalyzeButton";
import { DeadlockPanel } from "../components/DeadlockPanel";

const txn = (label: number, waitsOn: number[], over: Partial<InnodbTransaction> = {}): InnodbTransaction => ({
  label,
  trx_id: String(400 + label),
  thread_id: label,
  user: "root",
  host: "localhost",
  state: "updating",
  active_secs: 3,
  sql: `UPDATE t SET v = ${label}`,
  sql_truncated: false,
  holds: [
    { kind: "record", table: "d.t", index: "PRIMARY", mode: "X locks rec but not gap", record: "heap no 2" },
  ],
  waits_for: { kind: "record", table: "d.t", index: "PRIMARY", mode: "X", record: null },
  waits_on: waitsOn,
  rolled_back: false,
  ...over,
});

const empty: DeadlockAnalysis = { unavailable: null, mysql: null, postgres: null, sqlite: null };

beforeEach(() => {
  vi.mocked(api.analyzeDeadlock).mockReset();
});

describe("デッドロック解析の純ロジック (#2328)", () => {
  it("エラー文からデッドロックと SQLite のロック競合を見分ける", () => {
    expect(classifyLockError("mysql", "ERROR 1213 (40001): Deadlock found when trying to get lock")).toBe(
      "deadlock",
    );
    expect(classifyLockError("mysql", "Lock wait timeout exceeded (1205)")).toBeNull();
    expect(classifyLockError("postgres", "error returned from database: deadlock detected")).toBe("deadlock");
    expect(classifyLockError("postgres", "SQLSTATE 40P01")).toBe("deadlock");
    expect(classifyLockError("sqlite", "(code: 5) database is locked")).toBe("busy");
    expect(classifyLockError("sqlite", "deadlock detected")).toBeNull();
    expect(classifyLockError("mysql", "")).toBeNull();
  });

  it("待機の循環をたどる (先頭へ戻ったら止まる / 行き止まりはそこまで)", () => {
    expect(
      followWaitCycle(
        1,
        new Map([
          [1, [2]],
          [2, [1]],
        ]),
      ),
    ).toEqual([1, 2, 1]);
    expect(
      followWaitCycle(
        1,
        new Map([
          [1, [2]],
          [2, [3]],
          [3, [1]],
        ]),
      ),
    ).toEqual([1, 2, 3, 1]);
    expect(followWaitCycle(1, new Map([[1, [2]]]))).toEqual([1, 2]);
    expect(innodbCycle([txn(1, [2]), txn(2, [1])])).toEqual([1, 2, 1]);
    expect(innodbCycle([])).toEqual([]);
    expect(
      pgCycle([
        { waiter_pid: 10, blocker_pid: 20 },
        { waiter_pid: 20, blocker_pid: 10 },
      ]),
    ).toEqual([10, 20, 10]);
  });

  it("ロックの要約・関係の注記・理由コード・経過秒", () => {
    expect(
      lockSummary({ kind: "record", table: "d.t", index: "PRIMARY", mode: "X", record: "heap no 3" }),
    ).toEqual({
      mode: "X",
      target: "d.t (PRIMARY), heap no 3",
    });
    expect(lockSummary({ kind: "table", table: "d.t", index: null, mode: "IX", record: null }).target).toBe(
      "d.t",
    );
    expect(relationNoticeKey("older")).toBe("deadlockRelationOlder");
    expect(relationNoticeKey(null)).toBeNull();
    expect(relationIsMismatch("newer")).toBe(true);
    expect(relationIsMismatch("related")).toBe(false);
    expect(unavailableKey("needs_process_privilege")).toBe("deadlockUnavailableNeedsProcess");
    expect(unavailableKey("zzz")).toBe("deadlockUnavailableUnknown");
    expect(errorAgeSecs(1000, 4400)).toBe(3);
    expect(errorAgeSecs(null, 4400)).toBeNull();
    expect(errorAgeSecs(5000, 1000)).toBe(0);
  });

  it("SQLite の所見は WAL・busy_timeout・保持中の接続の順", () => {
    expect(sqliteBusyHints({ journal_mode: "delete", busy_timeout_ms: 0, holders: [] })).toEqual([
      "journalNotWal",
      "noBusyTimeout",
      "noHolders",
    ]);
    expect(
      sqliteBusyHints({
        journal_mode: "wal",
        busy_timeout_ms: 5000,
        holders: [{ session_id: "s", profile_id: null }],
      }),
    ).toEqual(["holders"]);
  });
});

describe("DeadlockAnalyzeButton", () => {
  it("デッドロックのエラーでだけ出て、押すと表示時刻つきで開く", async () => {
    const onOpen = vi.fn();
    const { rerender } = renderWithProviders(
      <DeadlockAnalyzeButton
        driver="mysql"
        message="1213 Deadlock found when trying to get lock"
        onOpen={onOpen}
      />,
    );
    (await screen.findByText(t("deadlockAnalyzeButton"))).click();
    expect(onOpen).toHaveBeenCalledWith(expect.any(Number));
    rerender(<DeadlockAnalyzeButton driver="mysql" message="syntax error" onOpen={onOpen} />);
    expect(screen.queryByTestId("deadlock-analyze")).toBeNull();
  });

  it("SQLite の BUSY は別の文言", async () => {
    renderWithProviders(
      <DeadlockAnalyzeButton driver="sqlite" message="database is locked" onOpen={vi.fn()} />,
    );
    expect(await screen.findByText(t("deadlockBusyButton"))).toBeTruthy();
  });
});

describe("DeadlockPanel", () => {
  const props = { sessionId: "s1", driver: "mysql", errorMessage: "1213", errorAtMs: 1000 };

  it("MySQL: 2 つのトランザクション・巻き戻された側・別件の注記を出す", async () => {
    vi.mocked(api.analyzeDeadlock).mockResolvedValue({
      ...empty,
      mysql: {
        detected_at: "2026-11-14 10:20:30",
        server_now: "2026-11-14 11:20:30",
        relation: "older",
        print_all_deadlocks: false,
        incomplete: false,
        transactions: [txn(1, [2]), txn(2, [1], { rolled_back: true })],
      },
    });
    renderWithProviders(<DeadlockPanel {...props} />);
    expect(await screen.findAllByTestId("deadlock-txn")).toHaveLength(2);
    expect(screen.getByTestId("deadlock-cycle")).toBeTruthy();
    expect(screen.getByTestId("deadlock-relation").textContent).toContain(t("deadlockRelationOlder"));
    expect(screen.getByTestId("deadlock-print-all-off")).toBeTruthy();
    expect(
      screen.getAllByTestId("deadlock-txn").filter((e) => e.getAttribute("data-victim") === "true"),
    ).toHaveLength(1);
    expect(api.analyzeDeadlock).toHaveBeenCalledWith("s1", "1213", expect.any(Number));
  });

  it("MySQL: PROCESS 権限が無いときは理由を出す", async () => {
    vi.mocked(api.analyzeDeadlock).mockResolvedValue({ ...empty, unavailable: "needs_process_privilege" });
    renderWithProviders(<DeadlockPanel {...props} />);
    expect((await screen.findByTestId("deadlock-unavailable")).textContent).toContain("PROCESS");
  });

  it("PostgreSQL: 循環・生きている相手のクエリ・ログ設定を出す", async () => {
    vi.mocked(api.analyzeDeadlock).mockResolvedValue({
      ...empty,
      postgres: {
        victim_pid: 1,
        edges: [
          { waiter_pid: 1, lock_mode: "ShareLock", target: "transaction 9", blocker_pid: 2 },
          { waiter_pid: 2, lock_mode: "ShareLock", target: "transaction 8", blocker_pid: 1 },
        ],
        context: 'while updating tuple (0,1) in relation "a"',
        processes: [
          {
            pid: 1,
            alive: false,
            user: null,
            application_name: null,
            state: null,
            query: null,
            query_hidden: false,
          },
          {
            pid: 2,
            alive: true,
            user: "app",
            application_name: "worker",
            state: "idle in transaction",
            query: "UPDATE a SET x = 1",
            query_hidden: false,
          },
        ],
        log_lock_waits: "off",
        deadlock_timeout: "1s",
      },
    });
    renderWithProviders(<DeadlockPanel {...props} driver="postgres" />);
    expect(await screen.findAllByTestId("deadlock-pg-process")).toHaveLength(2);
    expect(screen.getByTestId("deadlock-pg-edges").children).toHaveLength(2);
    expect(screen.getByTestId("deadlock-pg-log-note").textContent).toContain("log_lock_waits = off");
    expect(screen.getByText(/UPDATE/)).toBeTruthy();
  });

  it("SQLite: WAL / busy_timeout / 保持中の接続を出し、デッドロックは起きないと説明する", async () => {
    vi.mocked(api.analyzeDeadlock).mockResolvedValue({
      ...empty,
      sqlite: {
        journal_mode: "delete",
        busy_timeout_ms: 0,
        holders: [{ session_id: "s2", profile_id: "p2" }],
      },
    });
    renderWithProviders(
      <DeadlockPanel
        {...props}
        driver="sqlite"
        errorMessage="database is locked"
        profileNameFor={(id) => (id === "p2" ? "Other tab" : null)}
      />,
    );
    expect((await screen.findByTestId("deadlock-sqlite-note")).textContent).toContain("SQLITE_BUSY");
    expect(screen.getByTestId("deadlock-sqlite-journal").textContent).toContain("delete");
    expect(screen.getByTestId("deadlock-sqlite-timeout").textContent).toContain("0");
    expect(screen.getByTestId("deadlock-sqlite-holders").textContent).toContain("Other tab");
  });

  it("取得に失敗したらエラーを出す", async () => {
    vi.mocked(api.analyzeDeadlock).mockRejectedValue(new Error("boom"));
    renderWithProviders(<DeadlockPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
  });
});
