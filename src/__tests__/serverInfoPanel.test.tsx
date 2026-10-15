import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ServerInfo } from "../api/tauri";

/**
 * サーバ情報パネル (#563) の空状態統一 (#847)。検索フィルタで 0 件になった
 * ケースは、共有 `EmptyState` (compact, icon="search") のタイトルが表示される
 * ことを固定する。`ProcessListPanel` のテストと同じ実 Tauri なしモック方式。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      serverInfo: vi.fn().mockResolvedValue({
        version: "8.0.0",
        variables: [{ name: "max_connections", value: "150" }],
      } satisfies ServerInfo),
    },
  };
});

import { ServerInfoPanel } from "../components/ServerInfoPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ServerInfoPanel render smoke", () => {
  it("mounts and shows fetched variables", async () => {
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("max_connections")).toBeInTheDocument();
    });
  });
});

describe("ServerInfoPanel empty state (#847)", () => {
  it("shows the shared EmptyState title when the search filter matches nothing", async () => {
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("max_connections")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(t("serverInfoSearch")), {
      target: { value: "no-such-variable" },
    });

    await waitFor(() => {
      expect(screen.getByText(t("serverInfoEmpty"))).toBeInTheDocument();
    });
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく共有
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.serverInfo`
 * が再度呼ばれることを固定する。
 */
describe("ServerInfoPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.serverInfo).mockRejectedValueOnce(new Error("access denied"));

    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(t("serverInfoLoadError", { error: "Error: access denied" })),
      ).toBeInTheDocument();
    });
    expect(api.serverInfo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("serverInfoRetry") }));

    await waitFor(() => {
      expect(api.serverInfo).toHaveBeenCalledTimes(2);
    });
  });
});

/** 再取得に失敗しても、取得済みの変数一覧は消さずに表の上の帯でエラーを出す (#1529)。 */
describe("ServerInfoPanel refresh failure keeps the table (#1529)", () => {
  it("keeps the loaded variables and shows the error above them", async () => {
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("max_connections")).toBeInTheDocument();
    });

    vi.mocked(api.serverInfo).mockRejectedValueOnce(new Error("lost"));
    fireEvent.click(screen.getByRole("button", { name: t("serverInfoRefresh") }));

    await waitFor(() => {
      expect(screen.getByText(t("serverInfoLoadError", { error: "Error: lost" }))).toBeInTheDocument();
    });
    expect(screen.getByText("max_connections")).toBeInTheDocument();
    // 件数表示は変化が読み上げられるよう role=status。
    expect(screen.getByRole("status")).toHaveTextContent(t("serverInfoVarCount", { shown: 1, total: 1 }));
  });
});

describe("ServerInfoPanel 既定値以外の絞り込みと値コピー (#1622)", () => {
  const info: ServerInfo = {
    version: "16.0",
    variables: [
      { name: "work_mem", value: "64MB", source: "configuration file" },
      { name: "shared_buffers", value: "128MB", source: "default" },
      { name: "timezone", value: "UTC", source: null },
    ],
  };

  it("「既定値以外のみ」で source が default 以外の変数だけに絞る", async () => {
    vi.mocked(api.serverInfo).mockResolvedValue(info);
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await screen.findByText("shared_buffers");
    fireEvent.click(screen.getByLabelText(t("serverInfoOnlyChanged")));
    expect(screen.getByText("work_mem")).toBeInTheDocument();
    expect(screen.queryByText("shared_buffers")).not.toBeInTheDocument();
    expect(screen.queryByText("timezone")).not.toBeInTheDocument();
  });

  it("source が全く取れないサーバでは絞り込みの欄を出さない", async () => {
    vi.mocked(api.serverInfo).mockResolvedValue({
      version: "8.0.0",
      variables: [{ name: "max_connections", value: "150" }],
    });
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await screen.findByText("max_connections");
    expect(screen.queryByLabelText(t("serverInfoOnlyChanged"))).not.toBeInTheDocument();
  });

  it("コピーボタンは「名前 = 値」をクリップボードへ書く", async () => {
    vi.mocked(api.serverInfo).mockResolvedValue(info);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(<ServerInfoPanel sessionId="s1" onClose={() => {}} />);
    await screen.findByText("work_mem");
    fireEvent.click(screen.getByRole("button", { name: t("serverInfoCopyValueAria", { name: "work_mem" }) }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("work_mem = 64MB"));
  });
});
