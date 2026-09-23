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

import { ConnectionHealthPanel } from "../components/ConnectionHealthPanel";
import { api, type ConnectionProfile } from "../api/tauri";

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
