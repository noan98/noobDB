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
import { resolveBackupDatabase, runBackup, type BackupApi } from "../backupRun";

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
  it("SQLite: インライン FK と制約の FK を退避先から落とす (CASCADE で退避の行が消えない)", () => {
    const ddl = `CREATE TABLE "orders" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INT NOT NULL CONSTRAINT fk_u REFERENCES users(id) ON DELETE CASCADE ON UPDATE SET NULL DEFERRABLE INITIALLY DEFERRED,
  parent_id INT REFERENCES orders (id),
  note TEXT DEFAULT 'a, REFERENCES x',
  CONSTRAINT fk_p FOREIGN KEY (parent_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`;
    const p = buildBackupPlan({
      driver: "sqlite",
      database: "main",
      table: "orders",
      kind: "drop",
      now: NOW,
      ddl,
      columns: ["id", "user_id", "parent_id", "note"],
    });
    expect(p.errors).toEqual([]);
    const create = p.statements[0];
    expect(create).not.toMatch(/FOREIGN|CONSTRAINT|ON DELETE|DEFERR/i);
    expect(create.replace(/'a, REFERENCES x'/, "")).not.toMatch(/REFERENCES/i);
    expect(create).toContain("'a, REFERENCES x'");
    expect(create).toContain("user_id INT NOT NULL");
    expect(create).toContain("parent_id INT");
  });
  it("SQLite: NOT NULL は残し、NOT DEFERRABLE と複数の REFERENCES を落とす", () => {
    const ddl = `CREATE TABLE t (
  a INT NOT NULL REFERENCES p(id) NOT DEFERRABLE INITIALLY IMMEDIATE,
  b INT REFERENCES p(id) REFERENCES q(id) NOT NULL,
  c INT
)`;
    const p = buildBackupPlan({
      driver: "sqlite",
      database: "main",
      table: "t",
      kind: "drop",
      now: NOW,
      ddl,
      columns: ["a", "b", "c"],
    });
    const create = p.statements[0];
    expect(create).not.toMatch(/REFERENCES|DEFERRABLE|INITIALLY/i);
    expect(create).toMatch(/a INT NOT NULL/);
    expect(create).toMatch(/b INT\s+NOT NULL/);
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
    expect(backupTargetFor("DROP TABLE IF EXISTS shop.orders;", "mysql")).toEqual({
      kind: "drop",
      database: "shop",
      table: "orders",
      ifExists: true,
    });
    expect(backupTargetFor("truncate table `orders`", "mysql")).toEqual({
      kind: "truncate",
      database: null,
      table: "orders",
      ifExists: false,
    });
    expect(backupTargetFor('DELETE FROM "orders"', "postgres")?.kind).toBe("deleteNoWhere");
    expect(backupTargetFor("  /* c */ DROP TABLE t -- x\n;", "sqlite")?.table).toBe("t");
  });
  it("PostgreSQL は引用符なしを小文字に畳み、引用符付きは保つ", () => {
    expect(backupTargetFor("DROP TABLE Users", "postgres")?.table).toBe("users");
    expect(backupTargetFor('DROP TABLE "Users"', "postgres")?.table).toBe("Users");
    expect(backupTargetFor('DROP TABLE Public."Users"', "postgres")).toMatchObject({
      database: "public",
      table: "Users",
    });
    // MySQL / SQLite は畳まない (実在名との照合は大小無視)
    expect(backupTargetFor("DROP TABLE Users", "mysql")?.table).toBe("Users");
  });
  it('引用符内の . や "" エスケープを正しく扱う', () => {
    expect(backupTargetFor('DROP TABLE "my.table"', "postgres")).toMatchObject({
      database: null,
      table: "my.table",
    });
    expect(backupTargetFor('DROP TABLE "Odd""Name"', "postgres")?.table).toBe('Odd"Name');
    expect(backupTargetFor("DROP TABLE `a``b`.`c.d`", "mysql")).toMatchObject({
      database: "a`b",
      table: "c.d",
    });
    // MySQL の "..." は文字列であって識別子ではない
    expect(backupTargetFor('DROP TABLE "t"', "mysql")).toBeNull();
  });
  it("退避だけでは戻しきれない形は対象外", () => {
    expect(backupTargetFor("DROP TABLE a, b", "mysql")).toBeNull();
    expect(backupTargetFor("DROP DATABASE shop", "mysql")).toBeNull();
    expect(backupTargetFor("TRUNCATE orders CASCADE", "postgres")).toBeNull();
    expect(backupTargetFor("DELETE FROM t RETURNING id", "postgres")).toBeNull();
    expect(backupTargetFor("DELETE FROM t LIMIT 5", "mysql")).toBeNull();
    expect(backupTargetFor("DROP TABLE t; DROP TABLE u", "mysql")).toBeNull();
    expect(backupTargetFor("DROP TABLE a.b.c", "postgres")).toBeNull();
  });
});

describe("resolveBackupDatabase", () => {
  const base = { sessionId: "s", table: "users", explicit: null, tabDatabase: null, profileDatabase: null };
  it("文にスキーマがあればそのまま", async () => {
    expect(await resolveBackupDatabase({} as BackupApi, { ...base, driver: "postgres", explicit: "x" })).toBe(
      "x",
    );
  });
  it("PostgreSQL: to_regclass で実体のスキーマを引く (public 決め打ちにしない)", async () => {
    let sql = "";
    const api = {
      runLookupQuery: async (p: { sql: string }) => {
        sql = p.sql;
        return { rows: [["app"]] };
      },
    } as unknown as BackupApi;
    expect(await resolveBackupDatabase(api, { ...base, driver: "postgres", table: "Odd'N" })).toBe("app");
    expect(sql).toContain("to_regclass('\"Odd''N\"')");
  });
  it("PostgreSQL: 見つからなければ null (オプションを出さない)", async () => {
    const api = { runLookupQuery: async () => ({ rows: [] }) } as unknown as BackupApi;
    expect(await resolveBackupDatabase(api, { ...base, driver: "postgres" })).toBeNull();
  });
  it("MySQL: タブ → 接続の既定、無ければ null", async () => {
    const api = {} as BackupApi;
    expect(
      await resolveBackupDatabase(api, { ...base, driver: "mysql", tabDatabase: "t", profileDatabase: "p" }),
    ).toBe("t");
    expect(await resolveBackupDatabase(api, { ...base, driver: "mysql", profileDatabase: "p" })).toBe("p");
    expect(await resolveBackupDatabase(api, { ...base, driver: "mysql" })).toBeNull();
  });
  it("SQLite: temp → main → ATTACH の順に最初に見つかった場所 (タブの選択は見ない)", async () => {
    const mk = (where: Record<string, boolean>, dbs: string[]) =>
      ({
        runLookupQuery: async (p: { sql: string }) => {
          if (p.sql.includes("pragma_database_list")) return { rows: dbs.map((d) => [d]) };
          const m = /FROM "([^"]+)"\.sqlite_master/.exec(p.sql);
          return { rows: where[m?.[1] ?? ""] ? [[1]] : [] };
        },
      }) as unknown as BackupApi;
    const sq = { ...base, driver: "sqlite", tabDatabase: "att" };
    expect(await resolveBackupDatabase(mk({ main: true }, ["main", "att"]), sq)).toBe("main");
    expect(await resolveBackupDatabase(mk({ att: true }, ["main", "att"]), sq)).toBe("att");
    expect(await resolveBackupDatabase(mk({ main: true, att: true }, ["att", "main"]), sq)).toBe("main");
    // temp に同名があれば、それが先に解決される (別接続から見えない) ので退避しない
    expect(await resolveBackupDatabase(mk({ temp: true, main: true }, ["main"]), sq)).toBeNull();
    expect(await resolveBackupDatabase(mk({}, ["main"]), sq)).toBeNull();
    expect(await resolveBackupDatabase(mk({}, []), { ...sq, explicit: "temp" })).toBeNull();
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
  it("テーブルが見つからなければエラーで中止 (退避なしで続行しない)", async () => {
    const { api, calls } = make({ listTables: async () => [] });
    await expect(runBackup(api, req)).rejects.toThrow(/orders/);
    expect(calls).toEqual([]);
  });
  it("missingOk (DROP TABLE IF EXISTS) のときだけ、表が無くても null で続行", async () => {
    const { api, calls } = make({ listTables: async () => [] });
    expect(await runBackup(api, { ...req, missingOk: true })).toBeNull();
    expect(calls).toEqual([]);
  });
  it("MySQL / SQLite は大文字小文字を無視して実在の綴りで退避する", async () => {
    const { api, calls } = make({ listTables: async () => ["ORDERS"] });
    const r = await runBackup(api, req);
    expect(r?.backupName).toBe("ORDERS_bak_202611190905");
    expect(calls[0][0]).toContain("`ORDERS`");
  });
  it("MySQL: Users と users が併存しても、完全一致の表を退避する", async () => {
    const { api, calls } = make({ listTables: async () => ["Users", "users"] });
    const r = await runBackup(api, { ...req, table: "users" });
    expect(r?.backupName).toBe("users_bak_202611190905");
    expect(calls[0][1]).toContain("FROM `shop`.`users`");
    const r2 = await runBackup(api, { ...req, table: "Users" });
    expect(r2?.backupName).toBe("Users_bak_202611190905");
  });
  it("PostgreSQL は大文字小文字を区別する (別の表を退避しない)", async () => {
    const { api } = make({ listTables: async () => ["Orders"] });
    await expect(runBackup(api, { ...req, driver: "postgres", database: "public" })).rejects.toThrow();
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
