import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { chooseListboxOption, renderWithProviders, screen, waitFor } from "./testUtils";
import { setLocale, t } from "../i18n";

// 論理リレーション (仮想 FK, #2356) の管理ダイアログ。

const col = (name: string, key = "") => ({
  name,
  data_type: "bigint",
  nullable: false,
  key,
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
});

const stored: Array<Record<string, unknown>> = [];
const saveLogicalRelations = vi.fn(async (_s: string, _d: string, rels: Array<Record<string, unknown>>) => {
  for (const r of rels) stored.push({ ...r, profile_id: null, database: "app", created_at: "t" });
  return [...stored];
});
const deleteLogicalRelation = vi.fn(async () => {
  stored.length = 0;
  return [];
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeDatabase: () =>
        Promise.resolve([
          { name: "users", columns: [col("id", "PRI")] },
          { name: "orders", columns: [col("id", "PRI"), col("user_id")] },
        ]),
      listLogicalRelations: () => Promise.resolve([...stored]),
      foreignKeys: () => Promise.resolve([]),
      saveLogicalRelations: (...a: Parameters<typeof saveLogicalRelations>) => saveLogicalRelations(...a),
      deleteLogicalRelation: () => deleteLogicalRelation(),
    },
  };
});

import { LogicalRelationsModal } from "../components/LogicalRelationsModal";

function setup() {
  renderWithProviders(<LogicalRelationsModal sessionId="s1" database="app" onClose={() => {}} />);
}

describe("LogicalRelationsModal", () => {
  beforeEach(() => {
    setLocale("en");
    stored.length = 0;
    vi.clearAllMocks();
  });

  it("候補を推定してチェックしたものだけを登録できる", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(t("logicalRelEmpty"));
    await user.click(screen.getByRole("button", { name: t("logicalRelSuggest") }));
    const pick = await screen.findByRole("checkbox", {
      name: t("logicalRelPick", { relation: "orders (user_id) → users (id)" }),
    });
    expect(pick).toBeChecked();
    await user.click(screen.getByRole("button", { name: t("logicalRelRegisterPicked", { count: 1 }) }));
    await waitFor(() =>
      expect(saveLogicalRelations).toHaveBeenCalledWith("s1", "app", [
        { table: "orders", columns: ["user_id"], referenced_table: "users", referenced_columns: ["id"] },
      ]),
    );
    expect(await screen.findByText("orders (user_id) → users (id)")).toBeInTheDocument();
  });

  it("手動で選んで追加でき、登録済みは削除できる", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(t("logicalRelEmpty"));
    const add = screen.getByRole("button", { name: t("logicalRelAdd") });
    expect(add).toBeDisabled();
    chooseListboxOption(screen.getByLabelText(t("logicalRelChild")), "orders");
    chooseListboxOption(screen.getByLabelText(t("logicalRelParent")), "users");
    chooseListboxOption(screen.getByLabelText(t("logicalRelChildColumn")), "user_id");
    chooseListboxOption(screen.getByLabelText(t("logicalRelParentColumn")), "id");
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await waitFor(() => expect(saveLogicalRelations).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: /^Delete orders/ }));
    await waitFor(() => expect(deleteLogicalRelation).toHaveBeenCalled());
    await screen.findByText(t("logicalRelEmpty"));
  });
});
