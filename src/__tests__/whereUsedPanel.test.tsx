import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type {
  WhereUsedMatch,
  WhereUsedReport,
  WhereUsedStreamHandlers,
} from "../api/tauri";

/**
 * Where-used パネル (#1027) は Rust の `find_where_used` (#1261) の Channel で結果を受ける。
 * ここでは Channel のハンドラを捕まえ、バックエンドが送るメッセージ (進捗 / 完了 / キャンセル)
 * を模擬して、画面の状態遷移 (進捗表示・並べ替え・キャンセル・エラー) を固定する。
 */
const handlers: { current: WhereUsedStreamHandlers | null } = { current: null };

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenWhereUsedStream: vi.fn(async (_streamId: string, h: WhereUsedStreamHandlers) => {
      handlers.current = h;
      return () => {
        handlers.current = null;
      };
    }),
    api: {
      ...actual.api,
      findWhereUsed: vi.fn().mockResolvedValue(undefined),
      cancelStream: vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 }),
    },
  };
});

import { api } from "../api/tauri";
import { WhereUsedPanel } from "../components/WhereUsedPanel";

beforeEach(() => {
  vi.clearAllMocks();
  handlers.current = null;
});

function emit(fn: (h: WhereUsedStreamHandlers) => void) {
  act(() => {
    if (handlers.current) fn(handlers.current);
  });
}

const match = (
  kind: WhereUsedMatch["kind"],
  name: string,
  confidence: WhereUsedMatch["confidence"],
): WhereUsedMatch => ({
  confidence,
  hitCount: 1,
  lines: [{ line: 3, text: "FROM orders o", ranges: [[5, 11]], clippedStart: false, clippedEnd: false }],
  source: kind === "snippet" ? "snippet" : "object",
  kind,
  name,
  id: null,
  snippetId: kind === "snippet" ? name : null,
});

const report = (over: Partial<WhereUsedReport> = {}): WhereUsedReport => ({
  matches: [],
  scannedObjects: 4,
  scannedSnippets: 2,
  failed: [],
  emptyDefinitions: [],
  cancelled: false,
  ...over,
});

const renderPanel = (onOpenObject = vi.fn()) =>
  renderWithProviders(
    <WhereUsedPanel
      sessionId="s1"
      driver="postgres"
      defaultDatabase="app"
      request={{ target: { database: "app", table: "orders", column: null }, autoRun: true }}
      onRequestConsumed={() => {}}
      onOpenObject={onOpenObject}
      onOpenSnippet={() => {}}
    />,
  );

describe("WhereUsedPanel (backend scan, #1261)", () => {
  it("starts the backend scan for the requested target and shows progress", async () => {
    renderPanel();
    await waitFor(() => expect(api.findWhereUsed).toHaveBeenCalled());
    expect(api.findWhereUsed).toHaveBeenCalledWith({
      sessionId: "s1",
      streamId: expect.stringMatching(/^whereused_/),
      database: "app",
      target: { database: "app", table: "orders", column: null },
    });

    emit((h) => h.onProgress?.({ done: 3, total: 10 }));
    expect(await screen.findByText(t("whereUsedProgress", { done: 3, total: 10 }))).toBeInTheDocument();
  });

  it("shows matches sorted direct-first and opens the object", async () => {
    const user = userEvent.setup();
    const onOpenObject = vi.fn();
    renderPanel(onOpenObject);
    await waitFor(() => expect(handlers.current).not.toBeNull());
    await waitFor(() => expect(api.findWhereUsed).toHaveBeenCalled());

    emit((h) =>
      h.onDone?.({
        report: report({
          matches: [match("trigger", "t_audit", "possible"), match("view", "v_orders", "direct")],
        }),
      }),
    );

    const names = (await screen.findAllByRole("button", { name: /^.*(v_orders|t_audit).*$/ })).map(
      (b) => b.textContent,
    );
    expect(names).toEqual(["v_orders", "t_audit"]);
    await user.click(screen.getByText("v_orders"));
    expect(onOpenObject).toHaveBeenCalledWith("app", "view", "v_orders", null);
    // 走査が済んだら進捗は消える。
    expect(screen.queryByText(/whereUsedProgress/)).not.toBeInTheDocument();
  });

  it("cancels the backend stream and shows the partial report as cancelled", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(handlers.current).not.toBeNull());
    await waitFor(() => expect(api.findWhereUsed).toHaveBeenCalled());

    await user.click(await screen.findByRole("button", { name: t("whereUsedCancel") }));
    expect(api.cancelStream).toHaveBeenCalledWith(expect.stringMatching(/^whereused_/));

    emit((h) =>
      h.onCancelled?.({
        report: report({ cancelled: true, matches: [match("view", "v_orders", "direct")] }),
      }),
    );
    expect(await screen.findByText(t("whereUsedCancelled"))).toBeInTheDocument();
    expect(screen.getByText("v_orders")).toBeInTheDocument();
  });

  it("shows a stream error", async () => {
    renderPanel();
    await waitFor(() => expect(handlers.current).not.toBeNull());
    emit((h) => h.onError?.({ error: "boom", connectionLost: false }));
    expect(await screen.findByText(t("whereUsedError", { error: "boom" }))).toBeInTheDocument();
  });
});
