import { configure, getConfig } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { chooseListboxOption, renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableColumnInfo } from "../api/tauri";

// CI のシャード実行では waitFor の既定 1 秒が不安定になるので、このファイルだけ待ちを延ばす。
let prevAsyncTimeout = 1000;
beforeAll(() => {
  prevAsyncTimeout = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: 5000 });
});
afterAll(() => {
  configure({ asyncUtilTimeout: prevAsyncTimeout });
});

/**
 * Query Builder の JOIN / 集計の描画テスト (#2242)。外部キーから表を足し、集計を付けて
 * 実行すると、期待どおりの SQL が `onExecute` に渡ることを固定する。
 */
const { ORDERS, CUSTOMERS } = vi.hoisted(() => {
  const c = (name: string, type: string): TableColumnInfo => ({
    name,
    data_type: type,
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });
  return {
    ORDERS: [c("id", "int"), c("customer_id", "int"), c("total", "decimal")],
    CUSTOMERS: [c("id", "int"), c("name", "varchar")],
  };
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases: vi.fn(),
      listTables: vi.fn(),
      describeTable: vi.fn(),
      foreignKeys: vi.fn(),
      runLookupQuery: vi.fn(),
    },
  };
});

import { QueryBuilder } from "../components/QueryBuilder";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDatabases).mockResolvedValue(["shop"]);
  vi.mocked(api.listTables).mockResolvedValue(["orders", "customers"]);
  vi.mocked(api.describeTable).mockImplementation(async (_s, _d, table) =>
    table === "customers" ? CUSTOMERS : ORDERS,
  );
  vi.mocked(api.foreignKeys).mockResolvedValue([
    {
      table: "orders",
      column: "customer_id",
      referenced_table: "customers",
      referenced_column: "id",
      constraint_name: "fk_oc",
    },
    {
      table: "payments",
      column: "order_id",
      referenced_table: "orders",
      referenced_column: "id",
      constraint_name: "fk_po",
    },
  ]);
});

async function addCustomersByFk() {
  await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddJoinTable")) }));
  await waitFor(() => expect(api.foreignKeys).toHaveBeenCalledWith("s1", "shop"));
  const cards = await screen.findAllByTestId("qb-fk-candidate");
  const card = cards.find((c) => c.textContent?.includes("customers"));
  if (!card) throw new Error("customers の FK 候補カードがありません");
  fireEvent.click(card);
  await waitFor(() => expect(screen.getAllByTestId("qb-join")).toHaveLength(1));
  await waitFor(() => expect(api.describeTable).toHaveBeenCalledWith("s1", "shop", "customers"));
}

describe("QueryBuilder JOIN / 集計", () => {
  it("外部キーの候補から表を足すと、ON が自動で組まれる", async () => {
    const onExecute = vi.fn();
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={onExecute} onClose={() => {}} />,
    );
    await addCustomersByFk();
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute).toHaveBeenCalledWith(
      "SELECT `orders`.*, `customers`.* FROM `shop`.`orders` INNER JOIN `shop`.`customers` ON `orders`.`customer_id` = `customers`.`id` LIMIT 100;",
    );
  });

  it("集計を足すと GROUP BY が自動で付き、集計しない列も漏れない", async () => {
    const onExecute = vi.fn();
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="postgres" onExecute={onExecute} onClose={() => {}} />,
    );
    await addCustomersByFk();
    // 「すべての列」を外して customers.name を選ぶ。
    fireEvent.click(screen.getByLabelText(t("qbAllColumns")));
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "customers.name" } });
    fireEvent.click(screen.getByRole("button", { name: `+ ${t("qbAddColumn")}` }));
    // 集計: COUNT(*) AS n
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddAggregate")) }));
    fireEvent.change(screen.getByPlaceholderText(t("qbAggColumn")), { target: { value: "*" } });
    fireEvent.change(screen.getByLabelText(t("qbAggAlias")), { target: { value: "n" } });
    await waitFor(() => expect(screen.getByTestId("qb-group-by-note")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute).toHaveBeenCalledWith(
      'SELECT "customers"."name", COUNT(*) AS "n" FROM "shop"."orders" INNER JOIN "shop"."customers" ON "orders"."customer_id" = "customers"."id" GROUP BY "customers"."name" LIMIT 100;',
    );
  });

  it("結合を外すと、その表を指していた列も消える", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await addCustomersByFk();
    const join = screen.getByTestId("qb-join");
    fireEvent.click(join.querySelectorAll<HTMLButtonElement>(`button[aria-label="${t("qbRemove")}"]`)[0]);
    await waitFor(() => expect(screen.queryByTestId("qb-join")).toBeNull());
  });

  it("結合種別はベン図付きのセグメントで切り替わり、チェーン図にも反映される (#2267)", async () => {
    const onExecute = vi.fn();
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={onExecute} onClose={() => {}} />,
    );
    await addCustomersByFk();
    expect(screen.getByTestId("qb-join-chain")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "LEFT JOIN" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "LEFT JOIN" })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute.mock.calls[0][0]).toContain("LEFT JOIN `shop`.`customers`");
    // チェーン図のチップから該当カードへフォーカスが移る。
    fireEvent.click(screen.getByRole("button", { name: t("qbJoinChainGo", { table: "customers" }) }));
    expect(document.activeElement).toBe(screen.getByTestId("qb-join"));
  });

  it("FK 候補は参照先 (親) と参照元 (子) の向きをバッジと data-direction で示す (#2267)", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddJoinTable")) }));
    const cards = await screen.findAllByTestId("qb-fk-candidate");
    const parent = cards.find((c) => c.textContent?.includes("customers"));
    const child = cards.find((c) => c.textContent?.includes("payments"));
    expect(parent?.getAttribute("data-direction")).toBe("outgoing");
    expect(parent?.textContent).toContain(t("qbFkParent"));
    expect(child?.getAttribute("data-direction")).toBe("incoming");
    expect(child?.textContent).toContain(t("qbFkChild"));
  });

  it("ON が未完成の手動結合は Run をブロックする", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddJoinTable")) }));
    const manual = await screen.findByLabelText(t("qbAddManualTable"));
    chooseListboxOption(manual, "customers");
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).toBeDisabled());
  });

  it("結合先の条件のまま DELETE に切り替えると止まり、列を選び直すと実行できる", async () => {
    const onExecute = vi.fn();
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={onExecute} onClose={() => {}} />,
    );
    await addCustomersByFk();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "customers.name" } });
    fireEvent.change(screen.getByPlaceholderText(t("qbValue")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).toBeDisabled());
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "id" } });
    fireEvent.change(screen.getByPlaceholderText(t("qbValue")), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute).toHaveBeenCalledWith("DELETE FROM `shop`.`orders` WHERE `id` = 1;");
  });
});
