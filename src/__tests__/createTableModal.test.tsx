import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTables: vi.fn().mockResolvedValue(["users", "orders"]),
      describeTable: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { CreateTableModal } from "../components/CreateTableModal";
import { t } from "../i18n";

/**
 * CREATE TABLE ウィザード (#604)。マウント時に Tauri 呼び出しを持たない。
 * ダイアログとしてマウントでき、タイトルが可視であること・閉じるボタンで
 * `onClose` が呼ばれることを固定する。
 */
describe("CreateTableModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the create-table title", () => {
    renderWithProviders(
      <CreateTableModal
        driver="mysql"
        database="appdb"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("createTableTitle"))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CreateTableModal
        driver="postgres"
        database={null}
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={onClose}
      />,
    );
    // ヘッダとフッタの両方に「閉じる」ボタンがあるため、先頭 (ヘッダ) を叩く。
    fireEvent.click(screen.getAllByRole("button", { name: t("createTableClose") })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("CreateTableModal 既存テーブルからの雛形 (#1540)", () => {
  const colInfo = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  });

  function renderModal() {
    return renderWithProviders(
      <CreateTableModal
        sessionId="s1"
        driver="mysql"
        database="appdb"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
  }

  it("テーブルを選んで読み込むと列が置き換わり、プレビューへ反映される", async () => {
    vi.mocked(api.describeTable).mockResolvedValueOnce([
      colInfo("uid", { data_type: "bigint", nullable: false, key: "PRI", extra: "auto_increment" }),
      colInfo("nick", { data_type: "varchar(30)", default: "anon" }),
    ] as never);
    renderModal();
    const select = (await screen.findByLabelText(t("createTableTemplate"))) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option").length).toBe(3));
    const load = screen.getByRole("button", { name: t("createTableTemplateLoad") });
    expect(load).toBeDisabled();
    fireEvent.change(select, { target: { value: "users" } });
    fireEvent.click(load);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalledWith("s1", "appdb", "users"));
    expect(await screen.findByDisplayValue("uid")).toBeInTheDocument();
    expect(screen.getByDisplayValue("nick")).toBeInTheDocument();
    // テーブル名が空なら「<元>_copy」を提案する。
    expect(screen.getByLabelText(t("createTableName"))).toHaveValue("users_copy");
    expect(screen.getByText(/CREATE TABLE `appdb`\.`users_copy`/)).toBeInTheDocument();
  });

  it("読み込みに失敗したらエラーを出し、列は変えない", async () => {
    vi.mocked(api.describeTable).mockRejectedValueOnce(new Error("denied"));
    renderModal();
    const select = (await screen.findByLabelText(t("createTableTemplate"))) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option").length).toBe(3));
    fireEvent.change(select, { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: t("createTableTemplateLoad") }));
    expect(await screen.findByText(/denied/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("id")).toBeInTheDocument();
  });

  it("sessionId が無ければ雛形の選択欄は出ない", () => {
    renderWithProviders(
      <CreateTableModal
        driver="mysql"
        database="appdb"
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByLabelText(t("createTableTemplate"))).toBeNull();
  });
});
