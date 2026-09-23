import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { OutputPanel } from "../components/OutputPanel";
import { ActivityLogPanel, MessagesPanel } from "../components/SeverityLog";
import { __resetOutputLog, pushOutput } from "../outputLog";
import { __resetMessageLog, pushMessage } from "../messageLog";
import { __resetActivityLog, getActivityState, pushActivity } from "../activityLog";

/**
 * Bottom Panel のログ系タブ (#1114) の描画。3 タブとも「ツールバー (フィルタ +
 * クリア) → 一覧」の同じ骨格で、見出しと閉じるボタンは持たない (タブバーが持つ)。
 */

afterEach(() => {
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
    database: "app",
    ...over,
  });

describe("OutputPanel", () => {
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

  it("クリアで空になる", () => {
    run();
    renderWithProviders(<OutputPanel onOpenSql={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("activityClear") }));
    expect(screen.getByText(t("outputEmptyTitle"))).toBeInTheDocument();
  });
});

describe("MessagesPanel", () => {
  it("ステータスの履歴を並べ、畳んだ回数を添える", () => {
    pushMessage("error", "boom", "text:boom");
    pushMessage("success", "10 rows", "key:statusStreamingDone");
    pushMessage("success", "12 rows", "key:statusStreamingDone");
    renderWithProviders(<MessagesPanel />);
    const items = screen.getByRole("list", { name: t("messagesListAria") }).querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("12 rows");
    expect(items[0].textContent).toContain(t("messagesRepeat", { count: 2 }));
    expect(items[1].textContent).toContain("boom");
  });

  it("重大度チップで絞り込める", () => {
    pushMessage("error", "boom", "text:boom");
    pushMessage("success", "ok", "key:x");
    renderWithProviders(<MessagesPanel />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${t("activitySeverityError")}`) }));
    const items = screen.getByRole("list", { name: t("messagesListAria") }).querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("boom");
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
