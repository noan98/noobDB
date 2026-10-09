import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const describeDatabase = vi.fn();
const foreignKeys = vi.fn();
const listSchemaObjects = vi.fn();
const listTableComments = vi.fn();
const listIndexes = vi.fn();
const getObjectDefinition = vi.fn();
const writeTextFile = vi.fn();
const cancelStream = vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 });
const unlisten = vi.fn();
const save = vi.fn();
let handlers: import("../api/tauri").AiStreamHandlers | null = null;

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => save(...a) }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/dl"),
  join: vi.fn(async (...p: string[]) => p.join("/")),
}));
vi.mock("../components/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
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
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      describeDatabase: (...a: unknown[]) => describeDatabase(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      listSchemaObjects: (...a: unknown[]) => listSchemaObjects(...a),
      listTableComments: (...a: unknown[]) => listTableComments(...a),
      listIndexes: (...a: unknown[]) => listIndexes(...a),
      getObjectDefinition: (...a: unknown[]) => getObjectDefinition(...a),
      writeTextFile: (...a: unknown[]) => writeTextFile(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
  };
});

import { copyToClipboard } from "../components/clipboard";
import { AiSchemaDocModal } from "../components/AiSchemaDocModal";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onClose = vi.fn();

function enable(enabled = true) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled, consentGiven: true },
  });
}

function ui(over: Partial<React.ComponentProps<typeof AiSchemaDocModal>> = {}) {
  return (
    <AiSchemaDocModal
      sessionId="s1"
      driver="postgres"
      database="shop"
      profileName="本番DB"
      isProduction={false}
      onClose={onClose}
      {...over}
    />
  );
}

const col = (name: string, key = "") => ({
  name,
  data_type: "bigint",
  nullable: false,
  key,
  default: "SECRET_DEFAULT",
  extra: "",
  referenced_table: null,
  referenced_column: null,
  comment: null,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  describeDatabase.mockResolvedValue([
    { name: "customers", columns: [col("id", "PRI")] },
    { name: "orders", columns: [col("id", "PRI"), col("customer_id")] },
    { name: "logs", columns: [col("id", "PRI")] },
    { name: "v_sales", columns: [col("id")] },
  ]);
  foreignKeys.mockResolvedValue([
    { table: "orders", column: "customer_id", referenced_table: "customers", referenced_column: "id", constraint_name: null },
  ]);
  listSchemaObjects.mockResolvedValue([{ kind: "view", name: "v_sales", id: null }]);
  listTableComments.mockResolvedValue([]);
  listIndexes.mockResolvedValue([{ name: "PRIMARY", columns: ["id"], unique: true, primary: true, method: "BTREE" }]);
  getObjectDefinition.mockResolvedValue("SELECT 1 AS id");
  writeTextFile.mockResolvedValue(10);
  enable();
});

async function generate() {
  const btn = await screen.findByRole("button", { name: t("aiSchemaDocGenerate") });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

describe("AiSchemaDocModal (#696)", () => {
  it("AI 無効なら何も描かない", async () => {
    enable(false);
    renderWithProviders(ui());
    await act(async () => {});
    expect(screen.queryByTestId("ai-schema-doc-modal")).toBeNull();
  });

  it("送信前に件数 (テーブル・列・FK・KB) を 1 行で見せる", async () => {
    renderWithProviders(ui());
    const line = await screen.findByTestId("ai-schema-doc-sends");
    expect(line.textContent).toContain("4");
    expect(line.textContent).toContain("shop");
    expect(line.textContent).toContain("PostgreSQL");
  });

  it("生成 → 逐次表示 → 完了で冒頭注記が付く。schemaDoc タスクで format 無し、デフォルト値は送らない", async () => {
    renderWithProviders(ui());
    const btn = await generate();
    fireEvent.click(btn); // 連打しても 1 本だけ
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("schemaDoc");
    expect(req.format).toBeUndefined();
    expect(req.system).toContain("PostgreSQL");
    expect(req.system).toContain("### orders");
    expect(req.system).toContain("PRIMARY (id) PRIMARY UNIQUE BTREE");
    expect(req.system).toContain("SELECT 1 AS id");
    expect(req.system).not.toContain("SECRET_DEFAULT");
    // ビューにはインデックス取得をしない (テーブル 3 件のみ)。
    expect(listIndexes).toHaveBeenCalledTimes(3);

    act(() => handlers?.onDelta?.({ streamId: "x", text: "# 店舗" }));
    await screen.findByText(t("aiSchemaDocRunning", { chars: 4 }));
    expect(screen.getByLabelText(t("aiSchemaDocResult")).textContent).toBe("# 店舗");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "\n\n本文" });
      handlers?.onDone?.({} as never);
    });
    await waitFor(() => expect(screen.getByLabelText(t("aiSchemaDocResult")).textContent).toContain("AI-generated inferences"));
    const shown = screen.getByLabelText(t("aiSchemaDocResult")).textContent ?? "";
    expect(shown).toContain("Connection: 本番DB / shop (PostgreSQL)");
    expect(shown.indexOf("Generated at")).toBeLessThan(shown.indexOf("# 店舗"));
    expect(shown).toContain("本文");
  });

  it("完了後にコピーと保存ができる (保存は保存ダイアログ経由で writeTextFile)", async () => {
    save.mockResolvedValue("/dl/out.md");
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    // 完了前は押せない。
    expect((screen.getByRole("button", { name: t("aiSchemaDocCopy") }) as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: "# T" });
      handlers?.onDone?.({} as never);
    });
    const copyBtn = await screen.findByRole("button", { name: t("aiSchemaDocCopy") });
    await waitFor(() => expect((copyBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(copyBtn);
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
    const copied = vi.mocked(copyToClipboard).mock.calls[0][0];
    expect(copied).toContain("AI-generated inferences");
    expect(copied).toContain("# T");

    fireEvent.click(screen.getByRole("button", { name: t("aiSchemaDocSave") }));
    await waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
    expect(writeTextFile.mock.calls[0][0]).toBe("/dl/out.md");
    expect(writeTextFile.mock.calls[0][1]).toBe(copied);
    expect(save.mock.calls[0][0].filters[0].extensions).toContain("md");
  });

  it("保存ダイアログをキャンセルしたら書き込まない", async () => {
    save.mockResolvedValue(null);
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onDone?.({} as never));
    const saveBtn = await screen.findByRole("button", { name: t("aiSchemaDocSave") });
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveBtn);
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("選択テーブルを初期スコープにし、参照先を含めて送る", async () => {
    renderWithProviders(ui({ initialTables: ["orders"] }));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    const sys = runAiRequest.mock.calls[0][0].system as string;
    expect(sys).toContain("### orders");
    expect(sys).toContain("### customers");
    expect(sys).not.toContain("### logs");
    expect(sys).not.toContain("### v_sales");
  });

  it("選択モードで 0 件なら生成できない", async () => {
    renderWithProviders(ui());
    const radio = await screen.findByLabelText(t("aiSchemaDocScopeSelected"));
    fireEvent.click(radio);
    const btn = screen.getByRole("button", { name: t("aiSchemaDocGenerate" )}) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(t("aiSchemaDocNoSelection"))).toBeTruthy();
  });

  it("中止でき、アンマウント時は実行中ストリームを cancelStream する", async () => {
    const { unmount } = renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t("aiSchemaDocCancel") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("aiSchemaDocCancelled"));
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    unmount();
    expect(cancelStream).toHaveBeenCalledTimes(2);
  });

  it("エラーはメッセージを表示する", async () => {
    renderWithProviders(ui());
    await generate();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalled());
    act(() => handlers?.onError?.({ streamId: "x", error: "boom", kind: "aiRequest" } as never));
    await screen.findByText(t("aiSchemaDocError", { message: "boom" }));
  });
});
