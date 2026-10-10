import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeDatabase = vi.fn();
const listTableComments = vi.fn();
const foreignKeys = vi.fn();
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const unlisten = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;
let listenGate: Promise<void> | null = null;

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      if (listenGate !== null) await listenGate;
      return unlisten;
    }),
    api: {
      ...actual.api,
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      describeDatabase: (...a: unknown[]) => describeDatabase(...a),
      listTableComments: (...a: unknown[]) => listTableComments(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiQueryModal } from "../components/AiQueryModal";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onInsert = vi.fn();
const onOpenInNewTab = vi.fn();
const onClose = vi.fn();

function enable(enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true },
  });
}

function ui(over: Partial<React.ComponentProps<typeof AiQueryModal>> = {}) {
  return (
    <AiQueryModal
      sessionId="s1"
      driver="postgres"
      database="app"
      readOnly={false}
      isProduction={false}
      onInsert={onInsert}
      onOpenInNewTab={onOpenInNewTab}
      onClose={onClose}
      {...over}
    />
  );
}

const result = JSON.stringify({
  sql: "SELECT 1",
  explanation: "説明です",
  warnings: ["注意です"],
  tables_used: ["orders"],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  listenGate = null;
  describeDatabase.mockResolvedValue([table("orders", ["id", "amount"])]);
  listTableComments.mockResolvedValue([]);
  foreignKeys.mockResolvedValue([]);
  enable();
});

function table(name: string, cols: string[]) {
  return {
    name,
    columns: cols.map((c, i) => ({
      name: c,
      data_type: i === 0 ? "bigint" : "text",
      nullable: i !== 0,
      key: i === 0 ? "PRI" : "",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    })),
  };
}

async function generate(text = "注文を集計して") {
  const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
  fireEvent.change(input, { target: { value: text } });
  const btn = screen.getByRole("button", { name: t("aiQueryGenerate") });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

describe("AiQueryModal (#691)", () => {
  it("AI 無効なら何も描かない", async () => {
    enable(false);
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByTestId("ai-query-modal")).toBeNull();
  });

  it("生成 → 結果表示 → 挿入 / 新しいタブで開く。nl2sql タスクで依頼し、実行はしない", async () => {
    renderWithProviders(ui());
    const btn = await generate();
    fireEvent.click(btn); // 二重クリックでも 1 本だけ
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("nl2sql");
    expect(req.prompt).toBe("注文を集計して");
    expect(req.systemCached).toContain("PostgreSQL");
    expect(req.systemCached).toContain("- orders(id bigint PK, amount text null)");
    expect(req.format.type).toBe("json_schema");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SELECT 1");
    expect(screen.getByText("説明です")).toBeTruthy();
    expect(screen.getByText("注意です")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryInsert") }));
    expect(onInsert).toHaveBeenCalledWith("SELECT 1");
    await screen.findByText(t("aiQueryInserted"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryOpenInNewTab") }));
    expect(onOpenInNewTab).toHaveBeenCalledWith("SELECT 1", "app");
    // 挿入後も説明・注意点は見えたまま。
    expect(screen.getByText("説明です")).toBeTruthy();
  });

  it("追い質問: 2 回目の要求に前回の依頼と回答が履歴として載り、新規の生成は履歴なし (#1471)", async () => {
    renderWithProviders(ui());
    await generate("注文を集計して");
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    // 単発 (1 回目) は history を渡さない。
    expect(runAiRequest.mock.calls[0][0].history).toBeUndefined();
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SELECT 1");
    const followUp = await screen.findByLabelText(t("aiFollowUpLabel"));
    fireEvent.change(followUp, { target: { value: "先月分だけに絞って" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiFollowUpSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    const second = runAiRequest.mock.calls[1][0];
    expect(second.prompt).toBe("先月分だけに絞って");
    expect(second.history).toEqual([
      { role: "user", content: "注文を集計して" },
      { role: "assistant", content: result },
    ]);
    // スキーマ (固定部分) は追い質問でも同じ。
    expect(second.systemCached).toBe(runAiRequest.mock.calls[0][0].systemCached);
    // 2 回目の回答が返ると、3 回目には 2 往復分が載る。
    const result2 = JSON.stringify({ sql: "SELECT 2", explanation: "e2", warnings: [], tables_used: [] });
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result2 });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SELECT 2");
    fireEvent.change(await screen.findByLabelText(t("aiFollowUpLabel")), { target: { value: "金額の多い順に" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiFollowUpSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(3));
    const third = runAiRequest.mock.calls[2][0];
    expect(third.history.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(third.history[3].content).toBe(result2);
  });

  it("追い質問は生成結果が出るまで出ず、空入力では送れない (#1471)", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("aiQueryRequestLabel"));
    expect(screen.queryByLabelText(t("aiFollowUpLabel"))).toBeNull();
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("SELECT 1");
    const send = await screen.findByRole("button", { name: t("aiFollowUpSend") });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it("読み取り専用ならプロンプトに SELECT 制約が入る", async () => {
    renderWithProviders(ui({ readOnly: true }));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    expect(runAiRequest.mock.calls[0][0].systemCached).toContain("READ-ONLY");
  });

  it("中止でき、アンマウント時は実行中ストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiQueryCancelled"));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(2);
  });

  it("購読の完了前に中止したら、リクエストを送らずに中止表示にする", async () => {
    let release: () => void = () => {};
    listenGate = new Promise<void>((r) => {
      release = r;
    });
    renderWithProviders(ui());
    await generate();
    fireEvent.click(await screen.findByRole("button", { name: t("aiQueryCancel") }));
    await act(async () => release());
    await screen.findByText(t("aiQueryCancelled"));
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("リクエスト登録前に中止したら、登録後に同じ streamId であらためて cancelStream する", async () => {
    let finish: () => void = () => {};
    runAiRequest.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = () => r();
        }),
    );
    renderWithProviders(ui());
    await generate();
    fireEvent.click(await screen.findByRole("button", { name: t("aiQueryCancel") }));
    const streamId = runAiRequest.mock.calls[0][0].streamId;
    expect(cancelStream).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(cancelStream).toHaveBeenCalledTimes(2));
    expect(cancelStream.mock.calls.map((c) => c[0])).toEqual([streamId, streamId]);
  });

  it("JSON でない応答は本文をそのまま見せる", async () => {
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain text" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText("plain text");
  });

  it("本番では送信前に確認し、取り消すと送らない", async () => {
    renderWithProviders(ui({ isProduction: true }));
    await generate();
    await screen.findByText(t("aiQueryConfirmTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("aiQueryConfirmTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();
    await generate();
    await screen.findByText(t("aiQueryConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  async function generateAndFinish(text: string, out = result) {
    await generate(text);
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: out });
      handlers?.onDone?.({} as never);
    });
    await screen.findByLabelText(t("aiFollowUpLabel"));
  }

  it("本番でも追い質問では再確認せず、新規の生成は会話をリセットして history を付けない (#1471)", async () => {
    renderWithProviders(ui({ isProduction: true }));
    await generate("注文を集計して");
    await screen.findByText(t("aiQueryConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    fireEvent.change(await screen.findByLabelText(t("aiFollowUpLabel")), { target: { value: "絞って" } });
    fireEvent.click(await screen.findByRole("button", { name: t("aiFollowUpSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(t("aiQueryConfirmTitle"))).toBeNull();
    expect(runAiRequest.mock.calls[1][0].history).toHaveLength(2);
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByLabelText(t("aiFollowUpLabel"));
    // 新規の生成は本番確認が出て、history なしで送られる。
    fireEvent.change(screen.getByLabelText(t("aiQueryRequestLabel")), { target: { value: "別の依頼" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryGenerate") }));
    await screen.findByText(t("aiQueryConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(3));
    expect(runAiRequest.mock.calls[2][0].history).toBeUndefined();
    expect(runAiRequest.mock.calls[2][0].prompt).toBe("別の依頼");
  });

  it("接続 / データベースが変わると会話を捨て、追い質問欄も消える (#1471)", async () => {
    const view = renderWithProviders(ui());
    await generateAndFinish("注文を集計して");
    fireEvent.change(screen.getByLabelText(t("aiFollowUpLabel")), { target: { value: "絞って" } });
    view.rerender(ui({ database: "other" }));
    await waitFor(() => expect(screen.queryByLabelText(t("aiFollowUpLabel"))).toBeNull());
    view.rerender(ui({ sessionId: "s2", database: "other" }));
    expect(screen.queryByLabelText(t("aiFollowUpLabel"))).toBeNull();
  });

  it("テーブルが多いスキーマは送信前に件数を見せる", async () => {
    describeDatabase.mockResolvedValue(Array.from({ length: 301 }, (_, i) => table(`t${i}`, ["id"])));
    renderWithProviders(ui());
    const sends = await screen.findByTestId("ai-query-sends");
    expect(sends.textContent).toContain("301");
    expect(screen.getByText(/This schema is large|スキーマが大きい/)).toBeTruthy();
  });

  describe("大きい DB の関連テーブル選択 (#1472)", () => {
    const bigSchema = () => [
      table("orders", ["id", "amount"]),
      table("customers", ["id", "name"]),
      ...Array.from({ length: 300 }, (_, i) => table(`misc_${i}`, ["id"])),
    ];

    it("依頼文に関連するテーブルだけを送り、送信量の表示にも反映する。追い質問は同じ集合を使う", async () => {
      describeDatabase.mockResolvedValue(bigSchema());
      listTableComments.mockResolvedValue([{ name: "customers", comment: "顧客" }]);
      foreignKeys.mockResolvedValue([
        { table: "orders", column: "id", referenced_table: "customers", referenced_column: "id" },
      ]);
      renderWithProviders(ui());
      await generate("orders amount");
      await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
      const first = runAiRequest.mock.calls[0][0];
      expect(first.systemCached).toContain("- orders(");
      expect(first.systemCached).toContain('- customers "顧客"(');
      expect(first.systemCached).not.toContain("misc_0");
      expect(screen.getByTestId("ai-query-sends").textContent).toContain("2");
      expect(screen.getByTestId("ai-query-sends").textContent).toContain("302");
      act(() => {
        handlers?.onDelta?.({ streamId: "x", text: result });
        handlers?.onDone?.({} as never);
      });
      await screen.findByText("SELECT 1");
      // 追い質問の途中で選択を変えても、送るスキーマは最初の集合のまま。
      fireEvent.click(screen.getByLabelText("misc_0"));
      fireEvent.change(await screen.findByLabelText(t("aiFollowUpLabel")), { target: { value: "絞って" } });
      fireEvent.click(screen.getByRole("button", { name: t("aiFollowUpSend") }));
      await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
      expect(runAiRequest.mock.calls[1][0].systemCached).toBe(first.systemCached);
    });

    it("ユーザがテーブルを追加・除外でき、1 件も無いと生成できない", async () => {
      describeDatabase.mockResolvedValue(bigSchema());
      renderWithProviders(ui());
      const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
      fireEvent.change(input, { target: { value: "ほげふが" } });
      await screen.findByText(t("aiQueryTablesNone"));
      const gen = screen.getByRole("button", { name: t("aiQueryGenerate") }) as HTMLButtonElement;
      expect(gen.disabled).toBe(true);
      fireEvent.click(screen.getByLabelText("misc_3"));
      await waitFor(() => expect(gen.disabled).toBe(false));
      fireEvent.click(gen);
      await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
      expect(runAiRequest.mock.calls[0][0].systemCached).toContain("- misc_3(");
      expect(runAiRequest.mock.calls[0][0].systemCached).not.toContain("- orders(");
    });
  });

  it("閾値以下の DB は全テーブルを固定順で送る", async () => {
    describeDatabase.mockResolvedValue([table("b", ["id"]), table("a", ["id"])]);
    renderWithProviders(ui());
    await generate("a");
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const sys: string = runAiRequest.mock.calls[0][0].systemCached;
    expect(sys.indexOf("- b(")).toBeGreaterThan(0);
    expect(sys.indexOf("- b(")).toBeLessThan(sys.indexOf("- a("));
    expect(screen.queryByTestId("ai-query-tables")).toBeNull();
  });

  it("データベースが無い (MySQL 未選択) ときは生成できない", async () => {
    renderWithProviders(ui({ driver: "mysql", database: null }));
    await screen.findByText(t("aiQueryNoDatabase"));
    expect((screen.getByRole("button", { name: t("aiQueryGenerate") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("テーブルが 0 件なら警告を出して生成を無効にする", async () => {
    describeDatabase.mockResolvedValue([]);
    renderWithProviders(ui());
    await screen.findByText(t("aiQueryEmptySchema"));
    fireEvent.change(screen.getByLabelText(t("aiQueryRequestLabel")), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: t("aiQueryGenerate") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("onError と aiRefused を表示し分ける", async () => {
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    await screen.findByText(t("aiQueryError", { message: "boom" }));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    act(() => handlers?.onError?.({ streamId: "x", error: "no", kind: "aiRefused" }));
    await screen.findByText(t("aiQueryRefused", { message: "no" }));
  });
});
