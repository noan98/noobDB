import { describe, expect, it } from "vitest";
import type { LogicalRelationInput, TableColumnInfo } from "../api/tauri";
import {
  applyLogicalToColumns,
  idStem,
  logicalToForeignKeys,
  mergeForeignKeys,
  mergeIncomingForeignKeys,
  relationKey,
  stripLogicalFromColumns,
  suggestLogicalRelations,
  typeFamily,
} from "../logicalRelations";

const rel = (table: string, columns: string[], rt: string, rcols: string[]): LogicalRelationInput => ({
  table,
  columns,
  referenced_table: rt,
  referenced_columns: rcols,
});

const col = (
  name: string,
  data_type = "bigint",
  key = "",
  referenced_table: string | null = null,
): TableColumnInfo => ({
  name,
  data_type,
  nullable: true,
  key,
  default: null,
  extra: "",
  referenced_table,
  referenced_column: referenced_table ? "id" : null,
});

describe("logicalToForeignKeys / mergeForeignKeys", () => {
  it("複合キーを列ごとに展開し、同じ constraint_name で束ねて logical を付ける", () => {
    const fks = logicalToForeignKeys([rel("li", ["order_id", "line"], "orders", ["id", "no"])]);
    expect(fks).toHaveLength(2);
    expect(fks.every((f) => f.logical === true)).toBe(true);
    expect(fks[0].constraint_name).toBe(fks[1].constraint_name);
    expect(fks[1]).toMatchObject({ column: "line", referenced_column: "no" });
  });

  it("宣言済み FK と (子, 列, 親) が同じ論理 FK は落とし、宣言を優先する", () => {
    const declared = [
      {
        table: "o",
        column: "user_id",
        referenced_table: "users",
        referenced_column: "id",
        constraint_name: "fk",
      },
    ];
    const merged = mergeForeignKeys(declared, [
      rel("o", ["user_id"], "users", ["id"]),
      rel("o", ["shop_id"], "shops", ["id"]),
    ]);
    expect(merged.map((f) => [f.column, f.logical ?? false])).toEqual([
      ["user_id", false],
      ["shop_id", true],
    ]);
  });

  it("複合の論理リレーションは、宣言 FK と列を共有していても一部だけ落とさず丸ごと残す", () => {
    const declared = [
      {
        table: "o",
        column: "user_id",
        referenced_table: "users",
        referenced_column: "id",
        constraint_name: "fk_user",
      },
    ];
    const merged = mergeForeignKeys(declared, [
      rel("o", ["tenant_id", "user_id"], "users", ["tenant_id", "id"]),
    ]);
    const logical = merged.filter((f) => f.logical);
    expect(logical.map((f) => [f.column, f.referenced_column])).toEqual([
      ["tenant_id", "tenant_id"],
      ["user_id", "id"],
    ]);
    expect(logical[0].constraint_name).toBe(logical[1].constraint_name);
    expect(merged.filter((f) => !f.logical)).toEqual(declared);
  });

  it("宣言済みの複合 FK と同じ関係 (列の順序違いを含む) なら論理リレーションを丸ごと落とす", () => {
    const declared = [
      {
        table: "o",
        column: "tenant_id",
        referenced_table: "users",
        referenced_column: "tenant_id",
        constraint_name: "fk",
      },
      {
        table: "o",
        column: "user_id",
        referenced_table: "users",
        referenced_column: "id",
        constraint_name: "fk",
      },
    ];
    expect(
      mergeForeignKeys(declared, [rel("o", ["user_id", "tenant_id"], "users", ["id", "tenant_id"])]),
    ).toEqual(declared);
    // 参照先の列が違えば別の関係として残す。
    const other = mergeForeignKeys(declared, [rel("o", ["user_id"], "users", ["legacy_id"])]);
    expect(other.filter((f) => f.logical)).toHaveLength(1);
  });

  it("論理リレーションが無ければ宣言をそのまま返す", () => {
    expect(mergeForeignKeys([], [])).toEqual([]);
  });
});

describe("mergeIncomingForeignKeys", () => {
  it("親が対象テーブルの論理リレーションだけを逆参照として足す", () => {
    const out = mergeIncomingForeignKeys(
      [{ table: "a", column: "u", referencedColumn: "id" }],
      [rel("o", ["user_id"], "users", ["id"]), rel("o", ["shop_id"], "shops", ["id"])],
      "users",
    );
    expect(out).toEqual([
      { table: "a", column: "u", referencedColumn: "id" },
      { table: "o", column: "user_id", referencedColumn: "id", logical: true },
    ]);
  });

  it("宣言済みの逆参照と同じものは重複させない", () => {
    const declared = [{ table: "o", column: "user_id", referencedColumn: "id" }];
    expect(mergeIncomingForeignKeys(declared, [rel("o", ["user_id"], "users", ["id"])], "users")).toEqual(
      declared,
    );
  });
});

describe("applyLogicalToColumns", () => {
  it("FK を持たない列に参照先と logical を載せ、宣言 FK の列は変えない", () => {
    const cols = [col("id"), col("user_id"), col("shop_id", "bigint", "MUL", "shops")];
    const out = applyLogicalToColumns("o", cols, [
      rel("o", ["user_id"], "users", ["id"]),
      rel("o", ["shop_id"], "other", ["id"]),
      rel("x", ["id"], "y", ["id"]),
    ]);
    expect(out[0]).toBe(cols[0]);
    expect(out[1]).toMatchObject({ referenced_table: "users", referenced_column: "id", logical: true });
    expect(out[2].referenced_table).toBe("shops");
    expect(out[2].logical).toBeUndefined();
  });

  it("該当が無ければ同じ配列を返す", () => {
    const cols = [col("id")];
    expect(applyLogicalToColumns("o", cols, [rel("x", ["a"], "y", ["id"])])).toBe(cols);
  });
});

describe("idStem / typeFamily", () => {
  it("<名前>_id と <名前>Id の語幹を取り出す", () => {
    expect(idStem("user_id")).toBe("user");
    expect(idStem("USER_ID")).toBe("USER");
    expect(idStem("userId")).toBe("user");
    expect(idStem("userID")).toBe("user");
    expect(idStem("parent_user_id")).toBe("parent_user");
    expect(idStem("id")).toBeNull();
    expect(idStem("_id")).toBeNull();
    expect(idStem("paid")).toBeNull();
    expect(idStem("Id")).toBeNull();
  });

  it("型の族で長さ・符号・別名の違いを無視する", () => {
    expect(typeFamily("bigint(20) unsigned")).toBe("int");
    expect(typeFamily("integer")).toBe("int");
    expect(typeFamily("character varying(255)")).toBe("text");
    expect(typeFamily("uuid")).toBe("uuid");
    expect(typeFamily("timestamp without time zone")).toBe("timestamp");
  });
});

describe("suggestLogicalRelations", () => {
  const users = { name: "users", columns: [col("id", "bigint", "PRI"), col("name", "varchar(20)")] };
  const categories = { name: "categories", columns: [col("id", "int", "PRI")] };

  it("<名前>_id / <名前>Id を単数・複数の表名の単一主キーへ結び付ける", () => {
    const orders = {
      name: "orders",
      columns: [
        col("id", "bigint", "PRI"),
        col("user_id"),
        col("categoryId", "integer"),
        col("note", "text"),
      ],
    };
    const out = suggestLogicalRelations([orders, users, categories], []);
    expect(
      out.map((c) => [c.table, c.columns[0], c.referenced_table, c.referenced_columns[0], c.via]),
    ).toEqual([
      ["orders", "user_id", "users", "id", "exact"],
      ["orders", "categoryId", "categories", "id", "exact"],
    ]);
  });

  it("型が違う・自己参照・既に FK がある列・主キーが複合の親は出さない", () => {
    const orders = {
      name: "orders",
      columns: [
        col("user_id", "varchar(10)"),
        col("shop_id"),
        col("order_id"),
        col("team_id", "bigint", "", "teams"),
      ],
    };
    const shops = { name: "shops", columns: [col("a", "bigint", "PRI"), col("b", "bigint", "PRI")] };
    expect(
      suggestLogicalRelations(
        [orders, users, shops, { name: "teams", columns: [col("id", "bigint", "PRI")] }],
        [],
      ),
    ).toEqual([]);
  });

  it("登録済み (existing) の列は出さない", () => {
    const orders = { name: "orders", columns: [col("user_id")] };
    expect(suggestLogicalRelations([orders, users], [{ table: "orders", column: "user_id" }])).toEqual([]);
  });

  it("全体の語幹で一致しないときは末尾の語で探し suffix と示す", () => {
    const orders = { name: "orders", columns: [col("owner_user_id")] };
    const out = suggestLogicalRelations([orders, users], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ referenced_table: "users", via: "suffix" });
  });

  it("y で終わる語の複数形 (category → categories) と snake の表名を扱う", () => {
    const t = { name: "post_tags", columns: [col("post_tag_id", "bigint")] };
    const postTags = { name: "post_tags", columns: [col("id", "bigint", "PRI")] };
    // 自分自身の表への参照は出さない
    expect(suggestLogicalRelations([t, users], [])).toEqual([]);
    const c = { name: "items", columns: [col("post_tag_id")] };
    expect(suggestLogicalRelations([c, postTags], [])[0]?.referenced_table).toBe("post_tags");
  });
});

describe("relationKey", () => {
  it("複合キーの列順が違えば別のキーになる", () => {
    expect(relationKey(rel("a", ["x", "y"], "b", ["x", "y"]))).not.toBe(
      relationKey(rel("a", ["y", "x"], "b", ["x", "y"])),
    );
  });
});

describe("stripLogicalFromColumns", () => {
  it("論理で載せた参照先だけを外し、宣言 FK の列は残す", () => {
    const cols = [col("id"), col("user_id"), col("shop_id", "bigint", "MUL", "shops")];
    const withLogical = applyLogicalToColumns("o", cols, [rel("o", ["user_id"], "users", ["id"])]);
    const stripped = stripLogicalFromColumns(withLogical);
    expect(stripped[1]).toMatchObject({ referenced_table: null, referenced_column: null });
    expect(stripped[1].logical).toBeUndefined();
    expect(stripped[2].referenced_table).toBe("shops");
    expect(stripLogicalFromColumns(cols)).toBe(cols);
  });
});
