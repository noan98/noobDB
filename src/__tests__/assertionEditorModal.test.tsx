import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import { emptyAssertionDraft } from "../components/assertions";

/**
 * アサーション編集モーダルの #1621 拡張: accepted_values の候補を実データの DISTINCT から
 * 取得して入れる / 保存前に違反件数を数える。IPC はモックし、画面の配線だけを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      previewAssertionSql: vi.fn(),
      suggestAcceptedValues: vi.fn(),
      runLookupQuery: vi.fn(),
    },
  };
});

import { AssertionEditorModal } from "../components/AssertionEditorModal";
import { api } from "../api/tauri";

function renderModal(patch: Partial<ReturnType<typeof emptyAssertionDraft>> = {}) {
  return renderWithProviders(
    <AssertionEditorModal
      initial={{ ...emptyAssertionDraft({ table: "users" }), name: "n", column: "status", ...patch }}
      sessionId="s1"
      database="app"
      queryTimeoutSecs={0}
      driver="mysql"
      profile={null}
      onSave={async () => {}}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.previewAssertionSql).mockResolvedValue({
    check_sql: "SELECT COUNT(*) AS observed FROM `users` WHERE `status` IS NULL",
    violations_sql: "SELECT * FROM `users` WHERE `status` IS NULL",
  });
});

describe("AssertionEditorModal (#1621)", () => {
  it("実データから取得すると許可値の欄に DISTINCT 値が入る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.suggestAcceptedValues).mockResolvedValue({
      values: ["active", "closed"],
      truncated: false,
    });
    renderModal({ kind: "accepted_values" });

    await user.click(await screen.findByRole("button", { name: t("assertFetchValues") }));
    await waitFor(() =>
      expect(api.suggestAcceptedValues).toHaveBeenCalledWith({
        sessionId: "s1",
        schema: null,
        table: "users",
        column: "status",
        database: "app",
        queryTimeoutSecs: null,
      }),
    );
    expect(await screen.findByLabelText(t("assertFieldValues"))).toHaveValue("active\nclosed");
    expect(await screen.findByText(t("assertFetchValuesDone", { count: 2 }))).toBeInTheDocument();
  });

  it("打ち切られたときは件数つきの注意を出す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.suggestAcceptedValues).mockResolvedValue({
      values: Array.from({ length: 50 }, (_, i) => `v${i}`),
      truncated: true,
    });
    renderModal({ kind: "accepted_values" });
    await user.click(await screen.findByRole("button", { name: t("assertFetchValues") }));
    expect(await screen.findByText(t("assertFetchValuesTruncated", { count: 50 }))).toBeInTheDocument();
  });

  it("取得に失敗したらエラーを出し、許可値は触らない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.suggestAcceptedValues).mockRejectedValue(new Error("boom"));
    renderModal({ kind: "accepted_values", values: "keep" });
    await user.click(await screen.findByRole("button", { name: t("assertFetchValues") }));
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.getByLabelText(t("assertFieldValues"))).toHaveValue("keep");
  });

  it("プレビューができたら保存前に違反件数を数えられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.runLookupQuery).mockResolvedValue({
      columns: [{ name: "c", data_type: "int" }],
      rows: [[4]],
      rows_affected: 0,
      elapsed_ms: 1,
    } as never);
    renderModal({ kind: "not_null" });

    await user.click(await screen.findByRole("button", { name: t("sqlCheckViolationsButton") }));
    expect(await screen.findByText(t("sqlCheckViolations", { count: "4" }))).toBeInTheDocument();
    expect(api.runLookupQuery).toHaveBeenCalled();
  });

  it("row_count ルールでは違反件数の確認を出さない", async () => {
    renderModal({ kind: "row_count" });
    await waitFor(() => expect(api.previewAssertionSql).toHaveBeenCalled());
    expect(screen.queryByTestId("sql-count-check")).not.toBeInTheDocument();
  });
});
