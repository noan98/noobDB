import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const runAiRequest = vi.fn().mockResolvedValue(undefined);
const listTables = vi.fn();
const describeTable = vi.fn();
const foreignKeys = vi.fn();
const saveAssertion = vi.fn();
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
      runAiRequest: (...a: unknown[]) => runAiRequest(...a),
      listTables: (...a: unknown[]) => listTables(...a),
      describeTable: (...a: unknown[]) => describeTable(...a),
      foreignKeys: (...a: unknown[]) => foreignKeys(...a),
      saveAssertion: (...a: unknown[]) => saveAssertion(...a),
      cancelStream: (...a: unknown[]) => cancelStream(...a),
      listAssertions: vi.fn().mockResolvedValue([]),
    },
  };
});

import { AssertionSuggestModal, MAX_SUGGEST_TABLES } from "../components/AssertionSuggestModal";
import { AssertionsPanel } from "../components/AssertionsPanel";
import { resetAiKeyStoreForTest, setAiKeyPresent } from "../ai/aiKeyStore";
import { DEFAULT_SETTINGS, replaceAllSettings } from "../settings";

const onRegistered = vi.fn();
const onClose = vi.fn();
const profile = { id: "p1", group: null, is_production: false };

function enable(over: Partial<typeof DEFAULT_SETTINGS.ai> = {}) {
  replaceAllSettings({
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, enabled: true, consentGiven: true, sendScope: "schemaAndSql", ...over },
  });
}

function ui(over: Partial<React.ComponentProps<typeof AssertionSuggestModal>> = {}) {
  return (
    <AssertionSuggestModal
      sessionId="s1"
      driver="postgres"
      database="app"
      profile={profile}
      onRegistered={onRegistered}
      onClose={onClose}
      {...over}
    />
  );
}

const result = JSON.stringify({
  suggestions: [
    { name: "金額は負でない", description: "amount が負の行", sql: "SELECT * FROM orders WHERE amount < 0" },
    { name: "危険な候補", description: "書き込み", sql: "DELETE FROM orders" },
  ],
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  handlers = null;
  resetAiKeyStoreForTest();
  listTables.mockResolvedValue(["orders", "users"]);
  describeTable.mockResolvedValue([
    {
      name: "id",
      data_type: "int",
      nullable: false,
      key: "PRI",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
    {
      name: "amount",
      data_type: "numeric",
      nullable: true,
      key: "",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
      comment: "金額",
    },
  ]);
  foreignKeys.mockResolvedValue([]);
  saveAssertion.mockImplementation(async (req) => ({ id: `id_${req.name}`, ...req }));
  enable();
});

/** テーブルのチップ (aria-pressed のトグル) を押して選ぶ。 */
async function pick(...names: string[]) {
  for (const name of names) {
    const chip = (await screen.findByRole("button", { name })) as HTMLButtonElement;
    await waitFor(() => expect(chip.disabled).toBe(false));
    fireEvent.click(chip);
  }
}

async function generate() {
  await pick("orders");
  const btn = screen.getByRole("button", { name: t("assertAiGenerate") });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
}

async function deliver() {
  act(() => {
    handlers?.onDelta?.({ streamId: "x", text: result });
    handlers?.onDone?.({} as never);
  });
  await screen.findAllByTestId("assertion-suggestion");
}

describe("AssertionSuggestModal (#1477)", () => {
  it("assertionSuggest タスクでスキーマ情報だけを送り、方言名と仕様を指示する", async () => {
    renderWithProviders(ui());
    await generate();
    const req = runAiRequest.mock.calls[0][0];
    expect(req.task).toBe("assertionSuggest");
    expect(req.systemCached).toContain("PostgreSQL");
    expect(req.systemCached).toContain("- amount numeric | NULL | comment: 金額");
    expect(req.systemCached).toContain("VIOLATING rows");
    expect(req.format.type).toBe("json_schema");
    expect(describeTable).toHaveBeenCalledWith("s1", "app", "orders");
  });

  it("本番接続のときだけ送信前に確認し、拒否すれば要求しない", async () => {
    enable({ sendScope: "schemaOnly" });
    renderWithProviders(ui({ profile: { ...profile, is_production: true } }));
    await pick("orders");
    fireEvent.click(screen.getByRole("button", { name: t("assertAiGenerate") }));
    await screen.findByText(t("assertAiConfirmTitle"));
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await act(async () => {});
    expect(runAiRequest).not.toHaveBeenCalled();
  });

  it("読み取り専用でない候補は登録できず、通る候補だけ一括登録する", async () => {
    renderWithProviders(ui());
    await generate();
    await deliver();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // 通る候補は初期選択、通らない候補は無効で未選択。
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].disabled).toBe(true);
    expect(screen.getByText(t("assertAiNotReadOnly"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("assertAiRegister", { count: 1 }) }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saveAssertion).toHaveBeenCalledTimes(1);
    expect(saveAssertion.mock.calls[0][0]).toMatchObject({
      name: "金額は負でない",
      table: "orders",
      scope: { kind: "profile", profile_id: "p1" },
      rule: { kind: "custom_sql", sql: "SELECT * FROM orders WHERE amount < 0" },
    });
    expect(onRegistered).toHaveBeenCalledTimes(1);
  });

  it("SQL を書き込み文に編集すると選択が外れ、登録できなくなる", async () => {
    renderWithProviders(ui());
    await generate();
    await deliver();
    const sqls = screen.getAllByLabelText(t("assertAiSqlLabel"));
    fireEvent.change(sqls[0], { target: { value: "UPDATE orders SET amount = 0" } });
    const register = screen.getByRole("button", { name: t("assertAiRegister", { count: 0 }) });
    expect((register as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(register);
    expect(saveAssertion).not.toHaveBeenCalled();
    // 書き込み文だった候補を SELECT に直すと登録できる。
    fireEvent.change(sqls[1], { target: { value: "SELECT * FROM orders WHERE id < 0" } });
    const box = screen.getAllByRole("checkbox")[1] as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: t("assertAiRegister", { count: 1 }) }));
    await waitFor(() => expect(saveAssertion).toHaveBeenCalledTimes(1));
    expect(saveAssertion.mock.calls[0][0].rule.sql).toBe("SELECT * FROM orders WHERE id < 0");
  });

  it("保存に失敗した候補は残り、成功分だけ通知する", async () => {
    saveAssertion.mockImplementation(async (req) => {
      if (req.name === "金額は負でない") throw new Error("boom");
      return { id: "x", ...req };
    });
    renderWithProviders(ui());
    await generate();
    await deliver();
    fireEvent.change(screen.getAllByLabelText(t("assertAiSqlLabel"))[1], {
      target: { value: "SELECT 1" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: t("assertAiRegister", { count: 2 }) }));
    await screen.findByText(/boom/);
    expect(onClose).not.toHaveBeenCalled();
    expect(onRegistered).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("assertion-suggestion")).toHaveLength(1);
  });

  it("複数テーブルを選ぶと順に要求し、候補をテーブルごとに区切って表示する (#1621)", async () => {
    renderWithProviders(ui());
    await pick("orders", "users");
    expect(screen.getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual([
      "orders",
      "users",
    ]);
    fireEvent.click(screen.getByRole("button", { name: t("assertAiGenerate") }));
    // テーブルごとの「送る内容」を 1 行ずつ出す。
    await screen.findByText(/the schema of orders/);
    expect(screen.getByText(/the schema of users/)).toBeTruthy();
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    expect(runAiRequest.mock.calls[0][0].prompt).toContain("orders");
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    // 1 テーブル目が終わったら、続けて 2 テーブル目を要求する。
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    expect(runAiRequest.mock.calls[1][0].prompt).toContain("users");
    expect(describeTable).toHaveBeenCalledWith("s1", "app", "users");
    act(() => {
      handlers?.onDelta?.({ streamId: "y", text: result });
      handlers?.onDone?.({} as never);
    });
    await waitFor(() => expect(screen.getAllByTestId("assertion-suggestion")).toHaveLength(4));
    const groups = screen.getAllByTestId("assertion-suggest-group").map((g) => g.textContent);
    expect(groups).toEqual(["orders (2)", "users (2)"]);

    // 登録時は候補ごとに元のテーブルが使われる。
    fireEvent.click(screen.getByRole("button", { name: t("assertAiRegister", { count: 2 }) }));
    await waitFor(() => expect(saveAssertion).toHaveBeenCalledTimes(2));
    expect(saveAssertion.mock.calls.map((c) => c[0].table)).toEqual(["orders", "users"]);
  });

  it("2 テーブル目で失敗しても、1 テーブル目の候補は残りテーブル名つきで通知する (#1621)", async () => {
    renderWithProviders(ui());
    await pick("orders", "users");
    fireEvent.click(screen.getByRole("button", { name: t("assertAiGenerate") }));
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(1));
    act(() => {
      handlers?.onDelta?.({ streamId: "x", text: result });
      handlers?.onDone?.({} as never);
    });
    await waitFor(() => expect(runAiRequest).toHaveBeenCalledTimes(2));
    act(() => handlers?.onError?.({ streamId: "y", error: "overloaded", kind: "aiOverloaded" } as never));
    await screen.findByText(/users: overloaded/);
    expect(screen.getAllByTestId("assertion-suggestion")).toHaveLength(2);
  });

  it("選べるテーブルは上限までで、超える分は選べない (#1621)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    listTables.mockResolvedValue(many);
    renderWithProviders(ui());
    await pick(...many.slice(0, MAX_SUGGEST_TABLES));
    const extra = screen.getByRole("button", { name: "t10" }) as HTMLButtonElement;
    expect(extra.disabled).toBe(true);
    expect(screen.getByText(t("assertAiTableLimit", { count: MAX_SUGGEST_TABLES }))).toBeTruthy();
  });

  it("実行中は中止でき、中止の表示になる", async () => {
    renderWithProviders(ui());
    await generate();
    fireEvent.click(screen.getByRole("button", { name: t("assertAiStop") }));
    expect(cancelStream).toHaveBeenCalledTimes(1);
    act(() => handlers?.onCancelled?.({} as never));
    await screen.findByText(t("assertAiCancelled"));
  });
});

describe("AssertionsPanel の入口", () => {
  const panel = () =>
    renderWithProviders(
      <AssertionsPanel
        sessionId="s1"
        driver="postgres"
        profile={null}
        database="app"
        queryTimeoutSecs={0}
        onOpenSql={() => {}}
      />,
    );

  it("AI 無効 / キー未設定なら入口を出さない", async () => {
    enable({ enabled: false });
    setAiKeyPresent(true);
    panel();
    await screen.findByText(t("assertEmptyTitle"));
    expect(screen.queryByRole("button", { name: t("assertAiButton") })).toBeNull();
    cleanup();
    enable();
    setAiKeyPresent(false);
    panel();
    await screen.findByText(t("assertEmptyTitle"));
    expect(screen.queryByRole("button", { name: t("assertAiButton") })).toBeNull();
  });

  it("AI 有効 + キー登録済みなら入口からモーダルを開ける", async () => {
    enable();
    setAiKeyPresent(true);
    panel();
    fireEvent.click(await screen.findByRole("button", { name: t("assertAiButton") }));
    await screen.findByTestId("assertion-suggest-modal");
  });
});
