import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, waitFor, act } from "./testUtils";
import { t } from "../i18n";
import type { ReplicationStatus } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, getReplicationStatus: vi.fn() },
  };
});

import { ReplicationPanel } from "../components/ReplicationPanel";
import { api } from "../api/tauri";

const GIB = 1024 ** 3;

const status = (over: Partial<ReplicationStatus>): ReplicationStatus => ({
  role: "standalone",
  missing_privilege: null,
  links: [],
  slots: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReplicationPanel (#2180)", () => {
  it("単独 (構成なし) は役割と空状態を出す", async () => {
    vi.mocked(api.getReplicationStatus).mockResolvedValue(status({}));
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="postgres" />);
    expect(await screen.findByText(t("replicationStandaloneTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("replicationRoleStandalone"))).toBeInTheDocument();
    expect(screen.queryByTestId("replication-slot-warning")).toBeNull();
  });

  it("PostgreSQL のプライマリ: レプリカごとの遅延とスロットの保持量を出し、滞留スロットを先頭で警告する", async () => {
    vi.mocked(api.getReplicationStatus).mockResolvedValue(
      status({
        role: "primary",
        links: [
          {
            direction: "downstream",
            name: "replica-1",
            address: "10.0.0.2",
            state: "streaming",
            sync_state: "async",
            lag_secs: 45,
            write_lag_secs: 0.5,
            flush_lag_secs: 1,
            lag_bytes: 2048,
            io_running: null,
            sql_running: null,
            last_error: null,
          },
        ],
        slots: [
          {
            name: "stale_slot",
            slot_type: "logical",
            plugin: "pgoutput",
            active: false,
            retained_bytes: 3 * GIB,
            wal_status: "reserved",
          },
          {
            name: "live_slot",
            slot_type: "physical",
            plugin: null,
            active: true,
            retained_bytes: 5 * GIB,
            wal_status: null,
          },
        ],
      }),
    );
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="postgres" />);
    const warning = await screen.findByTestId("replication-slot-warning");
    expect(warning).toHaveTextContent("stale_slot");
    expect(warning).not.toHaveTextContent("live_slot");
    expect(screen.getByTestId("replication-link")).toHaveAttribute("data-attention", "true");
    expect(screen.getByText("replica-1")).toBeInTheDocument();
    const rows = screen.getAllByTestId("replication-slot");
    expect(rows.map((r) => r.getAttribute("data-stuck"))).toEqual(["true", "false"]);
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("MySQL のレプリカ: スレッドの状態と直近のエラーを出す", async () => {
    vi.mocked(api.getReplicationStatus).mockResolvedValue(
      status({
        role: "replica",
        links: [
          {
            direction: "upstream",
            name: "db1:3306",
            address: "db1:3306",
            state: "sql_stopped",
            sync_state: null,
            lag_secs: null,
            write_lag_secs: null,
            flush_lag_secs: null,
            lag_bytes: null,
            io_running: true,
            sql_running: false,
            last_error: "Duplicate entry '1' for key 'PRIMARY'",
          },
        ],
      }),
    );
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="mysql" />);
    expect(await screen.findByTestId("replication-last-error")).toHaveTextContent("Duplicate entry");
    expect(screen.getByText(t("replicationRoleReplica"))).toBeInTheDocument();
    expect(screen.getByText(t("replicationThreadStopped"))).toBeInTheDocument();
  });

  it("権限不足は必要な権限名つきの警告で、エラー表示にはしない", async () => {
    vi.mocked(api.getReplicationStatus).mockResolvedValue(
      status({ missing_privilege: "REPLICATION CLIENT" }),
    );
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="mysql" />);
    const note = await screen.findByTestId("replication-privilege");
    expect(note).toHaveTextContent("REPLICATION CLIENT");
    expect(screen.queryByTestId("replication-error")).toBeNull();
    // 権限不足のときは「構成なし」とは断定しない。
    expect(screen.queryByText(t("replicationStandaloneTitle"))).toBeNull();
  });

  it("取得に失敗したらエラーを出す", async () => {
    vi.mocked(api.getReplicationStatus).mockRejectedValue(new Error("boom"));
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="postgres" />);
    expect(await screen.findByTestId("replication-error")).toHaveTextContent("boom");
  });

  it("SQLite は理由を出し、IPC を呼ばない", async () => {
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="sqlite" />);
    expect(await screen.findByTestId("replication-unsupported")).toBeInTheDocument();
    await waitFor(() => expect(api.getReplicationStatus).not.toHaveBeenCalled());
  });
});

describe("ReplicationPanel polling (#2180)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.getReplicationStatus).mockResolvedValue(status({}));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("自動更新オンでは一定間隔で再取得する", async () => {
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="postgres" />);
    await flush(0);
    const first = vi.mocked(api.getReplicationStatus).mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await flush(5_000);
    expect(vi.mocked(api.getReplicationStatus).mock.calls.length).toBeGreaterThan(first);
  });

  it("自動更新をオフにすると呼び出し回数が増えない", async () => {
    renderWithProviders(<ReplicationPanel sessionId="s1" driver="postgres" />);
    await flush(0);
    await act(async () => {
      screen.getByRole("checkbox", { name: t("autoRefreshAria") }).click();
    });
    const n = vi.mocked(api.getReplicationStatus).mock.calls.length;
    await flush(30_000);
    expect(vi.mocked(api.getReplicationStatus).mock.calls.length).toBe(n);
  });

  it("アンマウント後は呼び出し回数が増えない", async () => {
    const { unmount } = renderWithProviders(<ReplicationPanel sessionId="s1" driver="postgres" />);
    await flush(0);
    unmount();
    const n = vi.mocked(api.getReplicationStatus).mock.calls.length;
    await flush(30_000);
    expect(vi.mocked(api.getReplicationStatus).mock.calls.length).toBe(n);
  });

  it("keep-alive で非アクティブの間は呼び出し回数が増えない", async () => {
    const { KeepAlive } = await import("../components/KeepAlive");
    const panel = (key: string | null) => (
      <KeepAlive activeKey={key} limit={2}>
        <ReplicationPanel sessionId="s1" driver="postgres" />
      </KeepAlive>
    );
    const { rerender } = renderWithProviders(panel("a"));
    await flush(0);
    rerender(panel(null));
    await flush(0);
    const n = vi.mocked(api.getReplicationStatus).mock.calls.length;
    await flush(30_000);
    expect(vi.mocked(api.getReplicationStatus).mock.calls.length).toBe(n);
  });
});
