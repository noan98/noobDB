import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
import { t } from "../i18n";

/**
 * 接続ヘルス (#1068) のパネル結線。純ロジックは `connectionHealth.test.ts` が固定し、
 * ここでは「既存 IPC だけを使う」「未接続プロファイルへ勝手に接続しない」
 * 「サーバを持たない接続は N/A」「落ちた接続に再接続導線が出る」を確認する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      pingSession: vi.fn(),
      serverInfo: vi.fn(),
      serverMetrics: vi.fn(),
      reconnect: vi.fn(),
      connect: vi.fn(),
    },
  };
});

// `checkAllConnections` の完了タイミングだけを差し替えられるようにする (他の純関数は
// 実装のまま使う)。#1160 のスケルトン検証は「接続 0 件でも、確認が終わるまでは
// `loading` が true」という一瞬の窓を再現する必要があるため。
vi.mock("../components/connectionHealth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/connectionHealth")>();
  return {
    ...actual,
    checkAllConnections: vi.fn(actual.checkAllConnections),
  };
});

import { ConnectionHealthPanel } from "../components/ConnectionHealthPanel";
import { api, type ConnectionProfile } from "../api/tauri";
import { checkAllConnections } from "../components/connectionHealth";

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
  vi.mocked(api.pingSession).mockImplementation(async (sid) => sid !== "dead");
  vi.mocked(api.serverInfo).mockResolvedValue({ version: "8.0.36", variables: [] });
  vi.mocked(api.serverMetrics).mockResolvedValue({
    connections: 7,
    active: null,
    idle_in_transaction: null,
    lock_waiting: null,
    questions: null,
    slow_queries: null,
    lock_waits: null,
  });
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
    // SQLite には server_metrics を投げない。
    expect(api.serverMetrics).toHaveBeenCalledTimes(1);
    expect(api.serverMetrics).toHaveBeenCalledWith("s-m");
    expect(api.pingSession).toHaveBeenCalledTimes(2);
  });

  it("保存済みプロファイルは表示しても自動で接続しない (明示操作のみ)", async () => {
    const onOpen = renderPanel();
    await waitFor(() => expect(api.pingSession).toHaveBeenCalledTimes(2));
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
    // その「確認中」の一瞬を検証するため `checkAllConnections` の完了を手で止める。
    let resolveChecks: (out: []) => void = () => {};
    const pending = new Promise<[]>((resolve) => {
      resolveChecks = resolve;
    });
    vi.mocked(checkAllConnections).mockReturnValueOnce(pending);

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
    let resolvePing: (up: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      resolvePing = resolve;
    });
    vi.mocked(api.pingSession).mockReturnValueOnce(pending);

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

    resolvePing(true);
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
});
