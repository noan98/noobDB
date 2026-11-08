import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, chooseListboxOption } from "./testUtils";
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

  /** 雛形の選択欄を取り、テーブル名の候補 ("未選択" + 2 表) が読み込まれるまで待つ。 */
  async function templateSelect(): Promise<HTMLElement> {
    const select = await screen.findByLabelText(t("createTableTemplate"));
    await waitFor(() => {
      fireEvent.click(select);
      const count = document
        .getElementById(select.getAttribute("aria-controls") ?? "")
        ?.querySelectorAll('[role="option"]').length;
      fireEvent.keyDown(select, { key: "Escape" });
      expect(count).toBe(3);
    });
    return select;
  }

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
    const select = await templateSelect();
    const load = screen.getByRole("button", { name: t("createTableTemplateLoad") });
    expect(load).toBeDisabled();
    chooseListboxOption(select, "users");
    fireEvent.click(load);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalledWith("s1", "appdb", "users"));
    expect(await screen.findByDisplayValue("uid")).toBeInTheDocument();
    expect(screen.getByDisplayValue("nick")).toBeInTheDocument();
    // テーブル名が空なら「<元>_copy」を提案する。
    expect(screen.getByLabelText(t("createTableName"))).toHaveValue("users_copy");
    expect(screen.getByTestId("sql-preview")).toHaveTextContent(/CREATE TABLE `appdb`\.`users_copy`/);
  });

  it("入力済みの列があるときだけ置き換えを確認し、キャンセルすると列は変わらない", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([colInfo("uid")] as never);
    renderModal();
    const select = await templateSelect();
    // 初期状態 (id のみ) では確認なしで置き換わる。
    chooseListboxOption(select, "users");
    fireEvent.click(screen.getByRole("button", { name: t("createTableTemplateLoad") }));
    expect(await screen.findByDisplayValue("uid")).toBeInTheDocument();
    expect(screen.queryByText(t("createTableTemplateConfirmTitle"))).toBeNull();
    // 列を編集したあとは確認が出る。キャンセルで元のまま。
    fireEvent.change(screen.getByDisplayValue("uid"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: t("createTableTemplateLoad") }));
    await screen.findByText(t("confirmDefaultCancel"), { selector: "button" });
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByText(t("createTableTemplateConfirmTitle"))).toBeNull());
    expect(screen.getByDisplayValue("mine")).toBeInTheDocument();
  });

  it("初期列を変えていなくても FK が入力済みなら置き換えを確認する", async () => {
    vi.mocked(api.describeTable).mockResolvedValue([colInfo("uid")] as never);
    renderModal();
    const select = await templateSelect();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("constraintFkAdd")) }));
    chooseListboxOption(select, "users");
    fireEvent.click(screen.getByRole("button", { name: t("createTableTemplateLoad") }));
    expect(await screen.findByText(t("createTableTemplateConfirmTitle"))).toBeInTheDocument();
  });

  it("読み込みに失敗したらエラーを出し、列は変えない", async () => {
    vi.mocked(api.describeTable).mockRejectedValueOnce(new Error("denied"));
    renderModal();
    const select = await templateSelect();
    chooseListboxOption(select, "orders");
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

describe("CreateTableModal 動的行の出入り (#2014)", () => {
  const renderModal = () =>
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
  const nameInputs = () => screen.getAllByLabelText(new RegExp(`^${t("createTableColName")} \\(`));

  it("列を途中で削除しても、残った列の入力値は取り違えない (安定キー)", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    ["a", "b", "c"].forEach((v, i) => fireEvent.change(nameInputs()[i], { target: { value: v } }));
    fireEvent.click(screen.getAllByRole("button", { name: t("createTableRemoveCol") })[0]);
    await waitFor(() => expect(nameInputs()).toHaveLength(2));
    expect(nameInputs().map((el) => (el as HTMLInputElement).value)).toEqual(["b", "c"]);
  });

  it("消えかけの列の × をもう一度押しても、残りの列は減らない", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("createTableAddCol")) }));
    ["a", "b", "c"].forEach((v, i) => fireEvent.change(nameInputs()[i], { target: { value: v } }));
    const firstRemove = screen.getAllByRole("button", { name: t("createTableRemoveCol") })[0];
    fireEvent.click(firstRemove);
    fireEvent.click(firstRemove);
    await waitFor(() => expect(nameInputs()).toHaveLength(2));
    expect(nameInputs().map((el) => (el as HTMLInputElement).value)).toEqual(["b", "c"]);
  });

  it("CHECK 行を追加・削除できる", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("constraintCheckAdd")) }));
    expect(screen.getAllByLabelText(t("constraintCheckExpr"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t("constraintCheckRemove") }));
    await waitFor(() => expect(screen.queryAllByLabelText(t("constraintCheckExpr"))).toHaveLength(0));
  });
});

describe("CreateTableModal テーブルオプション (#2161)", () => {
  const renderFor = (driver: "mysql" | "postgres" | "sqlite") =>
    renderWithProviders(
      <CreateTableModal
        driver={driver}
        database={driver === "mysql" ? "appdb" : null}
        readOnly={false}
        onRun={() => {}}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
  const fillName = () =>
    fireEvent.change(screen.getByLabelText(t("createTableName")), { target: { value: "ev" } });

  it("MySQL: ENGINE / CHARSET が CREATE 文の末尾へ反映される", () => {
    renderFor("mysql");
    fillName();
    fireEvent.change(screen.getByLabelText("ENGINE"), { target: { value: "InnoDB" } });
    fireEvent.change(screen.getByLabelText("CHARSET"), { target: { value: "utf8mb4" } });
    expect(screen.getByText(/ENGINE=InnoDB/)).toBeInTheDocument();
    expect(screen.getByText(/CHARSET=utf8mb4/)).toBeInTheDocument();
  });

  it("PostgreSQL: UNLOGGED を入れると CREATE UNLOGGED TABLE になる", () => {
    renderFor("postgres");
    fillName();
    fireEvent.click(screen.getByLabelText("UNLOGGED"));
    expect(screen.getByText(/CREATE UNLOGGED TABLE/)).toBeInTheDocument();
  });

  it("SQLite: STRICT で非対応の型の列があるとエラーを出す", () => {
    renderFor("sqlite");
    fillName();
    fireEvent.change(screen.getAllByLabelText(new RegExp(`^${t("createTableColName")} \\(`))[0], {
      target: { value: "a" },
    });
    fireEvent.click(screen.getByLabelText("STRICT"));
    fireEvent.change(screen.getByLabelText("Type (1)"), { target: { value: "VARCHAR(10)" } });
    expect(screen.getByText(/STRICT tables allow only/)).toBeInTheDocument();
  });

  it("PostgreSQL: 最初の子パーティションを指定すると、onRun に親と子の 2 文を配列で渡す", () => {
    const onRun = vi.fn();
    renderWithProviders(
      <CreateTableModal
        driver="postgres"
        database={null}
        readOnly={false}
        onRun={onRun}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    fillName();
    fireEvent.change(screen.getAllByLabelText(new RegExp(`^${t("createTableColName")} \\(`))[0], {
      target: { value: "id" },
    });
    fireEvent.click(screen.getByLabelText(t("createTableOptPartition")));
    fireEvent.change(document.getElementById("create-table-part-key") as HTMLInputElement, {
      target: { value: "id" },
    });
    fireEvent.change(document.getElementById("create-table-part-first") as HTMLInputElement, {
      target: { value: "ev_p0" },
    });
    fireEvent.change(document.getElementById("create-table-part-from") as HTMLInputElement, {
      target: { value: "1" },
    });
    fireEvent.change(document.getElementById("create-table-part-to") as HTMLInputElement, {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("createTableRun") }));
    expect(onRun).toHaveBeenCalledOnce();
    const [sql, statements] = onRun.mock.calls[0] as [string, string[]];
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("PARTITION BY RANGE");
    expect(statements[1]).toContain('PARTITION OF "ev"');
    expect(sql).toBe(statements.join("\n"));
  });
});
