import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
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

import { UsersPanel } from "../components/UsersPanel";
import { api } from "../api/tauri";

function user(name: string): DbUserInfo {
  return { name, host: null, attributes: [], member_of: [], is_superuser: false, can_login: true };
}

function privs(table: string): UserPrivileges {
  return {
    global: null,
    tables: [
      { table: `public.${table}`, select: true, insert: false, update: false, delete: false, ddl: false },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** ユーザ切替後に遅れて返った旧ユーザの権限応答は捨てる (#1525)。 */
describe("UsersPanel privilege load race", () => {
  it("ignores a stale privilege response for a previously selected user", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("alice"), user("bob")]);
    const resolvers: Record<string, (p: UserPrivileges) => void> = {};
    vi.mocked(api.listUserPrivileges).mockImplementation(
      (_sid, name) =>
        new Promise<UserPrivileges>((r) => {
          resolvers[name] = r;
        }),
    );

    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /alice/ }));
    fireEvent.click(await screen.findByRole("button", { name: /bob/ }));

    await act(async () => {
      resolvers.bob(privs("bob_table"));
    });
    await screen.findByText("bob_table");
    await act(async () => {
      resolvers.alice(privs("alice_table"));
    });

    await waitFor(() => {
      expect(screen.queryByText("alice_table")).not.toBeInTheDocument();
    });
    expect(screen.getByText("bob_table")).toBeInTheDocument();
  });

  it("disables Apply while another user's privileges are loading, and drops the previous edits", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("alice"), user("bob")]);
    const resolvers: Record<string, (p: UserPrivileges) => void> = {};
    vi.mocked(api.listUserPrivileges).mockImplementation(
      (_sid, name) =>
        new Promise<UserPrivileges>((r) => {
          resolvers[name] = r;
        }),
    );
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /alice/ }));
    await act(async () => {
      resolvers.alice(privs("alice_table"));
    });
    await screen.findByText("alice_table");
    // alice の行を編集 (チェックボックスを 1 つ切り替える)。
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[1]);
    const apply = screen.getByRole("button", { name: t("usersApplyChanges") });
    expect(apply).not.toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: /bob/ }));
    expect(screen.queryByText("alice_table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("usersApplyChanges") })).toBeDisabled();
  });

  it("does not overwrite a newly selected user with the applied user's privileges", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValue([user("alice"), user("bob")]);
    const resolvers: Record<string, (p: UserPrivileges) => void> = {};
    vi.mocked(api.listUserPrivileges).mockImplementation(
      (_sid, name) =>
        new Promise<UserPrivileges>((r) => {
          resolvers[name] = r;
        }),
    );
    vi.mocked(api.generatePrivilegeDiffSql).mockResolvedValue([
      "GRANT INSERT ON public.alice_table TO alice",
    ]);
    let resolveApply: () => void = () => {};
    vi.mocked(api.applyPrivilegeSql).mockImplementation(
      () =>
        new Promise<number>((r) => {
          resolveApply = () => r(1);
        }),
    );
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /alice/ }));
    await act(async () => {
      resolvers.alice(privs("alice_table"));
    });
    await screen.findByText("alice_table");
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: t("usersApplyChanges") }));
    fireEvent.click(await screen.findByRole("button", { name: t("usersApplyConfirmOk") }));
    await waitFor(() => expect(api.applyPrivilegeSql).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // 適用待ちの間に bob を選ぶ。
    fireEvent.click(screen.getByRole("button", { name: /bob/ }));
    await act(async () => {
      resolveApply();
    });
    await act(async () => {
      resolvers.bob(privs("bob_table"));
    });

    await screen.findByText("bob_table");
    expect(screen.queryByText("alice_table")).not.toBeInTheDocument();
    // 適用後に alice を読み直していない (初回の 1 回だけ)。
    expect(vi.mocked(api.listUserPrivileges).mock.calls.filter((c) => c[1] === "alice")).toHaveLength(1);
  });
});

/** ロール付与の適用待ち中に別ユーザへ切り替えたら、旧ユーザの結果 (選択・フラッシュ) を反映しない (#1890)。 */
describe("UsersPanel role grant race (#1890)", () => {
  it("does not flash or reselect the old user when another user was selected meanwhile", async () => {
    vi.mocked(api.listDbUsers).mockResolvedValueOnce([user("alice"), user("bob")]);
    vi.mocked(api.listUserPrivileges).mockImplementation(async () => privs("t1"));
    vi.mocked(api.generateRoleMembershipSql).mockResolvedValue('GRANT "reader" TO "alice"');
    let finishApply: (n: number) => void = () => {};
    vi.mocked(api.applyPrivilegeSql).mockImplementation(() => new Promise<number>((r) => (finishApply = r)));
    renderWithProviders(
      <UsersPanel sessionId="s1" driver="postgres" database="public" readOnly={false} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /alice/ }));
    await screen.findByText("t1");
    fireEvent.change(document.getElementById("users-role-input") as HTMLInputElement, {
      target: { value: "reader" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("usersRoleGrant") }));
    fireEvent.click(await screen.findByRole("button", { name: t("usersRoleGrantOk") }));
    await waitFor(() => expect(api.applyPrivilegeSql).toHaveBeenCalled());
    // 適用待ちの間に bob へ切り替える。再取得したユーザ一覧では alice が reader を持つ。
    vi.mocked(api.listDbUsers).mockResolvedValue([{ ...user("alice"), member_of: ["reader"] }, user("bob")]);
    // 確認ダイアログが閉じ切るまで背面が aria-hidden のことがあるので待つ。
    fireEvent.click(await screen.findByRole("button", { name: /bob/ }));
    await act(async () => {
      finishApply(1);
    });
    await waitFor(() => expect(api.listDbUsers).toHaveBeenCalledTimes(2));
    expect(document.querySelector("[data-role-flash]")).toBeNull();
    expect(screen.getByRole("heading", { name: "bob" })).toBeInTheDocument();
  });
});
