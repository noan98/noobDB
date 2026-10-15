import { describe, expect, it } from "vitest";
import {
  buildAlterPlan,
  duplicateColumnNames,
  renameCollisions,
  indexRowProblems,
  type AlterTableForm,
  type ExistingColumnBaseline,
  type ExistingColumnEdit,
  type NewColumn,
  supportsColumnPosition,
} from "../components/alterTable";

function baseline(over: Partial<ExistingColumnBaseline>): ExistingColumnBaseline {
  return { name: "c", type: "int", notNull: false, defaultValue: "", extra: "", ...over };
}

function edit(over: Partial<ExistingColumnEdit>): ExistingColumnEdit {
  return { original: "c", drop: false, name: "c", type: "int", notNull: false, defaultValue: "", ...over };
}

function form(over: Partial<AlterTableForm>): AlterTableForm {
  return {
    database: "shop",
    table: "users",
    baseline: [],
    existing: [],
    added: [],
    indexes: [],
    ...over,
  };
}

describe("buildAlterPlan: ADD COLUMN", () => {
  it("builds an ADD COLUMN statement per driver with correct identifier quoting", () => {
    const mysql = buildAlterPlan(
      "mysql",
      form({ added: [{ name: "age", type: "INT", notNull: true, defaultValue: "0" }] }),
    );
    expect(mysql.statements).toHaveLength(1);
    expect(mysql.statements[0]).toMatchObject({ kind: "addColumn", destructive: false });
    expect(mysql.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` ADD COLUMN `age` INT NOT NULL DEFAULT 0;",
    );

    const pg = buildAlterPlan(
      "postgres",
      form({ added: [{ name: "age", type: "int", notNull: false, defaultValue: "" }] }),
    );
    expect(pg.statements[0].sql).toBe('ALTER TABLE "shop"."users" ADD COLUMN "age" int;');

    const sqlite = buildAlterPlan(
      "sqlite",
      form({ database: null, added: [{ name: "age", type: "INTEGER", notNull: false, defaultValue: "" }] }),
    );
    expect(sqlite.statements[0].sql).toBe('ALTER TABLE "users" ADD COLUMN "age" INTEGER;');
  });

  it("quotes string defaults and skips blank column names", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        added: [
          { name: "note", type: "VARCHAR(50)", notNull: false, defaultValue: "hello" },
          { name: "  ", type: "TEXT", notNull: false, defaultValue: "" },
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toContain("DEFAULT 'hello'");
  });
});

describe("buildAlterPlan: rename / modify — MySQL", () => {
  it("uses RENAME COLUMN when only the name changes", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "old_name", type: "int" })],
        existing: [edit({ original: "old_name", name: "new_name", type: "int" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatchObject({ kind: "renameColumn", destructive: false });
    expect(plan.statements[0].sql).toBe("ALTER TABLE `shop`.`users` RENAME COLUMN `old_name` TO `new_name`;");
  });

  it("uses CHANGE COLUMN with a full definition when type/null/default change", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "amount", type: "int", notNull: false, defaultValue: "" })],
        existing: [
          edit({ original: "amount", name: "amount", type: "bigint", notNull: true, defaultValue: "0" }),
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatchObject({ kind: "modifyColumn" });
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `amount` `amount` bigint NOT NULL DEFAULT 0;",
    );
  });

  it("combines rename and redefinition in a single CHANGE COLUMN, quoting string defaults", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "status", type: "varchar(20)", notNull: false, defaultValue: "" })],
        existing: [
          edit({
            original: "status",
            name: "state",
            type: "varchar(20)",
            notNull: true,
            defaultValue: "pending",
          }),
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].kind).toBe("renameColumn");
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `status` `state` varchar(20) NOT NULL DEFAULT 'pending';",
    );
  });

  it("produces nothing when nothing actually changed", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "id", type: "int", notNull: true, defaultValue: "" })],
        existing: [edit({ original: "id", name: "id", type: "int", notNull: true, defaultValue: "" })],
      }),
    );
    expect(plan.statements).toHaveLength(0);
    expect(plan.unsupported).toHaveLength(0);
  });

  it("falls back to the baseline type when the type field is left blank", () => {
    // #896 CodeRabbit レビュー対応の回帰テスト (PostgreSQL 分岐と対で確認)。
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "amount", type: "int", notNull: false, defaultValue: "" })],
        existing: [edit({ original: "amount", name: "amount", type: "  ", notNull: true, defaultValue: "" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `amount` `amount` int NOT NULL;",
    );
  });

  it("preserves AUTO_INCREMENT (and other EXTRA attributes) verbatim across CHANGE COLUMN", () => {
    // #896 CodeRabbit レビュー対応: CHANGE COLUMN は元々 auto_increment などの
    // 付随属性を保持しないため、baseline.extra を逐語で付け足す
    // (db/sync.rs::column_def と同じ方針)。
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          baseline({ name: "id", type: "int", notNull: true, defaultValue: "", extra: "auto_increment" }),
        ],
        existing: [edit({ original: "id", name: "id", type: "bigint", notNull: true, defaultValue: "" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `id` `id` bigint NOT NULL auto_increment;",
    );
  });

  it("preserves EXTRA even when only the name changes (rename goes through CHANGE COLUMN once facets differ)", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          baseline({
            name: "created",
            type: "timestamp",
            notNull: false,
            extra: "on update CURRENT_TIMESTAMP",
          }),
        ],
        existing: [edit({ original: "created", name: "created_at", type: "timestamp", notNull: true })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `created` `created_at` timestamp NOT NULL on update CURRENT_TIMESTAMP;",
    );
  });
});

describe("buildAlterPlan: rename / modify — PostgreSQL", () => {
  it("emits one ALTER COLUMN per changed facet, using the new name after rename", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "v", type: "int", notNull: false, defaultValue: "" })],
        existing: [edit({ original: "v", name: "value", type: "bigint", notNull: true, defaultValue: "0" })],
      }),
    );
    const sqls = plan.statements.map((s) => s.sql);
    expect(sqls).toEqual([
      'ALTER TABLE "shop"."users" RENAME COLUMN "v" TO "value";',
      'ALTER TABLE "shop"."users" ALTER COLUMN "value" TYPE bigint;',
      'ALTER TABLE "shop"."users" ALTER COLUMN "value" SET NOT NULL;',
      'ALTER TABLE "shop"."users" ALTER COLUMN "value" SET DEFAULT 0;',
    ]);
  });

  it("keeps existing default expressions verbatim when unedited (no spurious ALTER)", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [
          baseline({
            name: "status",
            type: "character varying(20)",
            defaultValue: "'pending'::character varying",
          }),
        ],
        existing: [
          edit({
            original: "status",
            name: "status",
            type: "character varying(20)",
            defaultValue: "'pending'::character varying",
          }),
        ],
      }),
    );
    expect(plan.statements).toHaveLength(0);
  });

  it("drops the default when the field is cleared", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "status", type: "text", defaultValue: "'pending'" })],
        existing: [edit({ original: "status", name: "status", type: "text", defaultValue: "" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "shop"."users" ALTER COLUMN "status" DROP DEFAULT;');
  });

  it("a type-only diff emits a single isolated ALTER COLUMN ... TYPE (no NOT NULL/DEFAULT statements)", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "v", type: "int" })],
        existing: [edit({ original: "v", name: "v", type: "bigint" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "shop"."users" ALTER COLUMN "v" TYPE bigint;');
  });

  it("falls back to the baseline type instead of emitting a broken 'TYPE ;' when the type field is left blank", () => {
    // #896 CodeRabbit レビュー対応: 型欄を空にしたまま他のフィールド (ここでは
    // NOT NULL) だけ変えると、以前は `ALTER COLUMN "v" TYPE ;` という不正な SQL を
    // 生成していた。空欄は「未編集 (baseline のまま)」として扱われるべき。
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "v", type: "int", notNull: false })],
        existing: [edit({ original: "v", name: "v", type: "  ", notNull: true })],
      }),
    );
    const sqls = plan.statements.map((s) => s.sql);
    expect(sqls).not.toContain('ALTER TABLE "shop"."users" ALTER COLUMN "v" TYPE ;');
    expect(sqls).toEqual(['ALTER TABLE "shop"."users" ALTER COLUMN "v" SET NOT NULL;']);
  });
});

describe("buildAlterPlan: rename / modify — SQLite", () => {
  it("renames natively", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "old", type: "TEXT" })],
        existing: [edit({ original: "old", name: "new", type: "TEXT" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" RENAME COLUMN "old" TO "new";');
    expect(plan.unsupported).toHaveLength(0);
  });

  it("reports an in-place modify as unsupported instead of emitting broken SQL", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "v", type: "TEXT", notNull: false })],
        existing: [edit({ original: "v", name: "v", type: "INTEGER", notNull: false })],
      }),
    );
    expect(plan.statements).toHaveLength(0);
    expect(plan.unsupported).toEqual([{ column: "v", reason: "sqliteInPlaceModify" }]);
  });

  it("still renames even when the type also changes, and reports the type change separately", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "old", type: "TEXT" })],
        existing: [edit({ original: "old", name: "new", type: "INTEGER" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" RENAME COLUMN "old" TO "new";');
    expect(plan.unsupported).toEqual([{ column: "old", reason: "sqliteInPlaceModify" }]);
  });
});

describe("buildAlterPlan: DROP COLUMN", () => {
  it("drops regardless of other edited fields, and flags it destructive", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "gone", type: "int" })],
        existing: [edit({ original: "gone", drop: true, name: "ignored", type: "text" })],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatchObject({ kind: "dropColumn", destructive: true });
    expect(plan.statements[0].sql).toBe("ALTER TABLE `shop`.`users` DROP COLUMN `gone`;");
  });

  it("supports DROP COLUMN natively on SQLite too", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        baseline: [baseline({ name: "gone", type: "TEXT" })],
        existing: [edit({ original: "gone", drop: true })],
      }),
    );
    expect(plan.statements[0].sql).toBe('ALTER TABLE "users" DROP COLUMN "gone";');
  });
});

describe("buildAlterPlan: CREATE INDEX", () => {
  it("builds a plain and a unique index with dialect quoting", () => {
    const plain = buildAlterPlan(
      "mysql",
      form({ indexes: [{ name: "idx_email", columns: ["email"], unique: false }] }),
    );
    expect(plain.statements[0].sql).toBe("CREATE INDEX `idx_email` ON `shop`.`users` (`email`);");
    expect(plain.statements[0].kind).toBe("createIndex");

    const unique = buildAlterPlan(
      "postgres",
      form({ indexes: [{ name: "idx_email_uniq", columns: ["email"], unique: true }] }),
    );
    expect(unique.statements[0].sql).toBe(
      'CREATE UNIQUE INDEX "idx_email_uniq" ON "shop"."users" ("email");',
    );
  });

  it("supports composite indexes and skips rows with no name or no columns", () => {
    const plan = buildAlterPlan(
      "sqlite",
      form({
        database: null,
        indexes: [
          { name: "idx_multi", columns: ["a", "b"], unique: false },
          { name: "", columns: ["c"], unique: false },
          { name: "idx_empty", columns: [], unique: false },
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].sql).toBe('CREATE INDEX "idx_multi" ON "users" ("a", "b");');
  });
});

describe("indexRowProblems (#1532)", () => {
  it("名前の空 / 列未選択を行ごとに報告し、完全な行は null", () => {
    expect(indexRowProblems({ name: "i", columns: ["a"], unique: false })).toBeNull();
    expect(indexRowProblems({ name: " ", columns: ["a"], unique: false })).toEqual({
      missingName: true,
      missingColumns: false,
    });
    expect(indexRowProblems({ name: "i", columns: [], unique: false })).toEqual({
      missingName: false,
      missingColumns: true,
    });
    expect(indexRowProblems({ name: "", columns: [" "], unique: true })).toEqual({
      missingName: true,
      missingColumns: true,
    });
  });
});

describe("buildAlterPlan: statement ordering", () => {
  it("orders ADD before RENAME/MODIFY before DROP before CREATE INDEX", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          baseline({ name: "renamed_from", type: "int" }),
          baseline({ name: "dropped", type: "int" }),
        ],
        existing: [
          edit({ original: "renamed_from", name: "renamed_to", type: "int" }),
          edit({ original: "dropped", drop: true }),
        ],
        added: [{ name: "added", type: "TEXT", notNull: false, defaultValue: "" }],
        indexes: [{ name: "idx_added", columns: ["added"], unique: false }],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual([
      "addColumn",
      "renameColumn",
      "dropColumn",
      "createIndex",
    ]);
  });
});

describe("buildAlterPlan: 空けた列名の再利用 (#1602)", () => {
  it("DROP した列と同名の新規列は DROP の後に ADD する", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "status", type: "text" })],
        existing: [edit({ original: "status", drop: true })],
        added: [{ name: "Status", type: "TEXT", notNull: false, defaultValue: "" }],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual(["dropColumn", "addColumn"]);
  });

  it("リネームで空けた列名の新規列は RENAME の後・DROP の前に ADD する", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "status", type: "text" }), baseline({ name: "old", type: "int" })],
        existing: [
          edit({ original: "status", name: "status_old", type: "text" }),
          edit({ original: "old", drop: true }),
        ],
        added: [{ name: "status", type: "text", notNull: false, defaultValue: "" }],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual(["renameColumn", "addColumn", "dropColumn"]);
  });
});

describe("buildAlterPlan: 式 DEFAULT / DEFAULT_GENERATED (#1527)", () => {
  it("ADD COLUMN の式 DEFAULT を全方言で文字列化しない", () => {
    const pg = buildAlterPlan(
      "postgres",
      form({
        added: [{ name: "token", type: "text", notNull: false, defaultValue: "gen_random_uuid()::text" }],
      }),
    );
    expect(pg.statements[0].sql).toBe(
      'ALTER TABLE "shop"."users" ADD COLUMN "token" text DEFAULT gen_random_uuid()::text;',
    );
    const my = buildAlterPlan(
      "mysql",
      form({ added: [{ name: "u", type: "varchar(36)", notNull: false, defaultValue: "(UUID())" }] }),
    );
    expect(my.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` ADD COLUMN `u` varchar(36) DEFAULT (UUID());",
    );
    const lite = buildAlterPlan(
      "sqlite",
      form({ added: [{ name: "c", type: "text", notNull: false, defaultValue: "007" }] }),
    );
    expect(lite.statements[0].sql).toBe('ALTER TABLE "users" ADD COLUMN "c" text DEFAULT \'007\';');
  });

  it("CHANGE COLUMN に DEFAULT_GENERATED を入れない", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [
          baseline({
            name: "created_at",
            type: "timestamp",
            defaultValue: "CURRENT_TIMESTAMP",
            extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
            comment: "",
          }),
        ],
        existing: [
          edit({
            original: "created_at",
            name: "created_at",
            type: "timestamp",
            defaultValue: "CURRENT_TIMESTAMP",
            comment: "x",
          }),
        ],
      }),
    );
    expect(plan.statements[0].sql).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `created_at` `created_at` timestamp DEFAULT CURRENT_TIMESTAMP on update CURRENT_TIMESTAMP COMMENT 'x';",
    );
  });
});

describe("buildAlterPlan: MySQL 既存列の既定値 (#1527 レビュー)", () => {
  const change = (base: Partial<ExistingColumnBaseline>, ed: Partial<ExistingColumnEdit>) =>
    buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "c", type: "varchar(10)", ...base })],
        existing: [edit({ original: "c", name: "c", type: "varchar(10)", comment: "x", ...ed })],
      }),
    ).statements[0].sql;

  it("文字列既定値 (none) はコメントだけ変えてもリテラルのまま", () => {
    expect(change({ defaultValue: "(none)", comment: "" }, { defaultValue: "(none)" })).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `c` `c` varchar(10) DEFAULT '(none)' COMMENT 'x';",
    );
  });
  it("DEFAULT_GENERATED の式既定値は (expr) で包む。現在時刻系は包まない", () => {
    expect(change({ defaultValue: "uuid()", extra: "DEFAULT_GENERATED" }, { defaultValue: "uuid()" })).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `c` `c` varchar(10) DEFAULT (uuid()) COMMENT 'x';",
    );
    expect(
      change(
        { defaultValue: "CURRENT_TIMESTAMP", extra: "DEFAULT_GENERATED" },
        { defaultValue: "CURRENT_TIMESTAMP" },
      ),
    ).toBe(
      "ALTER TABLE `shop`.`users` CHANGE COLUMN `c` `c` varchar(10) DEFAULT CURRENT_TIMESTAMP COMMENT 'x';",
    );
    // 全体が 1 組の括弧で包まれているときだけ包まない。`(a) + (b)` は包む。
    expect(
      change({ defaultValue: "(rand())", extra: "DEFAULT_GENERATED" }, { defaultValue: "(rand())" }),
    ).toBe("ALTER TABLE `shop`.`users` CHANGE COLUMN `c` `c` varchar(10) DEFAULT (rand()) COMMENT 'x';");
    expect(
      change({ defaultValue: "(1) + (2)", extra: "DEFAULT_GENERATED" }, { defaultValue: "(1) + (2)" }),
    ).toBe("ALTER TABLE `shop`.`users` CHANGE COLUMN `c` `c` varchar(10) DEFAULT ((1) + (2)) COMMENT 'x';");
  });
  it("ADD COLUMN で型が空なら TEXT として既定値を判定する", () => {
    const r = buildAlterPlan(
      "mysql",
      form({ added: [{ name: "a", type: "", notNull: false, defaultValue: "007" }] }),
    );
    expect(r.statements[0].sql).toBe("ALTER TABLE `shop`.`users` ADD COLUMN `a` TEXT DEFAULT '007';");
  });
});

describe("duplicateColumnNames (#1602)", () => {
  const b = [baseline({ name: "status" }), baseline({ name: "other" })];
  const add = (name: string) => ({ name, type: "TEXT", notNull: false, defaultValue: "" });

  it("DROP / リネームで空けた名前の再利用は重複ではない", () => {
    expect(
      duplicateColumnNames("mysql", {
        baseline: b,
        existing: [edit({ original: "status", drop: true })],
        added: [add("status")],
      }),
    ).toEqual([]);
    expect(
      duplicateColumnNames("mysql", {
        baseline: b,
        existing: [edit({ original: "status", name: "status_old" })],
        added: [add("status")],
      }),
    ).toEqual([]);
  });

  it("既存列と同名の新規列・リネーム先の衝突は重複 (MySQL は大小無視)", () => {
    expect(duplicateColumnNames("mysql", { baseline: b, existing: [], added: [add("STATUS")] })).toEqual([
      "STATUS",
    ]);
    expect(duplicateColumnNames("postgres", { baseline: b, existing: [], added: [add("STATUS")] })).toEqual(
      [],
    );
    expect(
      duplicateColumnNames("sqlite", {
        baseline: b,
        existing: [edit({ original: "other", name: "status" })],
        added: [],
      }),
    ).toEqual(["status"]);
    expect(duplicateColumnNames("mysql", { baseline: b, existing: [], added: [add("x"), add("x")] })).toEqual(
      ["x"],
    );
  });
});

describe("buildAlterPlan: 空けた名前の再利用 (続き, #1602)", () => {
  const added = { name: "status", type: "TEXT", notNull: false, defaultValue: "" };

  it("DROP の後ろへ送った ADD を参照する FK / CHECK は、その ADD の後に出す", () => {
    const plan = buildAlterPlan(
      "mysql",
      form({
        baseline: [baseline({ name: "status", type: "text" })],
        existing: [edit({ original: "status", drop: true })],
        added: [added],
        addedForeignKeys: [
          { name: "", columns: ["status"], refTable: "s", refColumns: ["id"], onDelete: "", onUpdate: "" },
        ],
        addedChecks: [{ name: "", expression: "status <> ''" }],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual([
      "dropColumn",
      "addColumn",
      "addForeignKey",
      "addCheck",
    ]);
  });

  it("DROP する列名へのリネーム (a→b, b を DROP) は DROP の後に出す", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "a" }), baseline({ name: "b" })],
        existing: [edit({ original: "a", name: "b" }), edit({ original: "b", drop: true })],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual(["dropColumn", "renameColumn"]);
  });

  it("DROP 先へのリネームで空いた名前を使う ADD は、そのリネームの後に出す", () => {
    const plan = buildAlterPlan(
      "postgres",
      form({
        baseline: [baseline({ name: "status" }), baseline({ name: "b" })],
        existing: [edit({ original: "status", name: "b" }), edit({ original: "b", drop: true })],
        added: [added],
      }),
    );
    expect(plan.statements.map((s) => s.kind)).toEqual(["dropColumn", "renameColumn", "addColumn"]);
  });
});

describe("renameCollisions (#1602)", () => {
  const b = [baseline({ name: "a" }), baseline({ name: "b" }), baseline({ name: "c" })];

  it("入れ替え・連鎖は衝突、DROP 先へのリネームと大小だけの変更は衝突ではない", () => {
    expect(
      renameCollisions("mysql", {
        baseline: b,
        existing: [edit({ original: "a", name: "b" }), edit({ original: "b", name: "a" })],
      }),
    ).toEqual(["b", "a"]);
    expect(
      renameCollisions("mysql", {
        baseline: b,
        existing: [edit({ original: "a", name: "b" }), edit({ original: "b", name: "x" })],
      }),
    ).toEqual(["b"]);
    expect(
      renameCollisions("mysql", {
        baseline: b,
        existing: [edit({ original: "a", name: "b" }), edit({ original: "b", drop: true })],
      }),
    ).toEqual([]);
    expect(
      renameCollisions("mysql", { baseline: b, existing: [edit({ original: "a", name: "A" })] }),
    ).toEqual([]);
  });
});

describe("buildAlterPlan: 新規列の位置 (#1625)", () => {
  const col = (position?: NewColumn["position"]): NewColumn => ({
    name: "age",
    type: "INT",
    notNull: false,
    defaultValue: "",
    position,
  });

  it("MySQL は FIRST / AFTER を付ける。末尾指定・未指定は付けない", () => {
    const sql = (position?: NewColumn["position"]) =>
      buildAlterPlan("mysql", form({ added: [col(position)] })).statements[0].sql;
    expect(sql({ mode: "first" })).toBe("ALTER TABLE `shop`.`users` ADD COLUMN `age` INT FIRST;");
    expect(sql({ mode: "after", column: "id" })).toBe(
      "ALTER TABLE `shop`.`users` ADD COLUMN `age` INT AFTER `id`;",
    );
    expect(sql({ mode: "after", column: "we`ird" })).toContain("AFTER `we``ird`");
    expect(sql({ mode: "end" })).toBe("ALTER TABLE `shop`.`users` ADD COLUMN `age` INT;");
    expect(sql({ mode: "after", column: "  " })).toBe("ALTER TABLE `shop`.`users` ADD COLUMN `age` INT;");
    expect(sql()).toBe("ALTER TABLE `shop`.`users` ADD COLUMN `age` INT;");
  });

  it("PostgreSQL / SQLite は位置指定を無視する", () => {
    for (const driver of ["postgres", "sqlite"]) {
      const sql = buildAlterPlan(driver, form({ added: [col({ mode: "first" })] })).statements[0].sql;
      expect(sql).not.toContain("FIRST");
      expect(supportsColumnPosition(driver)).toBe(false);
    }
    expect(supportsColumnPosition("mysql")).toBe(true);
  });
});
