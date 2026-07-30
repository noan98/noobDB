import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ProcessInfo } from "../api/tauri";

/**
 * プロセス監視パネル (#604)。マウント時に `api.listProcesses()` を呼び (以降ポーリング)、
 * モックして実 Tauri なしでレンダリングできるようにする。タイトルが可視であること・
 * 閉じるボタンで `onClose` が呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProcesses: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ProcessListPanel } from "../components/ProcessListPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProcessListPanel render smoke (#604)", () => {
  it("mounts and shows the process-list title", async () => {
    renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} onClose={() => {}} />,
    );
    expect(screen.getByText(t("processTitle"))).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("processClose") })).toBeInTheDocument(),
    );
  });

  it("invokes onClose when the close control is activated", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("processClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/**
 * 空状態の共有 EmptyState 化 (#847)。アクティブなプロセス/接続が 1 件もない
 * 場合、素のグレーテキストではなく共有 `EmptyState` (アイコン + タイトル) で
 * 表示されることを固定する。
 */
describe("ProcessListPanel empty state (#847)", () => {
  it("shows the shared EmptyState (with its title) when there are no processes", async () => {
    renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("processEmpty"))).toBeInTheDocument();
    });
  });
});

/**
 * 初回ロード中のスケルトン行表示 (#846)。中央スピナーではなく行スケルトンで
 * 表構造を予兆表示し、データ到着後は実データ行へ差し替わることを確認する。
 */
describe("ProcessListPanel loading skeleton (#846)", () => {
  it("shows aria-hidden skeleton rows while the initial fetch is pending, then swaps in real rows", async () => {
    let resolveList: (value: ProcessInfo[]) => void = () => {};
    const pending = new Promise<ProcessInfo[]>((resolve) => {
      resolveList = resolve;
    });
    vi.mocked(api.listProcesses).mockReturnValueOnce(pending);

    const { container } = renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} onClose={() => {}} />,
    );

    await waitFor(() => {
      const rows = container.querySelectorAll("tbody > tr");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row.getAttribute("aria-hidden")).toBe("true"));
    });

    resolveList([
      {
        id: 42,
        user: "root",
        host: "localhost",
        database: "test",
        command: "Query",
        state: "executing",
        time_secs: 1,
        query: "SELECT 1",
        is_self: false,
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
    const rows = container.querySelectorAll("tbody > tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("aria-hidden")).toBeNull();
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく共有
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.listProcesses`
 * が再度呼ばれることを固定する。
 */
describe("ProcessListPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.listProcesses).mockRejectedValueOnce(new Error("connection lost"));

    renderWithProviders(
      <ProcessListPanel sessionId="s1" driver="mysql" readOnly={false} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(t("processLoadError", { error: "Error: connection lost" })),
      ).toBeInTheDocument();
    });
    expect(api.listProcesses).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("processRetry") }));

    await waitFor(() => {
      expect(api.listProcesses).toHaveBeenCalledTimes(2);
    });
  });
});
