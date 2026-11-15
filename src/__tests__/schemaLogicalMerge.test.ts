import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../api/invoke", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { schemaCommands } from "../api/commands/schema";
import { buildErGraph } from "../components/erDiagram";

const logical = {
  profile_id: "p1",
  database: "app",
  table: "orders",
  columns: ["user_id"],
  referenced_table: "users",
  referenced_columns: ["id"],
  created_at: "2026-01-01T00:00:00Z",
};
const column = (name: string, referenced: string | null) => ({
  name,
  data_type: "bigint",
  nullable: false,
  key: "",
  default: null,
  extra: "",
  referenced_table: referenced,
  referenced_column: referenced ? "id" : null,
});

function respond(map: Record<string, unknown | (() => never)>) {
  invoke.mockImplementation(async (cmd: string) => {
    const v = map[cmd];
    if (typeof v === "function") return (v as () => never)();
    return v;
  });
}

beforeEach(() => invoke.mockReset());

describe("論理リレーション (仮想 FK, #2356) のマージ", () => {
  it("foreignKeys: 宣言済みに論理を足し、論理には logical が付く", async () => {
    respond({
      foreign_keys: [
        { table: "a", column: "b_id", referenced_table: "b", referenced_column: "id", constraint_name: "fk" },
      ],
      list_logical_relations: [logical],
    });
    const fks = await schemaCommands.foreignKeys("s", "app");
    expect(fks.map((f) => [f.table, f.column, f.logical ?? false])).toEqual([
      ["a", "b_id", false],
      ["orders", "user_id", true],
    ]);
  });

  it("論理リレーションを読めなくても宣言済み FK だけで返す", async () => {
    respond({
      foreign_keys: [],
      list_logical_relations: () => {
        throw new Error("unknown command");
      },
    });
    expect(await schemaCommands.foreignKeys("s", "app")).toEqual([]);
  });

  it("incomingForeignKeys: 親が対象テーブルの論理リレーションを逆参照として足す", async () => {
    respond({ incoming_foreign_keys: [], list_logical_relations: [logical] });
    expect(await schemaCommands.incomingForeignKeys("s", "app", "users")).toEqual([
      { table: "orders", column: "user_id", referencedColumn: "id", logical: true },
    ]);
    expect(await schemaCommands.incomingForeignKeys("s", "app", "orders")).toEqual([]);
  });

  it("describeTable / describeDatabase: FK の無い列に参照先と logical を載せる", async () => {
    respond({
      describe_table: [column("id", null), column("user_id", null)],
      describe_database: [{ name: "orders", columns: [column("user_id", null)] }],
      list_logical_relations: [logical],
    });
    const cols = await schemaCommands.describeTable("s", "app", "orders");
    expect(cols[1]).toMatchObject({ referenced_table: "users", referenced_column: "id", logical: true });
    expect(cols[0].logical).toBeUndefined();
    const db = await schemaCommands.describeDatabase("s", "app");
    expect(db[0].columns[0]).toMatchObject({ referenced_table: "users", logical: true });
  });

  it("ER 図: マージ後の論理 FK は点線の辺 (logical) になり、列は FK 扱いになる", async () => {
    respond({ foreign_keys: [], list_logical_relations: [logical] });
    const foreignKeys = await schemaCommands.foreignKeys("s", "app");
    const graph = buildErGraph({
      tables: [
        { name: "orders", columns: ["id", "user_id"] },
        { name: "users", columns: ["id"] },
      ],
      foreignKeys,
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: "orders", target: "users", logical: true });
    expect(graph.nodes.find((n) => n.id === "orders")?.data.columns[1].isFk).toBe(true);
  });
});
