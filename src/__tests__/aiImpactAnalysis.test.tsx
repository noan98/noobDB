import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const hasAiApiKey = vi.fn().mockResolvedValue(true);
const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeTable = vi.fn();
const foreignKeys = vi.fn().mockResolvedValue([]);
const tableRowEstimate = vi.fn().mockResolvedValue(null);
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const unlisten = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      return unlisten;
    }),
    api: {
      ...actual.api,
      hasAiApiKey: () => hasAiApiKey(),
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      describeTable: (...a: unknown[]) => describeTable(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      tableRowEstimate: (...a: unknown[]) => tableRowEstimate(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { DangerousQueryDialog } from "../components/DangerousQueryDialog";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onConfirm = vi.fn();
const onCancel = vi.fn();

function enable(sendScope: "schemaOnly" | "schemaAndSql" = "schemaAndSql", enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true, sendScope },
  });
}

function ui(opts: { isProduction?: boolean; withContext?: boolean } = {}) {
  return (
    <DangerousQueryDialog
      findings={[{ kind: "updateNoWhere", target: "orders" }]}
      isProduction={opts.isProduction ?? false}
      impact={{ verb: "update", count: 42, allRows: true }}
      aiContext={
        opts.withContext === false
          ? null
          : { sessionId: "s1", driver: "mysql", database: "app", sql: "UPDATE orders SET note = 'top-secret-note'" }
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

const result = JSON.stringify({
  summary: "SUMMARY_TEXT",
  affected_tables: [{ table: "orders", estimated_rows: "all rows", reason: "no where" }],
  cascades: [{ from: "orders", to: "order_items", via: "fk_items" }],
  risk: "high",
  recommendations: ["REC_TEXT"],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hasAiApiKey.mockResolvedValue(true);
  describeTable.mockResolvedValue([
    { name: "id", data_type: "int", nullable: false, key: "PRI", default: "DEFAULT_SENTINEL", extra: "", referenced_table: null, referenced_column: null },
  ]);
  foreignKeys.mockResolvedValue([
    { table: "order_items", column: "order_id", referenced_table: "orders", referenced_column: "id", constraint_name: "fk_items" },
  ]);
  tableRowEstimate.mockResolvedValue(12000);
  handlers = null;
  enable();
});

const last = (els: HTMLElement[]) => els[els.length - 1];

/**
 * ダイアログを描画し、Ark (zag) の Dialog が「ダイアログ外を aria-hidden にする」処理を
 * 終えるまで待つ。入れ子の確認ダイアログを開くテストはこれで描画する。
 *
 * zag はこの処理を開いた後の requestAnimationFrame まで遅らせ、実行時点の `<body>`
 * 直下にある自分以外の要素をすべて aria-hidden にする。その前に入れ子の確認ダイアログ
 * (別のポータル) を開くと、後から走った外側の処理が入れ子側まで aria-hidden にし、外側が
 * 閉じるまで外れない。すると確認ボタンがアクセシビリティツリーから消え、`getByRole` /
 * `findByRole` で見つからなくなる (`findByText` は aria-hidden を見ないので通ってしまう)。
 * 負荷で rAF が遅れた CI でだけ落ちていた原因。人の操作では外側が開いてから 1 フレーム
 * 以内に AI ボタンは押せないので、製品側では起きない。
 *
 * 外側の処理が済むと、描画コンテナ (`<body>` 直下でダイアログのポータルの兄弟) に
 * aria-hidden が付くので、それを待つ。
 */
async function renderSettled(element: ReturnType<typeof ui>) {
  const { container } = renderWithProviders(element);
  await waitFor(() => expect(container).toHaveAttribute("aria-hidden", "true"));
}

const analyze = () => screen.findByRole("button", { name: t("dangerousAiButton") });

describe("DangerousQueryDialog の AI 影響分析 (#694)", () => {
  it("AI 無効 / キー未設定 / コンテキスト無しではボタンを出さない", async () => {
    enable("schemaAndSql", false);
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: t("dangerousAiButton") })).toBeNull();
    expect(screen.queryByTestId("ai-setup-hint")).not.toBeNull();
    cleanup();
    enable();
    hasAiApiKey.mockResolvedValue(false);
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: t("dangerousAiButton") })).toBeNull();
    cleanup();
    hasAiApiKey.mockResolvedValue(true);
    renderWithProviders(ui({ withContext: false }));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: t("dangerousAiButton") })).toBeNull();
  });

  it("自動送信せず、押したときだけ impactAnalysis タスクで要求する。行データは送らない", async () => {
    renderWithProviders(ui());
    await analyze();
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(await analyze());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("impactAnalysis");
    expect(req.format.type).toBe("json_schema");
    expect(req.prompt).toContain("order_items.order_id -> orders.id");
    expect(req.prompt).toContain("orders (estimated rows: 12000)");
    expect(req.prompt).toContain("estimated affected rows: 42");
    expect(req.prompt).not.toContain("top-secret-note");
    expect(req.prompt).not.toContain("DEFAULT_SENTINEL");
  });

  it("2 回クリックしても要求は 1 本だけ", async () => {
    renderWithProviders(ui());
    const btn = await analyze();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(runAiRequest).toHaveBeenCalledTimes(1);
  });

  it("分析中にアンマウントすると stream ID 付きで中止し unlisten する", async () => {
    const { unmount } = renderWithProviders(ui());
    fireEvent.click(await analyze());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const streamId = runAiRequest.mock.calls[0][0].streamId;
    unmount();
    expect(cancelStream).toHaveBeenCalledWith(streamId);
    expect(unlisten).toHaveBeenCalled();
  });

  it("スキーマ取得中にアンマウントすると要求を出さない", async () => {
    let release: (v: unknown[]) => void = () => {};
    describeTable.mockReturnValue(new Promise((r) => { release = r; }));
    const { unmount } = renderWithProviders(ui());
    fireEvent.click(await analyze());
    await waitFor(() => expect(describeTable).toHaveBeenCalled());
    await screen.findByText(t("dangerousAiRunning"));
    unmount();
    release([]);
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("結果を表示し、常に UX ガードの注意書きを出す", async () => {
    renderWithProviders(ui());
    expect(await screen.findByText(t("dangerousAiGuardNote"))).toBeTruthy();
    fireEvent.click(await analyze());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SUMMARY_TEXT");
    expect(screen.getByText(t("dangerousAiCascadesNote"))).toBeTruthy();
    expect(screen.getByText(/REC_TEXT/)).toBeTruthy();
    expect(screen.getByText(t("dangerousAiRiskHigh")).getAttribute("data-risk")).toBe("high");
    // 折りたたみ
    fireEvent.click(screen.getByRole("button", { name: t("dangerousAiResultToggle") }));
    expect(screen.queryByText("SUMMARY_TEXT")).toBeNull();
    expect(screen.getByText(t("dangerousAiGuardNote"))).toBeTruthy();
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui());
    fireEvent.click(await analyze());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("分析中も実行 / キャンセルが押せ、中止できる", async () => {
    renderWithProviders(ui());
    fireEvent.click(await analyze());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const stop = await screen.findByRole("button", { name: t("dangerousAiStop") });
    const run = screen.getByRole("button", { name: t("dangerousConfirm") }) as HTMLButtonElement;
    const cancelBtn = last(screen.getAllByRole("button", { name: t("dangerousCancel") })) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);
    fireEvent.click(stop);
    expect(cancelStream).toHaveBeenCalled();
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("dangerousAiCancelled"));
    fireEvent.click(run);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("分析中に実行 / キャンセルを押してもダイアログを閉じられる", async () => {
    renderWithProviders(ui());
    fireEvent.click(await analyze());
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(last(screen.getAllByRole("button", { name: t("dangerousCancel") })) as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("schemaOnly では SQL 送信前に確認し、取り消すと送らない", async () => {
    enable("schemaOnly");
    await renderSettled(ui());
    fireEvent.click(await analyze());
    await screen.findByText(t("dangerousAiScopeTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(last(screen.getAllByRole("button", { name: t("confirmDefaultCancel") })) as HTMLElement);
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
    // 元のダイアログの操作は生きている
    await waitFor(() => expect(screen.getByRole("button", { name: t("dangerousConfirm") })).toBeTruthy());
  });

  it("本番接続では確認し、承認すると送信してフォーカスがボタンへ戻る", async () => {
    await renderSettled(ui({ isProduction: true }));
    fireEvent.click(await analyze());
    await screen.findByText(t("dangerousAiProdTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("dangerousAiConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: t("dangerousAiButton") })),
    );
  });
});
