import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeDatabase = vi.fn();
const schemaOverview = vi.fn();
const describeTable = vi.fn();
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
      schemaOverview: (...a: unknown[]) => schemaOverview(...a),
      describeTable: (...a: unknown[]) => describeTable(...a),
      listTableComments: (...a: unknown[]) => listTableComments(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { AiQueryModal } from "../components/AiQueryModal";
import { format } from "sql-formatter";
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
  setDb([table("orders", ["id", "amount"])]);
  listTableComments.mockResolvedValue([]);
  foreignKeys.mockResolvedValue([]);
  enable();
});

/** 概要 (schemaOverview)・一括詳細 (describeDatabase)・テーブル単位 (describeTable) を同じ内容で用意する。 */
function setDb(tables: ReturnType<typeof table>[]) {
  schemaOverview.mockResolvedValue(tables.map((x) => ({ name: x.name, columns: x.columns.map((c) => c.name) })));
  describeDatabase.mockResolvedValue(tables);
  describeTable.mockImplementation(async (_s: string, _d: string, name: string) => {
    return tables.find((x) => x.name === name)?.columns ?? [];
  });
}

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

/** 提案 SQL の表示 (整形・色分け済み) を、空白を詰めた文字列で待つ。 */
async function findSql(text: string) {
  await waitFor(() =>
    expect(screen.getByTestId("ai-query-sql").textContent?.replace(/\s+/g, " ").trim()).toBe(text),
  );
}

async function generate(text = "注文を集計して") {
  const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
  fireEvent.change(input, { target: { value: text } });
  const btn = screen.getByRole("button", { name: t("aiQuerySend") });
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
    await findSql("SELECT 1");
    expect(screen.getByText("説明です")).toBeTruthy();
    expect(screen.getByText("注意です")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryInsert") }));
    // 生成 SQL は整形してから表示・挿入する。
    expect(onInsert).toHaveBeenCalledWith(format("SELECT 1", { language: "postgresql" }));
    await screen.findByText(t("aiQueryInserted"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryOpenInNewTab") }));
    expect(onOpenInNewTab).toHaveBeenCalledWith(format("SELECT 1", { language: "postgresql" }), "app");
    // 挿入後も説明・注意点は見えたまま。
    expect(screen.getByText("説明です")).toBeTruthy();
  });

  it("やりとりが始まるまで右ペイン (結果) とチャット欄は出さず、最初の送信で出す。新しい会話で閉じる", async () => {
    renderWithProviders(ui());
    await screen.findByLabelText(t("aiQueryRequestLabel"));
    expect(screen.queryByTestId("ai-query-result")).toBeNull();
    // チャット欄も送信前は出さない (入力欄だけ)。
    expect(screen.queryByTestId("ai-query-log")).toBeNull();
    await generate();
    await screen.findByTestId("ai-query-result");
    expect(screen.getByTestId("ai-query-log")).toBeTruthy();
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await findSql("SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryNewConversation") }));
    await waitFor(() => expect(screen.queryByTestId("ai-query-result")).toBeNull());
  });

  it("1 行で返った SQL も整形して表示し、整形できない SQL はそのまま出す", async () => {
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const oneLine = JSON.stringify({ sql: "select id, amount from orders where amount > 10 order by id", explanation: "", warnings: [], tables_used: [] });
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: oneLine });
      handlers?.onDone?.({} as never);
    });
    const shown = await screen.findByText((_, el) => el?.tagName === "PRE" && (el.textContent ?? "").includes("orders"));
    expect(shown.textContent).toBe(format("select id, amount from orders where amount > 10 order by id", { language: "postgresql" }));
    expect(shown.textContent?.split("\n").length).toBeGreaterThan(3);
    // キーワードはエディタと同じ配色変数で色分けする。
    expect(shown.querySelector("span")?.getAttribute("style")).toContain("var(--syntax-keyword)");
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
    await findSql("SELECT 1");
    const followUp = await screen.findByLabelText(t("aiQueryRequestLabel"));
    fireEvent.change(followUp, { target: { value: "先月分だけに絞って" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiQuerySend") }));
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
    await findSql("SELECT 2");
    fireEvent.change(await screen.findByLabelText(t("aiQueryRequestLabel")), { target: { value: "金額の多い順に" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiQuerySend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(3));
    const third = runAiRequest.mock.calls[2][0];
    expect(third.history.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(third.history[3].content).toBe(result2);
  });

  it("回答後は同じ入力欄が追い質問になり、空入力では送れない (#1471)", async () => {
    renderWithProviders(ui());
    const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
    expect(input.getAttribute("placeholder")).toBe(t("aiQueryRequestPlaceholder"));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await findSql("SELECT 1");
    const send = await screen.findByRole("button", { name: t("aiQuerySend") });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    // 送った依頼はチャット欄に残り、入力欄は空に戻って追い質問用の案内になる。
    expect(screen.getByTestId("ai-query-log-user").textContent).toBe("注文を集計して");
    expect(screen.getByTestId("ai-query-log-agent")).toBeTruthy();
    expect(screen.getByLabelText(t("aiQueryRequestLabel")).getAttribute("placeholder")).toBe(t("aiFollowUpPlaceholder"));
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
    await screen.findByTestId("ai-query-log-agent");
  }

  it("本番でも追い質問では再確認せず、新しい会話の生成はリセットして history を付けない (#1471)", async () => {
    renderWithProviders(ui({ isProduction: true }));
    await generate("注文を集計して");
    await screen.findByText(t("aiQueryConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    fireEvent.change(await screen.findByLabelText(t("aiQueryRequestLabel")), { target: { value: "絞って" } });
    fireEvent.click(await screen.findByRole("button", { name: t("aiQuerySend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(t("aiQueryConfirmTitle"))).toBeNull();
    expect(runAiRequest.mock.calls[1][0].history).toHaveLength(2);
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await screen.findByLabelText(t("aiQueryRequestLabel"));
    // 「新しい会話」からの生成は本番確認が出て、history なしで送られる。
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryNewConversation") }));
    // チャット欄は退場アニメーションの後に消える。
    await waitFor(() => expect(screen.queryAllByTestId("ai-query-log-user")).toHaveLength(0));
    fireEvent.change(screen.getByLabelText(t("aiQueryRequestLabel")), { target: { value: "別の依頼" } });
    fireEvent.click(screen.getByRole("button", { name: t("aiQuerySend") }));
    await screen.findByText(t("aiQueryConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("aiQueryConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(3));
    expect(runAiRequest.mock.calls[2][0].history).toBeUndefined();
    expect(runAiRequest.mock.calls[2][0].prompt).toBe("別の依頼");
  });

  it("接続 / データベースが変わると会話を捨て、最初の依頼の入力に戻る (#1471)", async () => {
    const view = renderWithProviders(ui());
    await generateAndFinish("注文を集計して");
    expect(screen.getByTestId("ai-query-log-user")).toBeTruthy();
    view.rerender(ui({ database: "other" }));
    await waitFor(() => expect(screen.queryByTestId("ai-query-log-user")).toBeNull());
    // 追い質問ではなく最初の依頼の入力に戻る。
    expect(screen.getByLabelText(t("aiQueryRequestLabel")).getAttribute("placeholder")).toBe(t("aiQueryRequestPlaceholder"));
  });

  it("テーブルが多いスキーマは送信前に件数を見せる", async () => {
    setDb(Array.from({ length: 301 }, (_, i) => table(`t${i}`, ["id"])));
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
      setDb(bigSchema());
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
      // 大きい DB は全列の一括取得 (describeDatabase) を使わず、送るテーブルだけ describeTable で型・PK を取る。
      expect(describeDatabase).not.toHaveBeenCalled();
      expect(first.systemCached).toContain("id bigint PK");
      expect(describeTable.mock.calls.map((c) => c[2]).sort()).toEqual(["customers", "orders"]);
      expect(screen.getByTestId("ai-query-sends").textContent).toContain("2");
      expect(screen.getByTestId("ai-query-sends").textContent).toContain("302");
      act(() => {
        handlers?.onDelta?.({ streamId: "x", text: result });
        handlers?.onDone?.({} as never);
      });
      await findSql("SELECT 1");
      // 追い質問の途中は選択欄を出さず、送るスキーマは最初の集合のまま。
      expect(screen.queryByTestId("ai-query-tables")).toBeNull();
      fireEvent.change(await screen.findByLabelText(t("aiQueryRequestLabel")), { target: { value: "絞って" } });
      fireEvent.click(screen.getByRole("button", { name: t("aiQuerySend") }));
      await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
      expect(runAiRequest.mock.calls[1][0].systemCached).toBe(first.systemCached);
      // 追い質問では詳細を取り直さない。
      expect(describeTable).toHaveBeenCalledTimes(2);
    });

    it("本番の確認文面に絞り込み後の件数と、型・キー・コメントも送る旨が出る", async () => {
      setDb(bigSchema());
      renderWithProviders(ui({ isProduction: true }));
      await generate("orders amount");
      await screen.findByText(t("aiQueryConfirmTitle"));
      const dialog = screen.getByText((c) => c.includes(t("aiQueryConfirmBody")));
      // 全 302 テーブルではなく、絞り込み後の 1 テーブル を示す。
      expect(dialog.textContent).toMatch(/1 of 302 tables|302 件中 1 件/);
      expect(dialog.textContent).toMatch(/types, keys and comments|型・キー・コメント/);
      expect(runAiRequest).not.toHaveBeenCalled();
    });

    it("DB を切り替えると、固定した集合と手動選択がリセットされる", async () => {
      setDb(bigSchema());
      const view = renderWithProviders(ui());
      fireEvent.change(await screen.findByLabelText(t("aiQueryRequestLabel")), { target: { value: "orders amount" } });
      // 手動で 1 件足してから送る (この選択は DB 切り替えで消えるべきもの)。
      fireEvent.click(await screen.findByLabelText("misc_5"));
      fireEvent.click(screen.getByRole("button", { name: t("aiQuerySend") }));
      await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
      act(() => {
        handlers?.onDelta?.({ streamId: "x", text: result });
        handlers?.onDone?.({} as never);
      });
      await screen.findByTestId("ai-query-log-agent");
      expect(screen.getByTestId("ai-query-sends").textContent).toContain(t("aiQueryTablesLocked", { count: 2 }));
      view.rerender(ui({ database: "other" }));
      await waitFor(() => expect(screen.queryByTestId("ai-query-log-agent")).toBeNull());
      // 手動選択 (misc_5) も消え、依頼文からの自動提案に戻る。
      await waitFor(() => expect((screen.getByLabelText("misc_5") as HTMLInputElement).checked).toBe(false));
      expect((screen.getByLabelText("orders") as HTMLInputElement).checked).toBe(true);
    });

    it("選択 0 件では Cmd+Enter でも新規生成が走らない", async () => {
      setDb(bigSchema());
      renderWithProviders(ui());
      const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
      fireEvent.change(input, { target: { value: "ほげふが" } });
      await screen.findByText(t("aiQueryTablesNone"));
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
      await act(async () => {});
      expect(runAiRequest).not.toHaveBeenCalled();
    });

    it("ユーザがテーブルを追加・除外でき、1 件も無いと生成できない", async () => {
      setDb(bigSchema());
      renderWithProviders(ui());
      const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
      fireEvent.change(input, { target: { value: "ほげふが" } });
      await screen.findByText(t("aiQueryTablesNone"));
      const gen = screen.getByRole("button", { name: t("aiQuerySend") }) as HTMLButtonElement;
      expect(gen.disabled).toBe(true);
      fireEvent.click(screen.getByLabelText("misc_3"));
      await waitFor(() => expect(gen.disabled).toBe(false));
      fireEvent.click(gen);
      await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
      expect(runAiRequest.mock.calls[0][0].systemCached).toContain("- misc_3(");
      expect(runAiRequest.mock.calls[0][0].systemCached).not.toContain("- orders(");
    });
  });

  it("開いているテーブルを、テーブル名の無い依頼の対象として伝える", async () => {
    setDb([table("orders", ["id"]), table("sms_receive", ["id"])]);
    renderWithProviders(ui({ focusTable: "orders" }));
    const input = await screen.findByLabelText(t("aiQueryRequestLabel"));
    expect(input.getAttribute("placeholder")).toBe(t("aiQueryRequestPlaceholderFocus", { table: "orders" }));
    await generate("今月に絞って取得したい");
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.system).toContain('viewing the table "orders"');
    // 開いているテーブルはタブごとに変わるので、キャッシュする固定部分には入れない。
    expect(req.systemCached).not.toContain("viewing the table");
  });

  it("大きい DB でも開いているテーブルは依頼文と無関係に送るテーブルへ入る", async () => {
    setDb([table("orders", ["id"]), ...Array.from({ length: 301 }, (_, i) => table(`misc_${i}`, ["id"]))]);
    renderWithProviders(ui({ focusTable: "misc_7" }));
    await generate("orders");
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.systemCached).toContain("- misc_7(");
    expect(req.systemCached).toContain("- orders(");
    expect(req.system).toContain('"misc_7"');
  });

  it("閾値以下の DB は全テーブルを固定順で送る", async () => {
    setDb([table("b", ["id"]), table("a", ["id"])]);
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
    expect((screen.getByRole("button", { name: t("aiQuerySend") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("テーブルが 0 件なら警告を出して生成を無効にする", async () => {
    setDb([]);
    renderWithProviders(ui());
    await screen.findByText(t("aiQueryEmptySchema"));
    fireEvent.change(screen.getByLabelText(t("aiQueryRequestLabel")), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: t("aiQuerySend") }) as HTMLButtonElement).disabled).toBe(true);
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
