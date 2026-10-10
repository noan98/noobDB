import { describe, it, expect } from "vitest";
import {
  buildCloneStatements,
  buildPgColumnFlagsSql,
  buildPgForeignKeysSql,
  parsePgColumnFlags,
  parsePgForeignKeys,
  cloneObjectName,
  formatCloneStatements,
  insertableColumns,
  isPartialCloneFailure,
  suggestCloneName,
} from "../tableClone";

const MYSQL_DDL = `CREATE TABLE \`orders\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`user_id\` int DEFAULT NULL,
  \`parent_id\` int DEFAULT NULL,
  \`note\` varchar(20) DEFAULT 'a;b -- not a comment',
  PRIMARY KEY (\`id\`),
  KEY \`user_id\` (\`user_id\`),
  CONSTRAINT \`orders_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`),
  CONSTRAINT \`orders_parent\` FOREIGN KEY (\`parent_id\`) REFERENCES \`orders\` (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4;
`;

const PG_DDL = `-- Reconstructed by noobDB from catalog metadata (best-effort).
-- Review before running.
CREATE TABLE "public"."orders" (
  "id" integer NOT NULL,
  "user_id" integer,
  PRIMARY KEY ("id"),
  CONSTRAINT "orders_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
);

CREATE UNIQUE INDEX "orders_user_idx" ON "public"."orders" ("user_id");

CREATE INDEX "by_id" ON "public"."orders" USING hash ("id");
`;

const SQLITE_DDL = `CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES "users"(id),
  CONSTRAINT chk CHECK (id > 0)
);

CREATE INDEX idx_orders_user ON orders (user_id);
`;

describe("buildCloneStatements (#1398)", () => {
  it("MySQL: 名前差し替え・FK 名の衝突回避・自己参照 FK・AUTO_INCREMENT 除去", () => {
    const r = buildCloneStatements({
      driver: "mysql",
      database: "shop",
      sourceTable: "orders",
      newTable: "orders_copy",
      ddl: MYSQL_DDL,
      includeData: false,
    });
    expect(r.statements).toHaveLength(1);
    const sql = r.statements[0];
    expect(sql.startsWith("CREATE TABLE `shop`.`orders_copy` (")).toBe(true);
    expect(sql).toContain("CONSTRAINT `orders_copy_ibfk_1` FOREIGN KEY");
    expect(sql).toContain("CONSTRAINT `orders_copy_parent` FOREIGN KEY (`parent_id`) REFERENCES `shop`.`orders_copy` (`id`)");
    expect(sql).toContain("REFERENCES `users` (`id`)");
    // 列定義の AUTO_INCREMENT は残り、テーブルオプションだけが消える
    expect(sql).toContain("`id` int NOT NULL AUTO_INCREMENT,");
    expect(sql).not.toContain("AUTO_INCREMENT=42");
    expect(sql).toContain("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // インデックス名 (KEY) はテーブル内一意なので変えない / 文字列リテラル内の ; -- は保持
    expect(sql).toContain("KEY `user_id` (`user_id`)");
    expect(sql).toContain("'a;b -- not a comment'");
    expect(sql.endsWith(";")).toBe(false);
  });

  it("PostgreSQL: LIKE INCLUDING ALL で写し、FK は pg_get_constraintdef から ALTER (名前衝突回避・参照アクション保持)", () => {
    const r = buildCloneStatements({
      driver: "postgres", database: "public", sourceTable: "orders", newTable: "orders_copy",
      ddl: PG_DDL, includeData: false,
      pgForeignKeys: parsePgForeignKeys([
        ["orders_user_fk", 'FOREIGN KEY (user_id) REFERENCES other.users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED'],
      ]),
    });
    expect(r.statements).toEqual([
      'CREATE TABLE "public"."orders_copy" (LIKE "public"."orders" INCLUDING ALL)',
      'ALTER TABLE "public"."orders_copy" ADD CONSTRAINT "orders_copy_user_fk" FOREIGN KEY (user_id) REFERENCES other.users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
    ]);
  });

  it("PostgreSQL: 自己参照 FK は修飾付き/無しどちらでも新テーブルへ、別スキーマの同名は付け替えない", () => {
    const r = buildCloneStatements({
      driver: "postgres", database: "public", sourceTable: "orders", newTable: "o2",
      ddl: PG_DDL, includeData: false,
      pgForeignKeys: [
        { name: "a", def: "FOREIGN KEY (p) REFERENCES orders(id)" },
        { name: "b", def: "FOREIGN KEY (p) REFERENCES public.orders(id) ON UPDATE CASCADE" },
        { name: "c", def: "FOREIGN KEY (q) REFERENCES other.orders(id)" },
      ],
    });
    expect(r.statements.slice(1)).toEqual([
      'ALTER TABLE "public"."o2" ADD CONSTRAINT "a_o2" FOREIGN KEY (p) REFERENCES "public"."o2"(id)',
      'ALTER TABLE "public"."o2" ADD CONSTRAINT "b_o2" FOREIGN KEY (p) REFERENCES "public"."o2"(id) ON UPDATE CASCADE',
      'ALTER TABLE "public"."o2" ADD CONSTRAINT "c_o2" FOREIGN KEY (q) REFERENCES other.orders(id)',
    ]);
  });

  it("PostgreSQL: データ込みは INSERT → identity/serial の setval → FK の順、serial は専用シーケンスに付け替える", () => {
    const r = buildCloneStatements({
      driver: "postgres", database: "public", sourceTable: "orders", newTable: "o2",
      ddl: PG_DDL, includeData: true,
      columns: ["id", "n", "user_id"],
      pgColumns: { generated: [], identity: ["id"], serial: ["n"] },
      pgForeignKeys: [{ name: "fk", def: "FOREIGN KEY (user_id) REFERENCES users(id)" }],
    });
    expect(r.statements).toEqual([
      'CREATE TABLE "public"."o2" (LIKE "public"."orders" INCLUDING ALL)',
      'CREATE SEQUENCE "public"."o2_n_seq" OWNED BY "public"."o2"."n"',
      `ALTER TABLE "public"."o2" ALTER COLUMN "n" SET DEFAULT nextval('"public"."o2_n_seq"'::regclass)`,
      'INSERT INTO "public"."o2" ("id", "n", "user_id") OVERRIDING SYSTEM VALUE SELECT "id", "n", "user_id" FROM "public"."orders"',
      `SELECT setval(pg_get_serial_sequence('"public"."o2"', 'id'), max("id")) FROM "public"."o2" HAVING max("id") IS NOT NULL`,
      `SELECT setval(pg_get_serial_sequence('"public"."o2"', 'n'), max("n")) FROM "public"."o2" HAVING max("n") IS NOT NULL`,
      'ALTER TABLE "public"."o2" ADD CONSTRAINT "fk_o2" FOREIGN KEY (user_id) REFERENCES users(id)',
    ]);
    expect(r.errors).toEqual([]);
    expect(r.sharedSequence).toBe(false);
  });

  it("PostgreSQL: データ無しなら setval は出さない / 列種別が無く nextval があれば共有注意", () => {
    const base = { driver: "postgres", database: "public", sourceTable: "orders", newTable: "o2" };
    const noData = buildCloneStatements({
      ...base, ddl: PG_DDL, includeData: false, pgColumns: { generated: [], identity: ["id"], serial: [] },
    });
    expect(noData.statements).toHaveLength(1);
    const shared = buildCloneStatements({
      ...base, includeData: false,
      ddl: PG_DDL.replace('"id" integer NOT NULL', `"id" integer NOT NULL DEFAULT nextval('orders_id_seq'::regclass)`),
    });
    expect(shared.sharedSequence).toBe(true);
  });

  it("PostgreSQL のメタ取得クエリはリテラルをエスケープし、結果行を分類する", () => {
    expect(buildPgColumnFlagsSql("s'x", "t")).toContain("table_schema = 's''x' AND table_name = 't'");
    expect(buildPgForeignKeysSql("my s", 'ta"b')).toContain(`to_regclass('"my s"."ta""b"')`);
    expect(
      parsePgColumnFlags([
        ["a", "NEVER", "YES", null],
        ["b", "NEVER", "NO", "nextval('b_seq'::regclass)"],
        ["g", "ALWAYS", "NO", null],
        ["c", "NEVER", "NO", "now()"],
      ]),
    ).toEqual({ generated: ["g"], identity: ["a"], serial: ["b"] });
  });

  it("MySQL: データ込みでは自己参照 FK を CREATE から外して INSERT の後に ALTER で付ける", () => {
    const withData = buildCloneStatements({
      driver: "mysql", database: "shop", sourceTable: "orders", newTable: "orders_copy",
      ddl: MYSQL_DDL, includeData: true,
    });
    expect(withData.statements[0]).not.toContain("orders_parent");
    expect(withData.statements[0]).toContain("CONSTRAINT `orders_copy_ibfk_1` FOREIGN KEY");
    expect(withData.statements[1]).toMatch(/^INSERT INTO/);
    expect(withData.statements[2]).toBe(
      "ALTER TABLE `shop`.`orders_copy` ADD CONSTRAINT `orders_copy_parent` FOREIGN KEY (`parent_id`) REFERENCES `shop`.`orders_copy` (`id`)",
    );
    // データ無しなら従来どおり CREATE 内に残す
    const noData = buildCloneStatements({
      driver: "mysql", database: "shop", sourceTable: "orders", newTable: "orders_copy",
      ddl: MYSQL_DDL, includeData: false,
    });
    expect(noData.statements).toHaveLength(1);
    expect(noData.statements[0]).toContain("orders_copy_parent");
  });

  it("SQLite: テーブル名はスキーマ修飾なし、インデックス名のみ改名、CONSTRAINT 名は据え置き", () => {
    const r = buildCloneStatements({
      driver: "sqlite",
      database: "main",
      sourceTable: "orders",
      newTable: "orders_copy",
      ddl: SQLITE_DDL,
      includeData: true,
    });
    expect(r.statements[0].startsWith('CREATE TABLE "orders_copy" (')).toBe(true);
    expect(r.statements[0]).toContain("CONSTRAINT chk CHECK");
    expect(r.statements[1]).toBe('CREATE INDEX "idx_orders_copy_user" ON "orders_copy" (user_id)');
    expect(r.statements[2]).toBe('INSERT INTO "orders_copy" SELECT * FROM "orders"');
  });

  it("includeData は MySQL/PostgreSQL では修飾付きの INSERT ... SELECT を末尾に足す", () => {
    const my = buildCloneStatements({
      driver: "mysql", database: "shop", sourceTable: "orders", newTable: "o2", ddl: MYSQL_DDL, includeData: true,
    });
    expect(my.statements.find((x) => x.startsWith("INSERT"))).toBe("INSERT INTO `shop`.`o2` SELECT * FROM `shop`.`orders`");
    const pg = buildCloneStatements({
      driver: "postgres", database: "public", sourceTable: "orders", newTable: "o2", ddl: PG_DDL, includeData: true,
    });
    expect(pg.statements[1]).toBe('INSERT INTO "public"."o2" SELECT * FROM "public"."orders"');
  });

  it("MySQL: バージョン付きコメント (/*!...*/) は保持し、通常コメントは文中なら残す", () => {
    const ddl = `CREATE TABLE \`t\` (
  \`a\` int /*!80023 INVISIBLE */, /* keep me */
  \`b\` int
) ENGINE=InnoDB /*!50100 PARTITION BY HASH (\`a\`) PARTITIONS 4 */;`;
    const r = buildCloneStatements({
      driver: "mysql", database: "d", sourceTable: "t", newTable: "t2", ddl, includeData: false,
    });
    expect(r.statements[0]).toContain("/*!80023 INVISIBLE */");
    expect(r.statements[0]).toContain("/*!50100 PARTITION BY HASH (`a`) PARTITIONS 4 */");
    expect(r.statements[0]).toContain("/* keep me */");
  });

  it("MySQL: 別 DB の同名テーブルを参照する FK は自己参照扱いしない", () => {
    const ddl = "CREATE TABLE `t` (a int, CONSTRAINT `fk` FOREIGN KEY (a) REFERENCES `other`.`t` (id), CONSTRAINT `fk2` FOREIGN KEY (a) REFERENCES `d`.`t` (id))";
    const r = buildCloneStatements({
      driver: "mysql", database: "d", sourceTable: "t", newTable: "t2", ddl, includeData: false,
    });
    expect(r.statements[0]).toContain("REFERENCES `other`.`t` (id)");
    expect(r.statements[0]).toContain("REFERENCES `d`.`t2` (id)");
  });

  it("新テーブル名に $ 系の置換記号があっても制約名にそのまま入る", () => {
    const r = buildCloneStatements({
      driver: "mysql", database: "d", sourceTable: "t", newTable: "t$&x",
      ddl: "CREATE TABLE `t` (a int, CONSTRAINT `t_fk` CHECK (a > 0))", includeData: false,
    });
    expect(r.statements[0]).toContain("CONSTRAINT `t$&x_fk`");
    expect(cloneObjectName("mysql", "t_fk", "t", "n$1$&", new Set())).toBe("n$1$&_fk");
  });

  it("SQLite: '\\' リテラルでバックスラッシュを文字列エスケープ扱いしない", () => {
    const ddl = "CREATE TABLE t (a text DEFAULT '\\', b int);\n\nCREATE INDEX idx_t ON t (b);";
    const r = buildCloneStatements({
      driver: "sqlite", database: null, sourceTable: "t", newTable: "t2", ddl, includeData: false,
    });
    expect(r.statements).toEqual([
      "CREATE TABLE \"t2\" (a text DEFAULT '\\', b int)",
      'CREATE INDEX "idx_t2" ON "t2" (b)',
    ]);
  });

  it("生成列を除いた明示列リストで INSERT ... SELECT を組む", () => {
    expect(
      insertableColumns("mysql", [
        { name: "a", extra: "auto_increment" },
        { name: "g", extra: "VIRTUAL GENERATED" },
        { name: "s", extra: "STORED GENERATED" },
        { name: "d", extra: "DEFAULT_GENERATED" },
        { name: "i", extra: "INVISIBLE" },
      ]),
    ).toEqual(["a", "d", "i"]);
    expect(insertableColumns("postgres", [{ name: "a" }, { name: "g" }], ["g"])).toEqual(["a"]);
    expect(insertableColumns("sqlite", [{ name: "a" }])).toEqual(["a"]);
    expect(insertableColumns("sqlite", [])).toBeNull();
    const r = buildCloneStatements({
      driver: "mysql", database: "d", sourceTable: "t", newTable: "t2",
      ddl: "CREATE TABLE `t` (a int)", includeData: true, columns: ["a", "i"],
    });
    expect(r.statements.at(-1)).toBe("INSERT INTO `d`.`t2` (`a`, `i`) SELECT `a`, `i` FROM `d`.`t`");
  });

  it("MySQL の部分失敗判定: 2 文以上で新名が残っているときだけ true", () => {
    expect(isPartialCloneFailure("mysql", 2, ["a", "T2"], "t2")).toBe(true);
    expect(isPartialCloneFailure("mysql", 2, ["a"], "t2")).toBe(false);
    expect(isPartialCloneFailure("mysql", 1, ["t2"], "t2")).toBe(false);
    expect(isPartialCloneFailure("sqlite", 2, ["t2"], "t2")).toBe(false);
    expect(isPartialCloneFailure("mysql", 2, null, "t2")).toBe(false);
  });

  it("CREATE TABLE で始まらない DDL は空を返し、解釈できない後続文は skipped に残す", () => {
    expect(
      buildCloneStatements({
        driver: "sqlite", database: null, sourceTable: "v", newTable: "v2",
        ddl: "CREATE VIEW v AS SELECT 1;", includeData: false,
      }).statements,
    ).toEqual([]);
    const r = buildCloneStatements({
      driver: "sqlite", database: null, sourceTable: "t", newTable: "t2",
      ddl: "CREATE TABLE t (a);\n\nCREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END;", includeData: false,
    });
    expect(r.statements).toHaveLength(1);
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it("IF NOT EXISTS と引用識別子内の記号を扱える", () => {
    const r = buildCloneStatements({
      driver: "mysql", database: "s", sourceTable: "we`ird", newTable: "x",
      ddl: "CREATE TABLE IF NOT EXISTS `s`.`we``ird` (`a` int, CONSTRAINT `we``ird_fk` FOREIGN KEY (`a`) REFERENCES `we``ird` (`a`));",
      includeData: false,
    });
    expect(r.statements[0]).toBe(
      "CREATE TABLE IF NOT EXISTS `s`.`x` (`a` int, CONSTRAINT `x_fk` FOREIGN KEY (`a`) REFERENCES `s`.`x` (`a`))",
    );
  });
});

describe("cloneObjectName / suggestCloneName", () => {
  it("旧テーブル名を含めば置換、含まなければ接尾辞、衝突と長さ上限を処理する", () => {
    const used = new Set<string>();
    expect(cloneObjectName("postgres", "users_email_idx", "users", "u2", used)).toBe("u2_email_idx");
    expect(cloneObjectName("postgres", "u2_email_idx", "other", "u3", new Set(["u2_email_idx_u3"]))).toBe("u2_email_idx_u3_2");
    const long = cloneObjectName("postgres", "x".repeat(70), "zzz", "new", new Set());
    expect(long.length).toBe(63);
  });

  it("既定名は _copy、衝突で連番", () => {
    expect(suggestCloneName(["a"], "a")).toBe("a_copy");
    expect(suggestCloneName(["a", "A_COPY"], "a")).toBe("a_copy2");
  });

  it("formatCloneStatements は ; を付けて空行区切り", () => {
    expect(formatCloneStatements(["A", "B"])).toBe("A;\n\nB;");
  });
});
