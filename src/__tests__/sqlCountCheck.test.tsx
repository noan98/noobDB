import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, runLookupQuery: vi.fn() } };
});

import { api } from "../api/tauri";
import { SqlCountCheck } from "../components/SqlCountCheck";

beforeEach(() => vi.mocked(api.runLookupQuery).mockReset());

describe("SqlCountCheck (#1536)", () => {
  it("押したときだけ COUNT を実行し、違反件数を表示する", async () => {
    vi.mocked(api.runLookupQuery).mockResolvedValue({ rows: [[7]] } as never);
    renderWithProviders(
      <SqlCountCheck sessionId="s1" database="db" driver="mysql" sql="SELECT * FROM t WHERE a < 0" mode="violations" />,
    );
    expect(api.runLookupQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("sqlCheckViolationsButton") }));
    await waitFor(() => expect(screen.getByText(t("sqlCheckViolations", { count: "7" }))).toBeInTheDocument());
    expect(vi.mocked(api.runLookupQuery).mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      database: "db",
      sql: "SELECT COUNT(*) FROM (\nSELECT * FROM t WHERE a < 0\n) AS suggestion_check",
    });
  });

  it("0 件は合格、実行エラー (架空の列名など) はエラー文言で示す", async () => {
    vi.mocked(api.runLookupQuery).mockResolvedValueOnce({ rows: [[0]] } as never);
    const { rerender } = renderWithProviders(
      <SqlCountCheck sessionId="s1" database={null} driver="postgres" sql="SELECT 1" mode="violations" />,
    );
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText(t("sqlCheckViolationsZero"));

    vi.mocked(api.runLookupQuery).mockRejectedValueOnce(new Error('column "nope" does not exist'));
    // SQL が変わると前の結果は捨てられる。
    rerender(<SqlCountCheck sessionId="s1" database={null} driver="postgres" sql="SELECT nope" mode="violations" />);
    expect(screen.queryByText(t("sqlCheckViolationsZero"))).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText(/does not exist/);
  });

  it("書き込み SQL ではボタンを出さない", () => {
    renderWithProviders(
      <SqlCountCheck sessionId="s1" database={null} driver="mysql" sql="DELETE FROM t" mode="rows" />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("MySQL の 1060 (列名の重複) は、重複の可能性を案内する", async () => {
    vi.mocked(api.runLookupQuery).mockRejectedValueOnce(
      new Error("error returned from database: 1060 (42S21): Duplicate column name 'id'"),
    );
    renderWithProviders(
      <SqlCountCheck sessionId="s1" database="db" driver="mysql" sql="SELECT a.id, b.id FROM a JOIN b" mode="rows" />,
    );
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText(new RegExp(t("sqlCheckDuplicateColumn").slice(0, 10)));
  });
});
