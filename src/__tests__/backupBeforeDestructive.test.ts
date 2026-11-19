import { describe, expect, it } from "vitest";
import {
  backupDefaultEnabled,
  backupTableName,
  backupTargetFor,
  backupTimestamp,
  buildBackupPlan,
  buildRestoreSql,
  isBackupTableName,
} from "../backupBeforeDestructive";
import { runBackup, type BackupApi } from "../backupRun";

const NOW = new Date(2026, 10, 19, 9, 5);

const MYSQL_DDL = `CREATE TABLE \`orders\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`price\` int NOT NULL,
  \`total\` int GENERATED ALWAYS AS (\`price\` * 2) STORED,
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`orders_fk\` FOREIGN KEY (\`id\`) REFERENCES \`users\` (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=5;`;
const PG_DDL = `CREATE TABLE "public"."orders" (
  "id" integer NOT NULL,
  PRIMARY KEY ("id")
);`;
const SQLITE_DDL = `CREATE TABLE "orders" (id INTEGER PRIMARY KEY AUTOINCREMENT, price INT)`;

describe("backupTableName", () => {
  it("<table>_bak_<YYYYMMDDHHmm>", () => {
    expect(backupTimestamp(NOW)).toBe("202611190905");
    expect(backupTableName("mysql", "orders", NOW)).toBe("orders_bak_202611190905");
    expect(isBackupTableName("orders_bak_202611190905")).toBe(true);
    expect(isBackupTableName("orders_bak_2026")).toBe(false);
  });
  it("同じ分の既存名と衝突したら連番 (大小無視)", () => {
    expect(backupTableName("sqlite", "t", NOW, ["T_bak_202611190905"])).toBe("t_bak_202611190905_2");
  });
  it("MySQL は 64 文字・PostgreSQL は 63 バイトに収め、タイムスタンプは残す", () => {
    const my = backupTableName("mysql", "a".repeat(80), NOW);
    expect([...my].length).toBe(64);
    expect(my.endsWith("_bak_202611190905")).toBe(true);
    const pg = backupTableName("postgres", "あ".repeat(40), NOW);
    expect(new TextEncoder().encode(pg).length).toBeLessThanOrEqual(63);
    expect(pg.endsWith("_bak_202611190905")).toBe(true);
    expect(pg).not.toContain("�");
  });
  it("本番だけ既定オン", () => {
    expect(backupDefaultEnabled(true)).toBe(true);
    expect(backupDefaultEnabled(false)).toBe(false);
  });
});

describe("buildBackupPlan", () => {
  it("MySQL: LIKE + INSERT SELECT、生成列を除き、FK は写さない", () => {
    const p = buildBackupPlan({
      driver: "mysql",
      database: "shop",
      table: "orders",
      kind: "drop",
      now: NOW,
      ddl: MYSQL_DDL,
      columns: ["id", "price"],
    });
    expect(p.errors).toEqual([]);
    expect(p.statements).toEqual([
      "CREATE TABLE `shop`.`orders_bak_202611190905` LIKE `shop`.`orders`",
      "INSERT INTO `shop`.`orders_bak_202611190905` (`id`, `price`) SELECT `id`, `price` FROM `shop`.`orders`",
    ]);
    expect(p.restoreSql).toBe("ALTER TABLE `shop`.`orders_bak_202611190905` RENAME TO `shop`.`orders`;");
  });
  it("PostgreSQL: LIKE INCLUDING ALL + OVERRIDING SYSTEM VALUE、FK の ALTER は足さない", () => {
    const p = buildBackupPlan({
      driver: "postgres",
      database: "public",
      table: "orders",
      kind: "truncate",
      now: NOW,
      ddl: PG_DDL,
      columns: ["id"],
      pgColumns: { generated: [], identity: ["id"], serial: [] },
    });
    expect(p.errors).toEqual([]);
    expect(p.statements[0]).toBe(
      `CREATE TABLE "public"."orders_bak_202611190905" (LIKE "public"."orders" INCLUDING ALL)`,
    );
    expect(
      p.statements.some((s) => s.startsWith("INSERT INTO") && s.includes("OVERRIDING SYSTEM VALUE")),
    ).toBe(true);
    expect(p.statements.some((s) => s.includes("ADD CONSTRAINT"))).toBe(false);
    expect(p.restoreSql).toBe(
      `INSERT INTO "public"."orders" ("id") OVERRIDING SYSTEM VALUE SELECT "id" FROM "public"."orders_bak_202611190905";`,
    );
  });
  it("PostgreSQL: serial 列は専用シーケンスで退避元と共有しない", () => {
    const p = buildBackupPlan({
      driver: "postgres",
      database: "public",
      table: "orders",
      kind: "drop",
      now: NOW,
      ddl: PG_DDL,
      columns: ["id"],
      pgColumns: { generated: [], identity: [], serial: ["id"] },
    });
    expect(p.statements.some((s) => s.startsWith("CREATE SEQUENCE"))).toBe(true);
  });
  it("SQLite: DDL を新しい名前に書き換え + INSERT SELECT、main は修飾しない", () => {
    const p = buildBackupPlan({
      driver: "sqlite",
      database: "main",
      table: "orders",
      kind: "deleteNoWhere",
      now: NOW,
      ddl: SQLITE_DDL,
      columns: ["id", "price"],
    });
    expect(p.errors).toEqual([]);
    expect(p.statements[0]).toContain('"orders_bak_202611190905"');
    expect(p.statements[0]).not.toContain('CREATE TABLE "orders" ');
    expect(p.statements[1]).toBe(
      'INSERT INTO "orders_bak_202611190905" ("id", "price") SELECT "id", "price" FROM "orders"',
    );
    expect(p.restoreSql).toBe(
      'INSERT INTO "orders" ("id", "price") SELECT "id", "price" FROM "orders_bak_202611190905";',
    );
  });
  it("クオートが必要な名前でも壊れない", () => {
    const p = buildBackupPlan({
      driver: "mysql",
      database: "my db",
      table: "order`s",
      kind: "truncate",
      now: NOW,
      ddl: "CREATE TABLE `order``s` (`id` int)",
      columns: ["id"],
    });
    expect(p.errors).toEqual([]);
    expect(p.statements[0]).toBe("CREATE TABLE `my db`.`order``s_bak_202611190905` LIKE `my db`.`order``s`");
  });
  it("ビューなどテーブルでない DDL は文が空", () => {
    const p = buildBackupPlan({
      driver: "sqlite",
      database: "main",
      table: "v",
      kind: "drop",
      now: NOW,
      ddl: "CREATE VIEW v AS SELECT 1",
      columns: null,
    });
    expect(p.statements).toEqual([]);
  });
});

describe("buildRestoreSql", () => {
  it("DROP の復元: PostgreSQL / SQLite は新しい名前を修飾しない", () => {
    expect(buildRestoreSql("postgres", "s", "t", "t_bak_1", "drop", null)).toBe(
      'ALTER TABLE "s"."t_bak_1" RENAME TO "t";',
    );
    expect(buildRestoreSql("sqlite", "main", "t", "t_bak_1", "drop", null)).toBe(
      'ALTER TABLE "t_bak_1" RENAME TO "t";',
    );
  });
  it("列が取れていなければ SELECT *", () => {
    expect(buildRestoreSql("mysql", "d", "t", "t_bak_1", "truncate", null)).toBe(
      "INSERT INTO `d`.`t` SELECT * FROM `d`.`t_bak_1`;",
    );
  });
});

describe("backupTargetFor", () => {
  it("単一テーブルの DROP / TRUNCATE / WHERE なし DELETE", () => {
    expect(backupTargetFor("DROP TABLE IF EXISTS shop.orders;", "shop.orders", "mysql")).toEqual({
      kind: "drop",
      database: "shop",
      table: "orders",
    });
    expect(backupTargetFor("truncate table `orders`", "orders", "mysql")).toEqual({
      kind: "truncate",
      database: null,
      table: "orders",
    });
    expect(backupTargetFor('DELETE FROM "orders"', "orders", "postgres")?.kind).toBe("deleteNoWhere");
  });
  it("退避だけでは戻しきれない形は対象外", () => {
    expect(backupTargetFor("DROP TABLE a, b", "a", "mysql")).toBeNull();
    expect(backupTargetFor("DROP DATABASE shop", "shop", "mysql")).toBeNull();
    expect(backupTargetFor("TRUNCATE orders CASCADE", "orders", "postgres")).toBeNull();
    expect(backupTargetFor("DELETE FROM t RETURNING id", "t", "postgres")).toBeNull();
    expect(backupTargetFor("DELETE FROM t LIMIT 5", "t", "mysql")).toBeNull();
    expect(backupTargetFor("DROP TABLE t; DROP TABLE u", "t", "mysql")).toBeNull();
    expect(backupTargetFor("DROP TABLE t", null, "mysql")).toBeNull();
  });
});

describe("runBackup", () => {
  const make = (over: Partial<BackupApi> = {}) => {
    const calls: string[][] = [];
    const api = {
      listTables: async () => ["orders"],
      getObjectDefinition: async () => MYSQL_DDL,
      describeTable: async () => [
        { name: "id", extra: "auto_increment" },
        { name: "total", extra: "STORED GENERATED" },
      ],
      runLookupQuery: async () => ({ rows: [] }),
      runQueryTransaction: async (_s: string, stmts: string[]) => {
        calls.push(stmts);
      },
      ...over,
    } as unknown as BackupApi;
    return { api, calls };
  };
  const req = {
    sessionId: "s",
    driver: "mysql",
    database: "shop",
    table: "orders",
    kind: "drop" as const,
    now: NOW,
  };

  it("生成列を除いた退避を書き込み経路で流す", async () => {
    const { api, calls } = make();
    const r = await runBackup(api, req);
    expect(r?.backupName).toBe("orders_bak_202611190905");
    expect(calls[0][1]).toContain("(`id`) SELECT `id` FROM");
  });
  it("テーブルが無ければ何もしない", async () => {
    const { api, calls } = make({ listTables: async () => [] });
    expect(await runBackup(api, req)).toBeNull();
    expect(calls).toEqual([]);
  });
  it("失敗は例外 (本操作を実行させない)。MySQL は残骸の可能性を伝える", async () => {
    let n = 0;
    const { api } = make({
      listTables: async () => (n++ === 0 ? ["orders"] : ["orders", "orders_bak_202611190905"]),
      runQueryTransaction: async () => {
        throw new Error("disk full");
      },
    });
    await expect(runBackup(api, req)).rejects.toThrow(/disk full.*may remain/);
  });
  it("read_only の拒否もそのまま例外になる", async () => {
    const { api } = make({
      runQueryTransaction: async () => {
        throw new Error("read-only");
      },
    });
    await expect(runBackup(api, { ...req, driver: "sqlite", database: "main" })).rejects.toThrow("read-only");
  });
});
