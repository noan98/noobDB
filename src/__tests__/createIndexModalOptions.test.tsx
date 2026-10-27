import { describe, it, expect, vi } from "vitest";
import { t } from "../i18n";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";

/** CreateIndexModal の詳細オプション (#1892)。方言ごとの有効/無効とプレビュー SQL を確認する。 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const col = (name: string) => ({
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn().mockResolvedValue([col("a"), col("b")]),
      checkDuplicateIndex: vi.fn().mockResolvedValue([]),
    },
  };
});

import { CreateIndexModal } from "../components/CreateIndexModal";
import { api, type DriverKind } from "../api/tauri";

function open(driver: DriverKind) {
  renderWithProviders(
    <CreateIndexModal
      sessionId="s1"
      driver={driver}
      database="db"
      table="t"
      readOnly={false}
      onRun={() => {}}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("CreateIndexModal 詳細オプション (#1892)", () => {
  it("PostgreSQL: メソッド / WHERE / INCLUDE がプレビューに反映される", async () => {
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    fireEvent.change(screen.getByLabelText(/WHERE/), { target: { value: "a > 0" } });
    fireEvent.click(screen.getByLabelText(/Include b|b を INCLUDE/));
    await waitFor(() => expect(document.body.textContent).toContain('INCLUDE ("b") WHERE a > 0;'));
    fireEvent.change(screen.getByLabelText(/メソッド|Method/), { target: { value: "gin" } });
    await waitFor(() => expect(document.body.textContent).toContain('USING gin ("a") WHERE a > 0;'));
    expect(document.body.textContent).not.toContain(`INCLUDE ("b")`);
  });

  it("SQLite: メソッド / INCLUDE は無効で理由が出る。MySQL: WHERE が無効", async () => {
    open("sqlite");
    await screen.findByLabelText("a");
    expect(screen.getByTestId("create-index-reason-method")).toBeInTheDocument();
    expect(screen.getByTestId("create-index-reason-include")).toBeInTheDocument();
  });

  it("MySQL: WHERE 欄は無効", async () => {
    open("mysql");
    await screen.findByLabelText("a");
    expect(screen.getByLabelText(/WHERE/)).toBeDisabled();
    expect(screen.getByTestId("create-index-reason-where")).toBeInTheDocument();
  });

  it("メソッド・式・WHERE 指定時は重複チェックを呼ばない", async () => {
    vi.mocked(api.checkDuplicateIndex).mockClear();
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(api.checkDuplicateIndex).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/WHERE/), { target: { value: "a > 0" } });
    fireEvent.click(screen.getByLabelText("b"));
    await new Promise((r) => setTimeout(r, 30));
    // WHERE 指定後に b を選んでも再チェックしない
    expect(api.checkDuplicateIndex).toHaveBeenCalledTimes(1);
  });

  it("途中の ; で FieldError が出て実行が無効になる", async () => {
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    fireEvent.change(screen.getByLabelText(/WHERE/), { target: { value: "a > 0; DROP TABLE t" } });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: t("createIndexRun") })).toBeDisabled();
  });

  it("INCLUDE に選んだ列をキーにすると SQL から INCLUDE が消える", async () => {
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    fireEvent.click(screen.getByLabelText(/Include b|b を INCLUDE/));
    await waitFor(() => expect(document.body.textContent).toContain('INCLUDE ("b")'));
    fireEvent.click(screen.getByLabelText("b"));
    await waitFor(() => expect(document.body.textContent).not.toContain('INCLUDE ("b")'));
  });

  it("PG hash は 1 列のみ: 2 列目を無効化して理由を出す。MySQL HASH は注記", async () => {
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    fireEvent.change(screen.getByLabelText(/メソッド|Method/), { target: { value: "hash" } });
    await waitFor(() => expect(screen.getByLabelText("b")).toBeDisabled());
    expect(screen.getByTestId("create-index-reason-columns")).toBeInTheDocument();
  });

  it("MySQL で HASH を選ぶと InnoDB の注記が出る", async () => {
    open("mysql");
    await screen.findByLabelText("a");
    fireEvent.change(screen.getByLabelText(/メソッド|Method/), { target: { value: "hash" } });
    await waitFor(() => expect(screen.getByTestId("create-index-note-hash")).toBeInTheDocument());
  });
});
