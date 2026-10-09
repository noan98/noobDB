import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeTable = vi.fn();
const runQuery = vi.fn();
const insertGeneratedRows = vi.fn();
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const hasAiApiKey = vi.fn().mockResolvedValue(true);
const unlisten = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;
let listenGate: Promise<void> = Promise.resolve();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenAiStream: vi.fn(async (_id: string, h: import("../api/tauri").AiStreamHandlers) => {
      handlers = h;
      await listenGate;
      return unlisten;
    }),
    api: {
      ...actual.api,
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      describeTable: (...a: unknown[]) => describeTable(...a),
      runQuery: (...a: unknown[]) => runQuery(...a),
      insertGeneratedRows: (...a: unknown[]) => insertGeneratedRows(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
      hasAiApiKey: () => hasAiApiKey(),
    },
  };
});

import { setAiKeyPresent } from "../ai/aiKeyStore";
import { TestDataModal } from "../components/TestDataModal";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onClose = vi.fn();
const onInserted = vi.fn();

function column(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    data_type: "varchar(100)",
    nullable: false,
    key: "",
    default: "SECRET-DEFAULT",
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

function enable(enabled = true, key = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true },
  });
  hasAiApiKey.mockResolvedValue(key);
  setAiKeyPresent(key);
}

function ui(over: Partial<React.ComponentProps<typeof TestDataModal>> = {}) {
  return (
    <TestDataModal
      sessionId="s1"
      database="app"
      table="orders"
      driver="mysql"
      isProduction={false}
      onClose={onClose}
      onInserted={onInserted}
      {...over}
    />
  );
}

const aiResponse = JSON.stringify({
  columns: [
    { name: "product_name", kind: "choices", choices: ["ペン", "ノート"], notes: "" },
    { name: "unit_price", kind: "choices", choices: ["120", "250"], notes: "" },
  ],
  consistency_rules: [{ columns: ["product_name", "unit_price"], description: "価格は商品に対応" }],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  listenGate = Promise.resolve();
  describeTable.mockResolvedValue([
    column("id", { data_type: "int", key: "PRI", extra: "auto_increment" }),
    column("customer_id", { data_type: "int", referenced_table: "customers", referenced_column: "id" }),
    column("product_name"),
    column("unit_price", { data_type: "int" }),
  ]);
  runQuery.mockResolvedValue({ rows: [[1], [2], [3]] });
  insertGeneratedRows.mockResolvedValue({ elapsed_ms: 5 });
  enable();
});

async function selectAiMode() {
  const select = await screen.findByLabelText(t("testDataModeLabel"));
  await screen.findByLabelText(t("testDataStrategyAria", { column: "product_name" }));
  fireEvent.change(select, { target: { value: "ai" } });
  return screen.findByTestId("testdata-ai-panel");
}

async function startGenerate() {
  await selectAiMode();
  const btn = screen.getByRole("button", { name: t("testDataAiGenerate") });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
}

describe("TestDataModal AI モード (#698)", () => {
  it("AI 無効のときはモード選択が出ずルールベースのまま", async () => {
    enable(false);
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "product_name" }));
    expect(screen.queryByLabelText(t("testDataModeLabel"))).toBeNull();
    expect(screen.queryByText(t("testDataAiGenerate"))).toBeNull();
  });

  it("キーが無いときもモード選択は出ない", async () => {
    enable(true, false);
    renderWithProviders(ui());
    await screen.findByLabelText(t("testDataStrategyAria", { column: "product_name" }));
    expect(screen.queryByLabelText(t("testDataModeLabel"))).toBeNull();
  });

  it("生成 → プレビュー → 投入。testData タスクで依頼し、実データ・デフォルト値は送らない", async () => {
    renderWithProviders(ui());
    await startGenerate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("testData");
    expect(req.model).toBeUndefined();
    expect(req.format.type).toBe("json_schema");
    expect(req.system).toContain("Table: orders");
    expect(req.system).toContain("- product_name:");
    expect(req.system).not.toContain("SECRET-DEFAULT");
    // 親テーブルの既存 PK (runQuery の結果) はプロンプトに載らない。
    expect(req.system).toContain("customer_id -> customers.id");
    expect(`${req.system}${req.prompt}`).not.toMatch(/1, 2, 3|\[1,2,3\]/);
    expect(screen.getByTestId("testdata-ai-sends").textContent).toContain("orders");
    // 投入はまだできない (計画が無い)。
    expect((screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: aiResponse });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText(t("testDataPreviewTitle", { count: 20 }));
    const run = screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(insertGeneratedRows).toHaveBeenCalledTimes(1));
    const arg = insertGeneratedRows.mock.calls[0][0];
    expect(arg.table).toBe("orders");
    expect(arg.columns).toEqual(["customer_id", "product_name", "unit_price"]);
    expect(arg.rows).toHaveLength(100);
    for (const r of arg.rows) {
      expect([1, 2, 3]).toContain(r[0]); // 既存の親 PK から選ばれる (FK が壊れない)
      expect(["ペン:120", "ノート:250"]).toContain(`${r[1]}:${r[2]}`);
    }
    await waitFor(() => expect(onInserted).toHaveBeenCalled());
  });

  it("応答が不正ならエラーを出し、ルールベースへの切り替えを案内する", async () => {
    renderWithProviders(ui());
    await startGenerate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "plain" });
      handlers?.onDone?.({} as never);
    });
    await screen.findByText(t("testDataAiParseError"));
    expect((screen.getByRole("button", { name: t("testDataRun") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("実行中に中止でき、アンマウント時は実行中ストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui());
    await startGenerate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t("testDataAiCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("testDataAiCancelled"));
    fireEvent.click(screen.getByRole("button", { name: t("testDataAiGenerate") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(2);
  });

  it("購読の登録前に中止したらリクエストを送らず cancelStream する", async () => {
    let release: () => void = () => {};
    listenGate = new Promise<void>((r) => {
      release = r;
    });
    renderWithProviders(ui());
    await startGenerate();
    fireEvent.click(await screen.findByRole("button", { name: t("testDataAiCancel") }));
    await act(async () => {
      release();
    });
    await screen.findByText(t("testDataAiCancelled"));
    expect(runAiRequest).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalled();
    expect(cancelStream).toHaveBeenCalled();
  });

  it("本番接続では送信前に確認し、取り消すと送らない", async () => {
    renderWithProviders(ui({ isProduction: true }));
    await startGenerate();
    await screen.findByText(t("testDataAiConfirmTitle"));
    expect(runAiRequest).not.toHaveBeenCalled();
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("testDataAiConfirmTitle"))).toBeNull());
    expect(runAiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("testDataAiGenerate") }));
    await screen.findByText(t("testDataAiConfirmTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("testDataAiConfirmSend") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
  });

  it("onError と aiRefused を表示し分ける", async () => {
    renderWithProviders(ui());
    await startGenerate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiApi" }));
    await screen.findByText(t("testDataAiError", { message: "boom" }));
    fireEvent.click(screen.getByRole("button", { name: t("testDataAiGenerate") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    act(() => handlers?.onError?.({ streamId: "x", error: "no", kind: "aiRefused" }));
    await screen.findByText(t("testDataAiRefused", { message: "no" }));
  });
});
