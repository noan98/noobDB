import { describe, it, expect } from "vitest";
import {
  buildCloneStatements,
  cloneObjectName,
  formatCloneStatements,
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

  it("PostgreSQL: ヘッダコメント除去・制約名/インデックス名の改名・USING を保持", () => {
    const r = buildCloneStatements({
      driver: "postgres",
      database: "public",
      sourceTable: "orders",
      newTable: "orders_copy",
      ddl: PG_DDL,
      includeData: false,
    });
    expect(r.statements).toEqual([
      expect.stringMatching(/^CREATE TABLE "public"\."orders_copy" \(/),
      'CREATE UNIQUE INDEX "orders_copy_user_idx" ON "public"."orders_copy" ("user_id")',
      'CREATE INDEX "by_id_orders_copy" ON "public"."orders_copy" USING hash ("id")',
    ]);
    expect(r.statements[0]).toContain('CONSTRAINT "orders_copy_user_fk" FOREIGN KEY');
    expect(r.statements[0]).not.toContain("Reconstructed");
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
    expect(my.statements.at(-1)).toBe("INSERT INTO `shop`.`o2` SELECT * FROM `shop`.`orders`");
    const pg = buildCloneStatements({
      driver: "postgres", database: "public", sourceTable: "orders", newTable: "o2", ddl: PG_DDL, includeData: true,
    });
    expect(pg.statements.at(-1)).toBe('INSERT INTO "public"."o2" SELECT * FROM "public"."orders"');
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
      driver: "postgres", database: "s", sourceTable: 'we"ird', newTable: "x",
      ddl: 'CREATE TABLE IF NOT EXISTS "s"."we""ird" ("a" int, CONSTRAINT "we""ird_fk" FOREIGN KEY ("a") REFERENCES "we""ird" ("a"));',
      includeData: false,
    });
    expect(r.statements[0]).toBe(
      'CREATE TABLE IF NOT EXISTS "s"."x" ("a" int, CONSTRAINT "x_fk" FOREIGN KEY ("a") REFERENCES "s"."x" ("a"))',
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
