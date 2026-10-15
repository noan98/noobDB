import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
import { t } from "../i18n";
import type { DbUserInfo, UserPrivileges } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDbUsers: vi.fn(),
      listUserPrivileges: vi.fn(),
      generatePrivilegeDiffSql: vi.fn(),
      generateRoleMembershipSql: vi.fn(),
      applyPrivilegeSql: vi.fn(),
    },
  };
});

import { UsersPanel, mergeCopiedPrivileges } from "../components/UsersPanel";
import { api } from "../api/tauri";

function user(name: string): DbUserInfo {
  return { name, host: null, attributes: [], member_of: [], is_superuser: false, can_login: true };
}

function priv(table: string, select: boolean, insert = false): UserPrivileges["tables"][number] {
  return { table: `public.${table}`, select, insert, update: false, delete: false, ddl: false };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mergeCopiedPrivileges (#1536)", () => {
  const on = { select: true, insert: false, update: false, delete: false, ddl: false };
  const off = { select: false, insert: false, update: false, delete: false, ddl: false };

  it("コピー元の権限へ揃え、コピー先だけが持つテーブルは全 OFF にする", () => {
    expect(mergeCopiedPrivileges({ mine: on, shared: off }, { shared: on, theirs: on })).toEqual({
      mine: off,
      shared: on,
      theirs: on,
    });
  });

  it("Object の組み込みプロパティ名と同じ表名でも、コピー元に無ければ全 OFF (REVOKE 対象) になる", () => {
    const out = mergeCopiedPrivileges({ constructor: on, toString: on }, { a: on });
    expect(out.constructor).toEqual(off);
    expect(out.toString).toEqual(off);
    expect(out.a).toEqual(on);
  });

  it("コピー元を書き換えない (別オブジェクトを返す)", () => {
    const src = { a: on };
    const out = mergeCopiedPrivileges({}, src);
    expect(out.a).not.toBe(src.a);
  });
});

describe("UsersPanel: 権限コピー (#1536)", () => {
  it("コピー元の権限を読み込むと差分 SQL の元になる編集状態に反映される", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app"), user("template")]);
    vi.mocked(api.listUserPrivileges).mockImplementation(async (_sid, name) => ({
      global: null,
      tables: name === "app" ? [priv("old_only", true)] : [priv("orders", true, true)],
    }));
    vi.mocked(api.generatePrivilegeDiffSql).mockResolvedValue(["GRANT ...", "REVOKE ..."]);

    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("old_only");

    fireEvent.click(screen.getByRole("button", { name: t("usersCopyPrivileges") }));
    fireEvent.change(screen.getByLabelText(t("usersCopySourceLabel")), { target: { value: "template@@" } });
    fireEvent.click(screen.getByRole("button", { name: t("usersCopySubmit") }));

    // コピー元だけが持つテーブルが現れ、変更ありの状態になる。
    await screen.findByText("orders");
    const apply = screen.getByRole("button", { name: t("usersApplyChanges") });
    await waitFor(() => expect(apply).toBeEnabled());
    expect(screen.getByLabelText("orders select")).toBeChecked();
    // 自分だけが持っていたテーブルの権限は外れる (剥奪対象)。
    expect(screen.getByLabelText("old_only select")).not.toBeChecked();
  });

  it("別ユーザへ切り替えるとコピー元の選択が閉じる", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app"), user("template")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [priv("t1", true)] });
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("t1");
    fireEvent.click(screen.getByRole("button", { name: t("usersCopyPrivileges") }));
    fireEvent.change(screen.getByLabelText(t("usersCopySourceLabel")), { target: { value: "template@@" } });
    fireEvent.click(screen.getByRole("button", { name: /^template/ }));
    await waitFor(() => expect(screen.queryByLabelText(t("usersCopySourceLabel"))).not.toBeInTheDocument());
  });

  it("適用が失敗したら、サーバの実際の権限を再取得する", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [priv("t1", true)] });
    vi.mocked(api.generatePrivilegeDiffSql).mockResolvedValue(["GRANT INSERT ON public.t1 TO app"]);
    vi.mocked(api.applyPrivilegeSql).mockRejectedValue(new Error("boom"));
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="mysql" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("t1");
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: t("usersApplyChanges") }));
    fireEvent.click(await screen.findByRole("button", { name: t("usersApplyConfirmOk") }));
    await waitFor(() => expect(api.applyPrivilegeSql).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(api.listUserPrivileges)).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["mysql", true],
    ["postgres", false],
  ] as const)("適用確認の MySQL 非原子注意: %s -> 表示=%s", async (driver, shown) => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [priv("t1", true)] });
    vi.mocked(api.generatePrivilegeDiffSql).mockResolvedValue(["GRANT INSERT ON public.t1 TO app"]);
    renderWithProviders(
      <UsersPanel sessionId="s1" driver={driver} database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("t1");
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: t("usersApplyChanges") }));
    await screen.findByRole("button", { name: t("usersApplyConfirmOk") });
    expect(screen.queryByText(t("usersApplyMysqlNonAtomic")) !== null).toBe(shown);
  });

  it("ユーザが 1 人だけなら権限コピーは無効", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [] });
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    expect(await screen.findByRole("button", { name: t("usersCopyPrivileges") })).toBeDisabled();
  });

  async function copyFrom(driver: "postgres" | "mysql", sourceTables: UserPrivileges["tables"]) {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app"), user("template")]);
    vi.mocked(api.listUserPrivileges).mockImplementation(async (_sid, name) => ({
      global: null,
      tables: name === "app" ? [priv("old_only", true)] : sourceTables,
    }));
    renderWithProviders(
      <UsersPanel sessionId="s1" driver={driver} database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("old_only");
    fireEvent.click(screen.getByRole("button", { name: t("usersCopyPrivileges") }));
  }

  it("コピー元の権限が 0 件なら、全権限が剥奪される旨の注意を出す", async () => {
    await copyFrom("postgres", []);
    fireEvent.change(screen.getByLabelText(t("usersCopySourceLabel")), { target: { value: "template@@" } });
    fireEvent.click(screen.getByRole("button", { name: t("usersCopySubmit") }));
    const warn = await screen.findByTestId("users-copy-warning");
    expect(warn).toHaveTextContent(t("usersCopyEmptySource", { name: "template", database: "public" }));
  });

  it("適用で REVOKE が出るコピーでは件数つきの注意を出し、MySQL ではテーブル単位の注記を出す", async () => {
    await copyFrom("mysql", [priv("orders", true)]);
    expect(screen.getByText(t("usersCopyMysqlNote"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t("usersCopySourceLabel")), { target: { value: "template@@" } });
    fireEvent.click(screen.getByRole("button", { name: t("usersCopySubmit") }));
    const warn = await screen.findByTestId("users-copy-warning");
    expect(warn).toHaveTextContent(t("usersCopyRevokes", { count: 1 }));
  });
});

describe("UsersPanel: ロール・列単位・テンプレート・パスワード生成 (#1622)", () => {
  it("PostgreSQL のロールを外すと REVOKE を確認して適用する", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([{ ...user("app"), member_of: ["reader"] }]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [priv("t1", true)] });
    vi.mocked(api.generateRoleMembershipSql).mockResolvedValue('REVOKE "reader" FROM "app"');
    vi.mocked(api.applyPrivilegeSql).mockResolvedValue(1);
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: t("usersRoleRevokeAria", { role: "reader" }) }),
    );
    expect(await screen.findByText(/REVOKE "reader" FROM "app"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("usersRoleRevokeOk") }));
    await waitFor(() =>
      expect(api.applyPrivilegeSql).toHaveBeenCalledWith({
        sessionId: "s1",
        database: "public",
        statements: ['REVOKE "reader" FROM "app"'],
      }),
    );
    expect(api.generateRoleMembershipSql).toHaveBeenCalledWith(
      expect.objectContaining({ grant: false, role: "reader", user: "app" }),
    );
  });

  it("MySQL では role@host を分解してロール付与 SQL を生成する", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [] });
    vi.mocked(api.generateRoleMembershipSql).mockResolvedValue("GRANT 'r'@'h' TO 'app'@'%'");
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="mysql" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    fireEvent.change(await screen.findByLabelText(t("usersRolesLabel")), { target: { value: "r@h" } });
    fireEvent.click(screen.getByRole("button", { name: t("usersRoleGrant") }));
    await waitFor(() =>
      expect(api.generateRoleMembershipSql).toHaveBeenCalledWith(
        expect.objectContaining({ grant: true, role: "r", roleHost: "h" }),
      ),
    );
  });

  it("read_only ではロール付与ボタンが無効", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [] });
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={true} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    expect(await screen.findByRole("button", { name: t("usersRoleGrant") })).toBeDisabled();
  });

  it("テンプレートを選ぶと全行へ反映され、変更ありになる", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({
      global: null,
      tables: [priv("a", false), priv("b", true, true)],
    });
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("a");
    fireEvent.change(screen.getByLabelText(t("usersTemplateLabel")), { target: { value: "readOnly" } });
    fireEvent.click(screen.getByRole("button", { name: t("usersTemplateApply") }));
    expect(screen.getByLabelText("a select")).toBeChecked();
    expect(screen.getByLabelText("b select")).toBeChecked();
    expect(screen.getByLabelText("b insert")).not.toBeChecked();
    expect(screen.getByRole("button", { name: t("usersApplyChanges") })).toBeEnabled();
  });

  it("列単位の付与は columns 付きの差分で SQL を生成する", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("app")]);
    vi.mocked(api.listUserPrivileges).mockResolvedValue({ global: null, tables: [priv("a", false)] });
    vi.mocked(api.generatePrivilegeDiffSql).mockResolvedValue([
      'GRANT SELECT ("id") ON "public"."a" TO "app"',
    ]);
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^app/ }));
    await screen.findByText("a");
    fireEvent.click(screen.getByRole("button", { name: t("usersColumnPrivileges") }));
    fireEvent.change(screen.getByLabelText(t("usersColumnTableLabel")), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText(t("usersColumnListLabel")), { target: { value: "id" } });
    fireEvent.click(
      within(screen.getByTestId("users-columns")).getByRole("button", { name: t("usersColumnGrant") }),
    );
    await waitFor(() =>
      expect(api.generatePrivilegeDiffSql).toHaveBeenCalledWith("postgres", "app", null, "public", [
        expect.objectContaining({ table: "a", columns: ["id"] }),
      ]),
    );
  });

  it("パスワード生成ボタンで入力欄に平文の乱数パスワードが入る", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([]);
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: t("usersNewUser") }));
    fireEvent.click(screen.getByRole("button", { name: t("usersPasswordGenerate") }));
    const input = screen.getByLabelText(t("usersCreatePasswordLabel")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toHaveLength(24));
    expect(input.type).toBe("text");
  });
});
