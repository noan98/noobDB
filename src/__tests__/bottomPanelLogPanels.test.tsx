import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../components/clipboard";
import { act, fireEvent, renderHook, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { OutputPanel } from "../components/OutputPanel";
import { ActivityLogPanel } from "../components/SeverityLog";
import { __resetOutputLog, OUTPUT_ERROR_MAX_CHARS, pushOutput, useOutputLog } from "../outputLog";
import { __resetMessageLog, pushMessage } from "../messageLog";
import { __resetActivityLog, getActivityState, pushActivity } from "../activityLog";

/**
 * Bottom Panel のログ系タブ (#1114) の描画。3 タブとも「ツールバー (フィルタ +
 * クリア) → 一覧」の同じ骨格で、見出しと閉じるボタンは持たない (タブバーが持つ)。
 */

vi.mock("../components/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/clipboard")>();
  return { ...actual, copyToClipboard: vi.fn() };
});

afterEach(() => {
  vi.mocked(copyToClipboard).mockReset();
  __resetOutputLog();
  __resetMessageLog();
  __resetActivityLog();
});

const run = (over: Partial<Parameters<typeof pushOutput>[0]> = {}) =>
  pushOutput({
    sql: "select * from users",
    outcome: "rows",
    rows: 3,
    elapsedMs: 12,
    error: null,
    connection: "local",
    connectionId: "p-local",
    database: "app",
    execDatabase: "app",
    ...over,
  });

describe("OutputPanel", () => {
  it("失敗した行はエラー行へ移動でき、行番号が無ければ文の先頭へ (#1627)", () => {
    run({
      sql: "SELECT 1\nFORM t",
      outcome: "error",
      rows: null,
      elapsedMs: null,
      error: "x\nLINE 2: FORM t",
    });
    run({ sql: "bad", outcome: "error", rows: null, elapsedMs: null, error: "near x" });
    run({ sql: "ok", outcome: "rows" });
    const onGotoError = vi.fn();
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} onGotoError={onGotoError} />);
    const rows = screen.getAllByRole("button", { expanded: false });
    // 新しい順: ok / bad / FORM。成功行には出ない。
    fireEvent.click(rows[2]);
    fireEvent.click(screen.getByRole("button", { name: t("outputGotoErrorLine", { line: 2 }) }));
    expect(onGotoError).toHaveBeenCalledWith("SELECT 1\nFORM t", 2);
    fireEvent.click(rows[1]);
    fireEvent.click(screen.getByRole("button", { name: t("outputGotoStatement") }));
    expect(onGotoError).toHaveBeenLastCalledWith("bad", null);
  });

  it("空のときは説明付きの空状態を出す", () => {
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    expect(screen.getByText(t("outputEmptyTitle"))).toBeInTheDocument();
  });

  it("実行した文を新しい順に並べ、結末を要約する", () => {
    run();
    run({ sql: "delete from t", outcome: "affected", rows: 2, elapsedMs: 4 });
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    const list = screen.getByRole("list", { name: t("outputListAria") });
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("delete from t");
    expect(items[0].textContent).toContain(t("outputSummaryAffected", { rows: 2, ms: 4 }));
    expect(items[1].textContent).toContain(t("outputSummaryRows", { rows: 3, ms: 12 }));
  });

  it("「問題あり」でエラー等だけに絞り込む", () => {
    run();
    run({ sql: "selec 1", outcome: "error", rows: null, elapsedMs: null, error: "syntax error\nat line 1" });
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("outputFilterProblems")) }));
    const items = screen.getByRole("list", { name: t("outputListAria") }).querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain(t("outputSummaryError", { error: "syntax error" }));
  });

  it("行を展開すると全文とエラー本文が出て、新しいタブで開ける", () => {
    run({ sql: "selec 1", outcome: "error", rows: null, elapsedMs: null, error: "syntax error\nat line 1" });
    const onOpenSql = vi.fn();
    renderWithProviders(<OutputPanel onOpenSql={onOpenSql} />);
    const row = screen.getByRole("button", { expanded: false });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/at line 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("outputOpenInEditor") }));
    expect(onOpenSql).toHaveBeenCalledWith("selec 1");
  });

  it("行の「エディタへ挿入」「再実行」は接続中だけ押せ、全文の SQL を渡す (#1541)", () => {
    run({ sql: "update t set a = 1 where id = 2", outcome: "affected", rows: 1 });
    const onInsertSql = vi.fn();
    const onRunSql = vi.fn();
    const { unmount } = renderWithProviders(
      <OutputPanel
        onOpenSql={vi.fn()}
        onInsertSql={onInsertSql}
        onRunSql={onRunSql}
        canRun={false}
        currentConnectionId="p-local"
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    // 未接続でも挿入は使える (再実行だけ接続が要る)。
    expect(screen.getByRole("button", { name: t("outputInsertInEditor") })).toBeEnabled();
    expect(screen.getByRole("button", { name: t("outputRerun") })).toBeDisabled();
    unmount();
    renderWithProviders(
      <OutputPanel
        onOpenSql={vi.fn()}
        onInsertSql={onInsertSql}
        onRunSql={onRunSql}
        canRun
        currentConnectionId="p-local"
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: t("outputInsertInEditor") }));
    fireEvent.click(screen.getByRole("button", { name: t("outputRerun") }));
    expect(onInsertSql).toHaveBeenCalledWith("update t set a = 1 where id = 2");
    expect(onRunSql).toHaveBeenCalledWith("update t set a = 1 where id = 2", "app");
  });

  it("記録時と別の接続では再実行を無効にする (挿入は可)。同じ接続名なら有効 (#1541)", () => {
    run({ sql: "delete from t", outcome: "affected", rows: 1, connection: "local", connectionId: "p-prod" });
    const onRunSql = vi.fn();
    renderWithProviders(
      <OutputPanel
        onOpenSql={vi.fn()}
        onInsertSql={vi.fn()}
        onRunSql={onRunSql}
        canRun
        currentConnectionId="p-local"
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { name: t("outputRerun") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("outputInsertInEditor") })).toBeEnabled();
  });

  it("接続 id を持たない行 (記録できなかった行) は表示名が同じでも再実行できない (#1541)", () => {
    run({ connectionId: null });
    renderWithProviders(
      <OutputPanel onOpenSql={vi.fn()} onRunSql={vi.fn()} canRun currentConnectionId="p-local" />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { name: t("outputRerun") })).toBeDisabled();
  });

  it("再実行には実行 DB (execDatabase) を渡し、表示用の既定 DB は渡さない (#1541)", () => {
    run({ database: "testdb", execDatabase: null });
    const onRunSql = vi.fn();
    renderWithProviders(
      <OutputPanel onOpenSql={vi.fn()} onRunSql={onRunSql} canRun currentConnectionId="p-local" />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: t("outputRerun") }));
    expect(onRunSql).toHaveBeenCalledWith("select * from users", null);
  });

  it("コールバックを渡さなければ挿入・再実行ボタンは出さない (#1541)", () => {
    run();
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByRole("button", { name: t("outputRerun") })).toBeNull();
  });

  it("SQL のコピーに失敗したらエラーを知らせる (#1534)", async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(false);
    run();
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: t("outputCopySql") }));
    expect(await screen.findByText(t("outputCopyFailed"))).toBeInTheDocument();
  });

  it("予算を超えて切り詰められた行は、保持範囲を注記する (#1534)", () => {
    run({ sql: `select '${"x".repeat(1_200_000)}'` });
    run({ sql: "select 2" });
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    // 古い方 (2 行目) だけが先頭に切り詰められる。
    const rows = screen.getAllByRole("button", { expanded: false });
    fireEvent.click(rows[1]);
    expect(screen.getByText(/4000/)).toBeInTheDocument();
    // 切り詰めた断片は、実行できる状態でエディタに開かせない。
    expect(screen.getByRole("button", { name: t("outputOpenInEditor") })).toBeDisabled();
  });

  it("クリアで空になる", () => {
    run();
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("activityClear") }));
    expect(screen.getByText(t("outputEmptyTitle"))).toBeInTheDocument();
  });
});

describe("ActivityLogPanel (ステータスメッセージの統合)", () => {
  it("ステータスの履歴もアクティビティに並べ、畳んだ回数を添える", () => {
    pushMessage("error", "boom", "text:boom");
    pushMessage("success", "10 rows", "key:statusStreamingDone");
    pushMessage("success", "12 rows", "key:statusStreamingDone");
    renderWithProviders(<ActivityLogPanel />);
    const items = screen.getByRole("list", { name: t("activityListAria") }).querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("12 rows");
    expect(items[0].textContent).toContain(t("messagesRepeat", { count: 2 }));
    expect(items[1].textContent).toContain("boom");
  });

  it("重大度チップで絞り込める", () => {
    pushMessage("error", "boom", "text:boom");
    pushMessage("success", "ok", "key:x");
    renderWithProviders(<ActivityLogPanel />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${t("activitySeverityError")}`) }));
    const items = screen.getByRole("list", { name: t("activityListAria") }).querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("boom");
  });

  it("トーストと同じ文言のステータスメッセージは 1 行にまとめる", () => {
    pushActivity("success", "Connected to local");
    pushMessage("success", "Connected to local", "text:Connected to local");
    renderWithProviders(<ActivityLogPanel />);
    const items = screen.getByRole("list", { name: t("activityListAria") }).querySelectorAll("li");
    expect(items).toHaveLength(1);
  });

  it("クリアでトーストとメッセージの両方を消す", () => {
    pushActivity("success", "a");
    pushMessage("error", "b", "text:b");
    renderWithProviders(<ActivityLogPanel />);
    fireEvent.click(screen.getByRole("button", { name: t("activityClear") }));
    expect(screen.getByText(t("activityEmptyTitle"))).toBeInTheDocument();
  });
});

describe("ActivityLogPanel (詳細の展開)", () => {
  it("スキーマ変更はテーブルごとの列/インデックスの増減を表で見られる", () => {
    pushActivity("warning", "schema changed", {
      kind: "schemaDrift",
      summary: {
        tables: [
          {
            table: "orders",
            tableStatus: "changed",
            columnsAdded: 1,
            columnsRemoved: 0,
            columnsChanged: 0,
            indexesAdded: 1,
            indexesRemoved: 0,
            indexesChanged: 0,
            addedColumns: ["total"],
            addedIndexes: ["ix_total"],
          },
          {
            table: "audit",
            tableStatus: "added",
            columnsAdded: 0,
            columnsRemoved: 0,
            columnsChanged: 0,
            indexesAdded: 0,
            indexesRemoved: 0,
            indexesChanged: 0,
          },
        ],
      },
    });
    renderWithProviders(<ActivityLogPanel />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("activityShowDetail")) }));
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("orders");
    expect(table.textContent).toContain("total");
    expect(table.textContent).toContain("ix_total");
    expect(table.textContent).toContain(t("schemaDriftTableAddedLabel"));
  });
});

describe("ActivityLogPanel", () => {
  it("トーストの履歴をパネルで読み、表示中は既読にする (ベルの未読が消える)", () => {
    pushActivity("success", "imported 10 rows");
    renderWithProviders(<ActivityLogPanel />);
    expect(screen.getByText("imported 10 rows")).toBeInTheDocument();
    expect(getActivityState().lastReadId).toBe(getActivityState().entries[0].id);
    // 開いている間に届いたものも既読になる。
    act(() => pushActivity("warning", "later"));
    expect(screen.getByText("later")).toBeInTheDocument();
    expect(getActivityState().lastReadId).toBe(getActivityState().entries[0].id);
  });
});

describe("pushOutput の保持量 (#1534)", () => {
  it("元の SQL の長さを記録し、エラー本文も上限で切る", () => {
    run({ sql: "select 1", outcome: "error", error: "e".repeat(OUTPUT_ERROR_MAX_CHARS + 5) });
    const { result } = renderHook(() => useOutputLog());
    expect(result.current[0].sqlLength).toBe(8);
    expect(result.current[0].error).toHaveLength(OUTPUT_ERROR_MAX_CHARS);
  });
});
