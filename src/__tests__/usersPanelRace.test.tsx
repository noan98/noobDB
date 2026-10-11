import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
import type { DbUserInfo, UserPrivileges } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDbUsers: vi.fn(),
      listUserPrivileges: vi.fn(),
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
    tables: [{ table: `public.${table}`, select: true, insert: false, update: false, delete: false, ddl: false }],
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
      (_sid, name) => new Promise<UserPrivileges>((r) => { resolvers[name] = r; }),
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
});
