import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { chooseListboxOption, renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";

// RLS ポリシーの作成ダイアログ (#2159)。

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTables: () => Promise.resolve(["docs", "plain", "v_docs"]),
      listSchemaObjects: () =>
        Promise.resolve([
          { kind: "view", name: "v_docs", id: null, detail: null },
          { kind: "policy", name: "taken", id: "1", detail: "docs" },
        ]),
      listRlsTables: () => Promise.resolve([{ table: "docs", enabled: true, forced: false }]),
    },
  };
});

import { PolicyModal } from "../components/PolicyModal";

function setup(over: { readOnly?: boolean; initialTable?: string | null } = {}) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <PolicyModal
      sessionId="s1"
      database="public"
      initialTable={over.initialTable === undefined ? "plain" : over.initialTable}
      readOnly={over.readOnly ?? false}
      onConfirm={onConfirm}
      onClose={() => {}}
    />,
  );
  return { onConfirm };
}

describe("PolicyModal", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
  });

  it("RLS が無効な表では ENABLE も含めてプレビューし、確定で文の配列を渡す", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await waitFor(() => expect(screen.getByLabelText(t("policyName"))).toBeEnabled());
    await user.type(screen.getByLabelText(t("policyName")), "own_rows");
    await user.type(screen.getByLabelText(t("policyUsing")), "owner = current_user");
    await waitFor(() =>
      expect(screen.getByText(/ALTER TABLE "public"."plain" ENABLE ROW LEVEL SECURITY;/)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: t("policyConfirm") }));
    expect(onConfirm).toHaveBeenCalledWith(
      [
        'ALTER TABLE "public"."plain" ENABLE ROW LEVEL SECURITY',
        'CREATE POLICY "own_rows" ON "public"."plain"\n  AS PERMISSIVE\n  FOR ALL\n  TO PUBLIC\n  USING (owner = current_user)',
      ],
      "own_rows",
    );
  });

  it("RLS が有効な表では ENABLE を出さず、その旨を示す。ビューは表の選択肢に出ない", async () => {
    const user = userEvent.setup();
    setup({ initialTable: "docs" });
    await waitFor(() => expect(screen.getByLabelText(t("policyName"))).toBeEnabled());
    expect(screen.getByText(t("policyRlsAlreadyOn"))).toBeInTheDocument();
    await user.type(screen.getByLabelText(t("policyName")), "p1");
    expect(screen.queryByText(/ENABLE ROW LEVEL SECURITY/)).not.toBeInTheDocument();
    expect(screen.getByText(/CREATE POLICY "p1" ON "public"."docs"/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(t("policyTable")));
    expect(screen.queryByRole("option", { name: "v_docs" })).not.toBeInTheDocument();
  });

  it("同じ表に同名のポリシーがあると重複エラーで確定できない", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ initialTable: "docs" });
    await waitFor(() => expect(screen.getByLabelText(t("policyName"))).toBeEnabled());
    await user.type(screen.getByLabelText(t("policyName")), "taken");
    expect(screen.getByText(t("policyErrDuplicate"))).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: t("policyConfirm") });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("INSERT では USING 欄が無効になり、SQL に出ない", async () => {
    const user = userEvent.setup();
    setup({ initialTable: "docs" });
    await waitFor(() => expect(screen.getByLabelText(t("policyName"))).toBeEnabled());
    await user.type(screen.getByLabelText(t("policyName")), "ins");
    await user.type(screen.getByLabelText(t("policyUsing")), "a = 1");
    expect(screen.getByText(/USING \(a = 1\)/)).toBeInTheDocument();
    chooseListboxOption(screen.getByLabelText(t("policyCommand")), "INSERT");
    await waitFor(() => expect(screen.getByLabelText(t("policyUsing"))).toBeDisabled());
    await user.type(screen.getByLabelText(t("policyWithCheck")), "id > 0");
    expect(screen.getByText(/FOR INSERT/)).toBeInTheDocument();
    expect(screen.getByText(/WITH CHECK \(id > 0\)/)).toBeInTheDocument();
    expect(screen.queryByText(/USING \(a = 1\)/)).not.toBeInTheDocument();
  });

  it("read_only では警告を出して確定できない", async () => {
    setup({ readOnly: true });
    await screen.findByText(t("policyReadOnly"));
    expect(screen.getByRole("button", { name: t("policyConfirm") })).toBeDisabled();
  });

  it("実行中は確定ボタンが無効になり、二重に押しても 1 回だけ渡す", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderWithProviders(
      <PolicyModal
        sessionId="s1"
        database="public"
        initialTable="docs"
        readOnly={false}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(t("policyName"))).toBeEnabled());
    await user.type(screen.getByLabelText(t("policyName")), "p2");
    const confirm = screen.getByRole("button", { name: t("policyConfirm") });
    await user.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(confirm).toBeEnabled());
  });
});
