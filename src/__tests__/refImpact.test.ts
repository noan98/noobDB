import { describe, expect, it } from "vitest";
import type { CellValue } from "../api/tauri";
import type { IncomingFk } from "../fkNavigation";
import {
  blocksDelete,
  buildOpenChildrenSql,
  buildRefCountSqls,
  collectDeletedKeyValues,
  loadRefImpacts,
  normalizeOnDelete,
  REF_KEY_LIMIT,
  sumRefCounts,
} from "../refImpact";

const refs: IncomingFk[] = [
  { table: "orders", column: "user_id", referencedColumn: "id", onDelete: "CASCADE" },
  { table: "logs", column: "user_id", referencedColumn: "id" },
];

describe("normalizeOnDelete", () => {
  it("未指定・NO ACTION は NO ACTION、既知の規則は大文字に揃える", () => {
    expect(normalizeOnDelete(null)).toBe("NO ACTION");
    expect(normalizeOnDelete(undefined)).toBe("NO ACTION");
    expect(normalizeOnDelete("set null")).toBe("SET NULL");
    expect(normalizeOnDelete("cascade")).toBe("CASCADE");
    expect(normalizeOnDelete("weird")).toBe("NO ACTION");
  });
  it("RESTRICT / NO ACTION は削除をブロックする", () => {
    expect(blocksDelete("RESTRICT")).toBe(true);
    expect(blocksDelete("NO ACTION")).toBe(true);
    expect(blocksDelete("CASCADE")).toBe(false);
    expect(blocksDelete("SET NULL")).toBe(false);
  });
});

describe("collectDeletedKeyValues", () => {
  const columns = [{ name: "id" }, { name: "name" }];
  const rows: CellValue[][] = [
    [1, "a"],
    [2, "b"],
    [3, null],
    [null, "x"],
  ];
  it("削除予定の行の参照先列の値だけを、NULL と重複を除いて集める", () => {
    const { keys, partial } = collectDeletedKeyValues({
      columns,
      rows: [...rows, [1, "dup"]],
      pkIndices: [],
      // pk 無しは行番号キー (i<index>)
      deleteKeys: new Set(["i0", "i1", "i3", "i4"]),
      referencedColumns: ["id", "missing"],
    });
    expect(keys.get("id")).toEqual([1, 2]);
    expect(keys.has("missing")).toBe(false);
    expect(partial).toBe(true);
  });
  it("上限を超えたら打ち切って partial にする", () => {
    const big: CellValue[][] = Array.from({ length: REF_KEY_LIMIT + 5 }, (_, i) => [i]);
    const { keys, partial } = collectDeletedKeyValues({
      columns: [{ name: "id" }],
      rows: big,
      pkIndices: [],
      deleteKeys: new Set(big.map((_, i) => `i${i}`)),
      referencedColumns: ["id"],
    });
    expect(keys.get("id")).toHaveLength(REF_KEY_LIMIT);
    expect(partial).toBe(true);
  });
});

describe("buildRefCountSqls", () => {
  const keys = new Map<string, CellValue[]>([["id", [1, "it's"]]]);
  it("MySQL: 子テーブルごとの COUNT を UNION ALL で 1 本にまとめる", () => {
    const [sql, ...rest] = buildRefCountSqls({ driver: "mysql", database: "app", refs, keys });
    expect(rest).toHaveLength(0);
    expect(sql).toBe(
      "SELECT 0 AS i, COUNT(*) AS n FROM `app`.`orders` WHERE `user_id` IN (1, 'it''s')" +
        " UNION ALL SELECT 1 AS i, COUNT(*) AS n FROM `app`.`logs` WHERE `user_id` IN (1, 'it''s')",
    );
  });
  it("PostgreSQL / SQLite の引用符・修飾", () => {
    const [pg] = buildRefCountSqls({ driver: "postgres", database: "public", refs: [refs[0]], keys });
    expect(pg).toContain('FROM "public"."orders" WHERE "user_id" IN (1, ');
    const [lite] = buildRefCountSqls({ driver: "sqlite", database: "main", refs: [refs[0]], keys });
    expect(lite).toContain('FROM "orders" WHERE "user_id" IN (1, ');
  });
  it("TRUNCATE (keys=null) は子の FK 列が NULL でない行を数える", () => {
    const [sql] = buildRefCountSqls({ driver: "mysql", database: "app", refs: [refs[0]], keys: null });
    expect(sql).toBe(
      "SELECT 0 AS i, COUNT(*) AS n FROM (SELECT 1 AS o FROM `app`.`orders` WHERE `user_id` IS NOT NULL LIMIT 1001) AS c",
    );
  });
  it("値が無い FK は枝を作らず、IN は 500 件ごとに分ける", () => {
    expect(buildRefCountSqls({ driver: "mysql", database: "a", refs, keys: new Map() })).toEqual([]);
    const many = new Map<string, CellValue[]>([["id", Array.from({ length: 1200 }, (_, i) => i)]]);
    const [sql] = buildRefCountSqls({ driver: "mysql", database: "a", refs: [refs[0]], keys: many });
    expect(sql.split(" UNION ALL ")).toHaveLength(3);
  });
  it("枝が 100 を超えたら複数クエリに分ける", () => {
    const wide = Array.from({ length: 150 }, (_, i) => ({
      table: `c${i}`,
      column: "p",
      referencedColumn: "id",
    }));
    const sqls = buildRefCountSqls({
      driver: "mysql",
      database: "a",
      refs: wide,
      keys: new Map([["id", [1]]]),
    });
    expect(sqls).toHaveLength(2);
  });
});

describe("列型に合わせたリテラル化", () => {
  const ref = [{ table: "child", column: "pid", referencedColumn: "id" }];
  it("バイナリ列は hex を blob リテラルにする (ドライバ別)", () => {
    const keys = new Map<string, CellValue[]>([["id", ["00ff10"]]]);
    const types = new Map([["id", "BINARY"]]);
    const mysql = buildRefCountSqls({ driver: "mysql", database: "a", refs: ref, keys, types })[0];
    expect(mysql).toContain("IN (0x00ff10)");
    const pg = buildRefCountSqls({
      driver: "postgres",
      database: "p",
      refs: ref,
      keys,
      types: new Map([["id", "BYTEA"]]),
    })[0];
    expect(pg).toContain("IN ('\\x00ff10')");
    const lite = buildRefCountSqls({
      driver: "sqlite",
      database: "m",
      refs: ref,
      keys,
      types: new Map([["id", "BLOB"]]),
    })[0];
    expect(lite).toContain("IN (X'00ff10')");
  });
  it("安全整数を超える BIGINT 文字列は引用しない (MySQL の double 比較を避ける)", () => {
    const keys = new Map<string, CellValue[]>([["id", ["9007199254740993"]]]);
    const types = new Map([["id", "BIGINT"]]);
    const [sql] = buildRefCountSqls({ driver: "mysql", database: "a", refs: ref, keys, types });
    expect(sql).toContain("IN (9007199254740993)");
    expect(buildOpenChildrenSql({ driver: "mysql", database: "a", impact: ref[0], keys, types })).toContain(
      "IN (9007199254740993)",
    );
  });
  it("collectDeletedKeyValues は参照先列の型を返し、結果に無い列は partial にする", () => {
    const out = collectDeletedKeyValues({
      columns: [{ name: "id", type_name: "BIGINT" }],
      rows: [["9007199254740993"]],
      pkIndices: [],
      deleteKeys: new Set(["i0"]),
      referencedColumns: ["id", "code"],
    });
    expect(out.types.get("id")).toBe("BIGINT");
    expect(out.unresolved).toEqual(["code"]);
    expect(out.partial).toBe(true);
  });
  it("TRUNCATE は 1000 を超えたら capped にして件数を 1000 に丸める", async () => {
    const impacts = await loadRefImpacts({
      driver: "mysql",
      database: "a",
      refs: ref,
      keys: null,
      lookup: async () => ({ rows: [[0, 1001]] }),
    });
    expect(impacts[0]).toMatchObject({ count: 1000, capped: true });
  });
});

describe("sumRefCounts / loadRefImpacts", () => {
  it("同じ FK の複数枝を合計し、文字列の数値も受ける", () => {
    const totals = sumRefCounts([
      {
        rows: [
          [0, 2],
          [1, "3"],
        ],
      },
      { rows: [[0, 5]] },
    ]);
    expect(totals.get(0)).toBe(7);
    expect(totals.get(1)).toBe(3);
  });
  it("0 件の子テーブルは落とし、ON DELETE を正規化して返す", async () => {
    const calls: string[] = [];
    const impacts = await loadRefImpacts({
      driver: "mysql",
      database: "app",
      refs,
      keys: new Map([["id", [1]]]),
      parentTable: "users",
      lookup: async (sql) => {
        calls.push(sql);
        return {
          rows: [
            [0, 4],
            [1, 0],
          ],
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(impacts).toEqual([
      {
        parentTable: "users",
        table: "orders",
        column: "user_id",
        referencedColumn: "id",
        onDelete: "CASCADE",
        count: 4,
      },
    ]);
  });
  it("参照が無ければクエリを発行しない", async () => {
    let called = false;
    const impacts = await loadRefImpacts({
      driver: "mysql",
      database: "app",
      refs: [],
      keys: null,
      lookup: async () => {
        called = true;
        return { rows: [] };
      },
    });
    expect(impacts).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("buildOpenChildrenSql", () => {
  const impact = { table: "orders", column: "user_id", referencedColumn: "id" };
  it("削除対象の値で子行を絞る / TRUNCATE は NULL 以外", () => {
    const keys = new Map<string, CellValue[]>([["id", [1, 2]]]);
    expect(buildOpenChildrenSql({ driver: "postgres", database: "public", impact, keys })).toBe(
      'SELECT * FROM "public"."orders" WHERE "user_id" IN (1, 2)',
    );
    expect(buildOpenChildrenSql({ driver: "sqlite", database: "main", impact, keys: null })).toBe(
      'SELECT * FROM "orders" WHERE "user_id" IS NOT NULL',
    );
  });
});
