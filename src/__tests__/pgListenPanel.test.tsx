import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act, within } from "./testUtils";
import { t } from "../i18n";
import type { PgListenStreamHandlers } from "../api/tauri";

let handlers: PgListenStreamHandlers | null = null;
const unlisten = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenPgListenStream: vi.fn(async (_id: string, h: PgListenStreamHandlers) => {
      handlers = h;
      return unlisten;
    }),
    api: {
      ...actual.api,
      startPgListen: vi.fn(),
      pgListenAddChannel: vi.fn(),
      pgListenRemoveChannel: vi.fn(),
      cancelStream: vi.fn(),
    },
  };
});

import { PgListenPanel } from "../components/PgListenPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  handlers = null;
  unlisten.mockReset();
  vi.mocked(api.startPgListen).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.pgListenAddChannel).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.pgListenRemoveChannel).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.cancelStream).mockReset().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
});

const addChannel = (name: string) => {
  fireEvent.change(screen.getByTestId("pglisten-channel-input"), { target: { value: name } });
  fireEvent.click(screen.getByTestId("pglisten-add"));
};

describe("PgListenPanel の縮退表示 (#2019)", () => {
  it.each(["mysql", "sqlite"])("%s では理由コードの説明つきで縮退し、何も呼ばない", (driver) => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver={driver} />);
    expect(screen.getByTestId("pglisten-unsupported")).toHaveTextContent(
      t("pgListenReasonUnsupportedDriver"),
    );
    expect(screen.queryByTestId("pglisten-start")).toBeNull();
    expect(api.startPgListen).not.toHaveBeenCalled();
  });

  it("バックエンドが unsupported を返したら理由つきで縮退表示する", async () => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("ch");
    await waitFor(() => expect(screen.getByTestId("pglisten-start")).toBeEnabled());
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(handlers).not.toBeNull());
    act(() => handlers?.onUnsupported?.({ reason: "unsupported_driver" }));
    expect(screen.getByTestId("pglisten-unsupported")).toHaveTextContent(
      t("pgListenReasonUnsupportedDriver"),
    );
  });
});

describe("PgListenPanel (#2019)", () => {
  it("チャンネルが無いと開始できず、不正な名前は弾く", () => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    expect(screen.getByTestId("pglisten-start")).toBeDisabled();
    addChannel("   ");
    expect(screen.getByRole("alert")).toHaveTextContent(t("pgListenErrEmpty"));
    addChannel("x".repeat(64));
    expect(screen.getByRole("alert")).toHaveTextContent(t("pgListenErrTooLong"));
  });

  it("開始して通知を新しい順に並べ、payload が長ければ省略を示す", async () => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("orders");
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    expect(vi.mocked(api.startPgListen).mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      channels: ["orders"],
    });
    act(() => handlers?.onStarted?.({ channels: ["orders"] }));
    act(() => {
      handlers?.onNotification?.({
        channel: "orders",
        payload: "first",
        payloadTruncated: false,
        pid: 11,
        receivedAtMs: 1,
      });
      handlers?.onNotification?.({
        channel: "orders",
        payload: "second",
        payloadTruncated: true,
        pid: 12,
        receivedAtMs: 2,
      });
    });
    const rows = screen.getAllByTestId("pglisten-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("second");
    expect(rows[0]).toHaveTextContent(t("pgListenTruncated"));
    expect(rows[1]).toHaveTextContent("first");
  });

  it("監視中のチャンネル追加・削除はバックエンドへ送る", async () => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("a");
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    act(() => handlers?.onStarted?.({ channels: ["a"] }));
    addChannel("b");
    await waitFor(() => expect(api.pgListenAddChannel).toHaveBeenCalledWith(expect.any(String), "b"));
    fireEvent.click(screen.getByRole("button", { name: t("pgListenRemoveChannel", { channel: "a" }) }));
    await waitFor(() => expect(api.pgListenRemoveChannel).toHaveBeenCalledWith(expect.any(String), "a"));
  });

  it("停止とアンマウントで cancelStream を呼びリスナを残さない", async () => {
    const { unmount } = renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("a");
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    act(() => handlers?.onStarted?.({ channels: ["a"] }));
    fireEvent.click(screen.getByTestId("pglisten-stop"));
    expect(api.cancelStream).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalledTimes(2));
    unmount();
    expect(api.cancelStream).toHaveBeenCalledTimes(2);
  });

  it("開始要求の完了前に閉じたら、完了後にもう一度取り消す", async () => {
    let resolveStart: () => void = () => {};
    vi.mocked(api.startPgListen).mockReturnValue(
      new Promise<void>((r) => {
        resolveStart = () => r(undefined);
      }),
    );
    const { unmount } = renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("a");
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    const streamId = vi.mocked(api.startPgListen).mock.calls[0][0].streamId;
    unmount();
    expect(api.cancelStream).toHaveBeenCalledTimes(1);
    await act(async () => resolveStart());
    expect(api.cancelStream).toHaveBeenCalledTimes(2);
    expect(api.cancelStream).toHaveBeenLastCalledWith(streamId);
  });

  it("再接続とセッション切断による停止を知らせる", async () => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("a");
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    act(() => handlers?.onStarted?.({ channels: ["a"] }));
    act(() => handlers?.onReconnected?.());
    expect(screen.getByTestId("pglisten-reconnected")).toBeInTheDocument();
    act(() => handlers?.onCancelled?.({ deliveredRows: 0 }));
    expect(screen.getByTestId("pglisten-closed")).toBeInTheDocument();
    expect(screen.getByTestId("pglisten-start")).toBeInTheDocument();
  });

  it("エラーで止まったら理由を出す", async () => {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    addChannel("a");
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    act(() => handlers?.onError?.({ error: "boom", connectionLost: true }));
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});

describe("PgListenPanel のライブフィード (#2093)", () => {
  const note = (channel: string, payload: string, n: number) => ({
    channel,
    payload,
    payloadTruncated: false,
    pid: 1,
    receivedAtMs: n,
  });
  async function startListening(channelNames: string[]) {
    renderWithProviders(<PgListenPanel sessionId="s1" driver="postgres" />);
    for (const c of channelNames) addChannel(c);
    fireEvent.click(screen.getByTestId("pglisten-start"));
    await waitFor(() => expect(api.startPgListen).toHaveBeenCalled());
    act(() => handlers?.onStarted?.({ channels: channelNames }));
  }

  it("状態ピルは listening で点を脈動させ、停止すると止める", async () => {
    await startListening(["a"]);
    const pill = screen.getByTestId("pglisten-status");
    expect(pill).toHaveAttribute("data-status", "listening");
    expect(pill.querySelector("[data-pulsing]")).toHaveAttribute("data-pulsing", "true");
    fireEvent.click(screen.getByTestId("pglisten-stop"));
    expect(screen.getByTestId("pglisten-status")).toHaveAttribute("data-status", "idle");
  });

  it("新着行は入場時にフラッシュする", async () => {
    await startListening(["a"]);
    act(() => handlers?.onNotification?.(note("a", "one", 1)));
    expect(document.querySelectorAll("[data-live-flash]").length).toBeGreaterThan(0);
  });

  it("一時停止中も受信は続き、新着バッジで反映する", async () => {
    await startListening(["a"]);
    act(() => handlers?.onNotification?.(note("a", "one", 1)));
    fireEvent.click(screen.getByTestId("pglisten-pause"));
    act(() => {
      handlers?.onNotification?.(note("a", "two", 2));
      handlers?.onNotification?.(note("a", "three", 3));
    });
    expect(screen.getAllByTestId("pglisten-row")).toHaveLength(1);
    expect(screen.getByTestId("pglisten-count")).toHaveTextContent(t("pgListenCount", { count: 3 }));
    const badge = screen.getByTestId("pglisten-pending");
    expect(badge).toHaveTextContent(t("pgListenPending", { count: 2 }));
    fireEvent.click(badge);
    await waitFor(() => expect(screen.getAllByTestId("pglisten-row")).toHaveLength(3));
    expect(screen.queryByTestId("pglisten-pending")).toBeNull();
  });

  it("payload を開いている間は自動で一時停止し、閉じると再開する", async () => {
    await startListening(["a"]);
    act(() => handlers?.onNotification?.(note("a", "one", 1)));
    fireEvent.click(within(screen.getByTestId("pglisten-row")).getByRole("button", { expanded: false }));
    act(() => handlers?.onNotification?.(note("a", "two", 2)));
    expect(screen.getAllByTestId("pglisten-row")).toHaveLength(1);
    expect(screen.getByTestId("pglisten-paused-note")).toHaveTextContent(t("pgListenPausedAuto"));
    fireEvent.click(within(screen.getByTestId("pglisten-row")).getByRole("button", { expanded: true }));
    await waitFor(() => expect(screen.getAllByTestId("pglisten-row")).toHaveLength(2));
  });

  it("チャンネルのチップに件数を出し、クリックで絞り込む", async () => {
    await startListening(["a", "b"]);
    act(() => {
      handlers?.onNotification?.(note("a", "x", 1));
      handlers?.onNotification?.(note("b", "y", 2));
      handlers?.onNotification?.(note("a", "z", 3));
    });
    expect(screen.getByTestId("pglisten-filter-a")).toHaveTextContent("2");
    expect(screen.getByTestId("pglisten-filter-b")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("pglisten-filter-b"));
    await waitFor(() => expect(screen.getAllByTestId("pglisten-row")).toHaveLength(1));
    expect(screen.getByTestId("pglisten-filter-b")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("pglisten-filter-all"));
    await waitFor(() => expect(screen.getAllByTestId("pglisten-row")).toHaveLength(3));
  });
});
