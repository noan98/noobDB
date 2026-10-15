import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
import { t } from "../i18n";
import { BackendError } from "../api/invoke";

/**
 * 接続ヘルス (#1068) のパネル結線。純ロジックは `connectionHealth.test.ts` が固定し、
 * ここでは「`health_probe_all` 1 回で全セッションを確認する (#1259)」「未接続プロファイルへ勝手に接続しない」
 * 「サーバを持たない接続は N/A」「落ちた接続に再接続導線が出る」を確認する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      healthProbeAll: vi.fn(),
      reconnect: vi.fn(),
      connect: vi.fn(),
    },
  };
});

import { ConnectionHealthPanel } from "../components/ConnectionHealthPanel";
import { api, type ConnectionProfile, type HealthProbeItem } from "../api/tauri";

const profile = (over: Partial<ConnectionProfile>): ConnectionProfile =>
  ({
    id: "p",
    name: "p",
    driver: "mysql",
    host: "db",
    port: 3306,
    user: "u",
    database: null,
    ssh: null,
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
    ...over,
  }) as ConnectionProfile;

const mysql = profile({ id: "m", name: "mysql-prod" });
const lite = profile({ id: "l", name: "local-file", driver: "sqlite", file_path: "/x.db" });
const saved = profile({ id: "s", name: "saved-only", ssh: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.healthProbeAll).mockImplementation(async (ids) =>
    ids.map((sid) =>
      sid === "dead"
        ? {
            session_id: sid,
            status: "down" as const,
            latency_ms: null,
            version: null,
            connections: null,
            tunnel_alive: null,
          }
        : {
            session_id: sid,
            status: "up" as const,
            latency_ms: 5,
            version: "8.0.36",
            // SQLite はバックエンドが接続数を返さない。
            connections: sid === "s-l" ? null : 7,
            tunnel_alive: null,
          },
    ),
  );
});

function renderPanel(onOpenProfile = vi.fn()) {
  renderWithProviders(
    <ConnectionHealthPanel
      connections={[
        { sessionId: "s-m", profile: mysql },
        { sessionId: "s-l", profile: lite },
      ]}
      profiles={[mysql, lite, saved]}
      activeSessionId="s-m"
      defaultIntervalSecs={30}
      connectingProfileId={null}
      onOpenProfile={onOpenProfile}
      onReconnected={() => {}}
    />,
  );
  return onOpenProfile;
}

describe("ConnectionHealthPanel (#1068)", () => {
  it("開いている接続だけを既存 IPC で確認し、SQLite は接続数 N/A", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getAllByText(t("healthStatusUp"))).toHaveLength(2));
    const mysqlRow = screen.getByTestId("health-row-m");
    expect(within(mysqlRow).getByText("8.0.36")).toBeInTheDocument();
    expect(within(mysqlRow).getByText("7")).toBeInTheDocument();
    expect(within(screen.getByTestId("health-row-l")).getByText(t("healthNa"))).toBeInTheDocument();
    // 全セッションを 1 回の IPC でまとめて確認する (2N 回ではない)。
    expect(api.healthProbeAll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.healthProbeAll).mock.calls[0][0]).toEqual(["s-m", "s-l"]);
  });

  it("保存済みプロファイルは表示しても自動で接続しない (明示操作のみ)", async () => {
    const onOpen = renderPanel();
    await waitFor(() => expect(api.healthProbeAll).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText(t("healthIncludeSaved")));
    const row = await screen.findByTestId("health-row-s");
    expect(within(row).getByText(t("healthStatusNotConnected"))).toBeInTheDocument();
    expect(api.connect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: new RegExp(t("healthConnect")) }));
    expect(onOpen).toHaveBeenCalledWith(saved);
    expect(api.connect).not.toHaveBeenCalled();
  });

  /**
   * 初回ロード中の空状態誤表示 (#1160)。姉妹パネル (#846) と同じく、`rows` 未取得の
   * 間は `EmptyState` ではなく `SkeletonTableRows` を出し、実データ到着後に差し替わる
   * ことを固定する。
   */
  it("初回の確認中は EmptyState ではなくスケルトン行を表示し、完了後に実データ0件なら EmptyState に差し替わる (#1160)", async () => {
    // 接続 0 件でも `runChecks` は必ず一度回る (targets=[] でも loading は true になる)。
    // その「確認中」の一瞬を検証するため `healthProbeAll` の完了を手で止める。
    let resolveChecks: (out: []) => void = () => {};
    const pending = new Promise<[]>((resolve) => {
      resolveChecks = resolve;
    });
    vi.mocked(api.healthProbeAll).mockReturnValueOnce(pending);

    const { container } = renderWithProviders(
      <ConnectionHealthPanel
        connections={[]}
        profiles={[]}
        activeSessionId={null}
        defaultIntervalSecs={30}
        connectingProfileId={null}
        onOpenProfile={() => {}}
        onReconnected={() => {}}
      />,
    );

    await waitFor(() => {
      const rows = container.querySelectorAll("tbody > tr");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row.getAttribute("aria-hidden")).toBe("true"));
    });
    // 確認中は「接続がありません」相当の空状態を誤って出さない。
    expect(screen.queryByText(t("healthEmpty"))).not.toBeInTheDocument();

    resolveChecks([]);

    await waitFor(() => {
      expect(screen.getByText(t("healthEmpty"))).toBeInTheDocument();
    });
    expect(container.querySelector("tbody > tr")).toBeNull();
  });

  it("開いている接続があれば、確認結果が届く前から実データ行 (状態: unknown) を表示する", async () => {
    // `buildHealthRows` は開いている接続をそのまま行にするため、rows は接続数に
    // 追従して即時に埋まる (0 件になるのは「接続が本当に無い」時だけ)。
    let resolveProbe: (items: HealthProbeItem[]) => void = () => {};
    const pending = new Promise<HealthProbeItem[]>((resolve) => {
      resolveProbe = resolve;
    });
    vi.mocked(api.healthProbeAll).mockReturnValueOnce(pending);

    renderWithProviders(
      <ConnectionHealthPanel
        connections={[{ sessionId: "s-m", profile: mysql }]}
        profiles={[mysql]}
        activeSessionId="s-m"
        defaultIntervalSecs={30}
        connectingProfileId={null}
        onOpenProfile={() => {}}
        onReconnected={() => {}}
      />,
    );

    const row = await screen.findByTestId("health-row-m");
    expect(within(row).getByText(t("healthStatusUnknown"))).toBeInTheDocument();
    expect(screen.queryByText(t("healthEmpty"))).not.toBeInTheDocument();

    resolveProbe([
      {
        session_id: "s-m",
        status: "up",
        latency_ms: 5,
        version: "8.0.36",
        connections: 7,
        tunnel_alive: null,
      },
    ]);
    await waitFor(() => expect(within(row).getByText(t("healthStatusUp"))).toBeInTheDocument());
  });

  it("落ちた接続には再接続導線を出し、同じ session id で張り直す", async () => {
    vi.mocked(api.reconnect).mockResolvedValue(undefined);
    const onReconnected = vi.fn();
    renderWithProviders(
      <ConnectionHealthPanel
        connections={[{ sessionId: "dead", profile: mysql }]}
        profiles={[mysql]}
        activeSessionId={null}
        defaultIntervalSecs={30}
        connectingProfileId={null}
        onOpenProfile={() => {}}
        onReconnected={onReconnected}
      />,
    );
    const row = await screen.findByTestId("health-row-m");
    await waitFor(() => expect(within(row).getByText(t("healthStatusDown"))).toBeInTheDocument());
    fireEvent.click(within(row).getByRole("button", { name: new RegExp(t("healthReconnect")) }));
    await waitFor(() => expect(api.reconnect).toHaveBeenCalledWith("dead"));
    await waitFor(() => expect(onReconnected).toHaveBeenCalledWith("dead"));
  });

  // 明示トランザクションが生きている接続を再接続すると未確定の変更が失われる (#1626)。
  it("トランザクション中で拒否されたら確認し、承諾したときだけ force=true で再接続する", async () => {
    vi.mocked(api.reconnect).mockRejectedValueOnce(new BackendError("transactionActive", "tx"));
    vi.mocked(api.reconnect).mockResolvedValueOnce(undefined);
    const onReconnected = vi.fn();
    renderWithProviders(
      <ConnectionHealthPanel
        connections={[{ sessionId: "dead", profile: mysql }]}
        profiles={[mysql]}
        activeSessionId={null}
        defaultIntervalSecs={30}
        connectingProfileId={null}
        onOpenProfile={() => {}}
        onReconnected={onReconnected}
      />,
    );
    const row = await screen.findByTestId("health-row-m");
    await waitFor(() => expect(within(row).getByText(t("healthStatusDown"))).toBeInTheDocument());
    fireEvent.click(within(row).getByRole("button", { name: new RegExp(t("healthReconnect")) }));
    const dialogs = await screen.findAllByRole("dialog");
    fireEvent.click(
      within(dialogs[dialogs.length - 1]).getByRole("button", { name: t("reconnectTxConfirm") }),
    );
    await waitFor(() => expect(api.reconnect).toHaveBeenLastCalledWith("dead", true));
    await waitFor(() => expect(onReconnected).toHaveBeenCalledWith("dead"));
  });

  it("確認で取りやめたら force 付きで再接続しない", async () => {
    vi.mocked(api.reconnect).mockRejectedValueOnce(new BackendError("transactionActive", "tx"));
    const onReconnected = vi.fn();
    renderWithProviders(
      <ConnectionHealthPanel
        connections={[{ sessionId: "dead", profile: mysql }]}
        profiles={[mysql]}
        activeSessionId={null}
        defaultIntervalSecs={30}
        connectingProfileId={null}
        onOpenProfile={() => {}}
        onReconnected={onReconnected}
      />,
    );
    const row = await screen.findByTestId("health-row-m");
    await waitFor(() => expect(within(row).getByText(t("healthStatusDown"))).toBeInTheDocument());
    fireEvent.click(within(row).getByRole("button", { name: new RegExp(t("healthReconnect")) }));
    const dialogs = await screen.findAllByRole("dialog");
    fireEvent.click(
      within(dialogs[dialogs.length - 1]).getAllByRole("button", { name: t("confirmDefaultCancel") })[0],
    );
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    expect(api.reconnect).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();
  });
});

describe("ConnectionHealthPanel のレイテンシ推移 (#1630)", () => {
  it("確認が 2 回以上たまると、接続ごとにスパークラインを出す", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getAllByText(t("healthStatusUp"))).toHaveLength(2));
    // 1 回分だけでは線が引けないので出さない。
    expect(screen.queryAllByTestId("health-sparkline")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: t("healthRefresh") }));
    await waitFor(() => expect(screen.getAllByTestId("health-sparkline")).toHaveLength(2));
    const row = screen.getByTestId("health-row-m");
    expect(
      within(row).getByRole("img", { name: t("healthTrendAria", { count: 2, min: 5, max: 5 }) }),
    ).toBeInTheDocument();
  });
});
