import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { Assertion, AssertionOutcome } from "../api/tauri";

/**
 * データ品質アサーション パネルの #1621 の拡張: 削除の取り消し・JSON の書き出し / 取り込み・
 * 前回比の表示。IPC (`api`) とファイルダイアログはモックし、画面の配線だけを固定する
 * (ごみ箱・取り込みの規則そのものは Rust 側の単体テストが固定している)。
 */
const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: () => Promise.resolve("/dl"),
  join: (...p: string[]) => Promise.resolve(p.join("/")),
}));
vi.mock("../ai/useAiAvailable", () => ({ useAiAvailable: () => false }));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listAssertions: vi.fn(),
      deleteAssertion: vi.fn(),
      restoreAssertion: vi.fn(),
      exportAssertions: vi.fn(),
      importAssertions: vi.fn(),
      writeTextFile: vi.fn(),
      readTextFile: vi.fn(),
      runAssertion: vi.fn(),
    },
  };
});

import { AssertionsPanel } from "../components/AssertionsPanel";
import { api } from "../api/tauri";

const a1: Assertion = {
  id: "aaaaaaaa",
  name: "メール必須",
  scope: { kind: "any" },
  schema: null,
  table: "users",
  rule: { kind: "not_null", column: "email" },
};

function renderPanel() {
  return renderWithProviders(
    <AssertionsPanel
      sessionId="s1"
      driver="mysql"
      profile={{ id: "p1", group: null } as never}
      database="app"
      queryTimeoutSecs={0}
      onOpenSql={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listAssertions).mockResolvedValue([a1]);
});

describe("AssertionsPanel 削除の取り消し (#1621)", () => {
  it("削除するとトーストに「元に戻す」が出て、押すと一覧へ戻る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteAssertion).mockResolvedValue(undefined);
    vi.mocked(api.restoreAssertion).mockResolvedValue(a1);
    renderPanel();
    await screen.findByText("メール必須");

    await user.click(screen.getByRole("button", { name: t("assertDelete") }));
    // 確認ダイアログが開くと背面は aria-hidden になるので、見えているボタンはダイアログ側だけ。
    await user.click(await screen.findByRole("button", { name: t("assertDelete") }));
    await waitFor(() => expect(api.deleteAssertion).toHaveBeenCalledWith("aaaaaaaa"));
    await waitFor(() => expect(screen.queryByText("メール必須")).not.toBeInTheDocument());

    await user.click(await screen.findByRole("button", { name: t("assertUndoDelete") }));
    await waitFor(() => expect(api.restoreAssertion).toHaveBeenCalledWith("aaaaaaaa"));
    expect(await screen.findByText("メール必須")).toBeInTheDocument();
  });
});

describe("AssertionsPanel 書き出し / 取り込み (#1621)", () => {
  it("書き出しは表示中の ID だけを渡し、選んだパスへ JSON を書く", async () => {
    const user = userEvent.setup();
    mocks.save.mockResolvedValue("/dl/out.json");
    vi.mocked(api.exportAssertions).mockResolvedValue('{"assertions":[]}');
    vi.mocked(api.writeTextFile).mockResolvedValue(10);
    renderPanel();
    await screen.findByText("メール必須");

    await user.click(screen.getByRole("button", { name: t("assertExport") }));
    await waitFor(() => expect(api.writeTextFile).toHaveBeenCalledWith("/dl/out.json", '{"assertions":[]}'));
    expect(api.exportAssertions).toHaveBeenCalledWith(["aaaaaaaa"]);
  });

  it("取り込みは接続中のプロファイル ID を渡し、追加分を一覧へ足す", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("/dl/in.json");
    vi.mocked(api.readTextFile).mockResolvedValue("{}");
    const b: Assertion = { ...a1, id: "bbbbbbbb", name: "取り込み済み" };
    vi.mocked(api.importAssertions).mockResolvedValue({
      imported: [b],
      skipped_duplicates: 1,
      rejected: [{ index: 3, name: "壊れた", error: "name is required" }],
    });
    renderPanel();
    await screen.findByText("メール必須");

    await user.click(screen.getByRole("button", { name: t("assertImport") }));
    expect(await screen.findByText("取り込み済み")).toBeInTheDocument();
    expect(api.importAssertions).toHaveBeenCalledWith("{}", "p1");
    expect(await screen.findByText(/壊れた: name is required/)).toBeInTheDocument();
  });
});

describe("AssertionsPanel 前回比 (#1621)", () => {
  it("違反件数が増えたら前回との差を悪化色で出す", async () => {
    const user = userEvent.setup();
    const outcome: AssertionOutcome = {
      id: "aaaaaaaa",
      passed: false,
      observed: 12,
      check_sql: "SELECT 1",
      violations_sql: "SELECT * FROM users",
      elapsed_ms: 3,
      previous: { at: "2026-01-01T00:00:00Z", observed: 3, passed: false },
    };
    vi.mocked(api.runAssertion).mockResolvedValue(outcome);
    renderPanel();
    await screen.findByText("メール必須");

    await user.click(screen.getByRole("button", { name: t("assertRunOne") }));
    const change = await screen.findByTestId("assertion-change");
    expect(change).toHaveTextContent("3");
    expect(change).toHaveTextContent("12");
    expect(change).toHaveTextContent("+9");
  });
});
