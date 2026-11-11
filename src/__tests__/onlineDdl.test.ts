import { describe, it, expect } from "vitest";
import { buildAlterPlan, type AlterTableForm } from "../components/alterTable";
import {
  buildAlterExecutionPlan,
  buildFailureGuide,
  buildIndexExecutionPlan,
  canStage,
  invalidIndexLookupSql,
  isLockTimeoutError,
  lockTimeoutStatements,
  planNeedsRunner,
  planPreviewSql,
  stepStatementsToSend,
  withConcurrently,
} from "../components/onlineDdl";
import { buildCreateIndexSql, buildDropIndexSql, indexNameOfCreateSql } from "../components/tableMaintenance";

function form(over: Partial<AlterTableForm>): AlterTableForm {
  return {
    database: "shop",
    table: "orders",
    baseline: [],
    existing: [],
    added: [],
    indexes: [],
    ...over,
  } as AlterTableForm;
}

const fk = {
  name: "",
  columns: ["user_id"],
  refTable: "users",
  refColumns: ["id"],
  onDelete: "" as const,
  onUpdate: "" as const,
};

describe("lockTimeoutStatements", () => {
  it("PostgreSQL は SET LOCAL lock_timeout", () => {
    expect(lockTimeoutStatements("postgres", 5)).toEqual({
      before: ["SET LOCAL lock_timeout = '5s';"],
      after: [],
    });
  });
  it("MySQL は SET SESSION lock_wait_timeout を付けて末尾で戻す", () => {
    expect(lockTimeoutStatements("mysql", 3)).toEqual({
      before: ["SET SESSION lock_wait_timeout = 3;"],
      after: ["SET SESSION lock_wait_timeout = @@GLOBAL.lock_wait_timeout;"],
    });
  });
  it("0・SQLite・不正値は付けない", () => {
    expect(lockTimeoutStatements("postgres", 0)).toEqual({ before: [], after: [] });
    expect(lockTimeoutStatements("sqlite", 5)).toEqual({ before: [], after: [] });
    expect(lockTimeoutStatements("mysql", Number.NaN)).toEqual({ before: [], after: [] });
  });
});

describe("buildAlterExecutionPlan", () => {
  const pgFk = buildAlterPlan("postgres", form({ addedForeignKeys: [fk] })).statements;

  it("段階実行でなければ 1 段階 (1 トランザクション) + ロック待ちの上限", () => {
    const plan = buildAlterExecutionPlan("postgres", pgFk, {
      database: "shop",
      staged: false,
      lockTimeoutSecs: 5,
    });
    expect(plan.staged).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(stepStatementsToSend(plan, plan.steps[0])).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      ...pgFk.map((s) => s.sql),
    ]);
    expect(planNeedsRunner(plan)).toBe(true);
  });

  it("上限なし・段階なしなら従来どおり (ランナー不要)", () => {
    const plan = buildAlterExecutionPlan("postgres", pgFk, {
      database: "shop",
      staged: false,
      lockTimeoutSecs: 0,
    });
    expect(planNeedsRunner(plan)).toBe(false);
  });

  it("PostgreSQL の FK は NOT VALID → VALIDATE の 2 段階 (無名は自動名)", () => {
    expect(canStage("postgres", pgFk)).toBe(true);
    const plan = buildAlterExecutionPlan("postgres", pgFk, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 5,
    });
    expect(plan.staged).toBe(true);
    expect(plan.steps.map((s) => s.phase)).toEqual(["addNotValid", "validate"]);
    expect(plan.steps[0].statements).toEqual([
      'ALTER TABLE "shop"."orders" ADD CONSTRAINT "fk_user_id" FOREIGN KEY ("user_id") REFERENCES "shop"."users" ("id") NOT VALID;',
    ]);
    expect(plan.steps[1].statements).toEqual([
      'ALTER TABLE "shop"."orders" VALIDATE CONSTRAINT "fk_user_id";',
    ]);
    expect(plan.steps.every((s) => s.transactional)).toBe(true);
  });

  it("CHECK は名前つきならその名前で NOT VALID → VALIDATE", () => {
    const st = buildAlterPlan(
      "postgres",
      form({ addedChecks: [{ name: "chk_pos", expression: "total > 0" }] }),
    ).statements;
    const plan = buildAlterExecutionPlan("postgres", st, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 0,
    });
    expect(plan.steps[0].statements[0]).toBe(
      'ALTER TABLE "shop"."orders" ADD CONSTRAINT "chk_pos" CHECK (total > 0) NOT VALID;',
    );
    expect(plan.steps[1].statements[0]).toBe('ALTER TABLE "shop"."orders" VALIDATE CONSTRAINT "chk_pos";');
  });

  it("SET NOT NULL は一時 CHECK → VALIDATE → SET NOT NULL + CHECK の DROP", () => {
    const st = buildAlterPlan(
      "postgres",
      form({
        baseline: [{ name: "email", type: "text", notNull: false, defaultValue: "", extra: "" }] as never,
        existing: [
          { original: "email", name: "email", type: "text", notNull: true, defaultValue: "", drop: false },
        ] as never,
      }),
    ).statements;
    const plan = buildAlterExecutionPlan("postgres", st, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 0,
    });
    expect(plan.steps.map((s) => s.phase)).toEqual(["addNotValid", "validate", "setNotNull"]);
    expect(plan.steps[0].statements[0]).toBe(
      'ALTER TABLE "shop"."orders" ADD CONSTRAINT "noobdb_nn_email" CHECK ("email" IS NOT NULL) NOT VALID;',
    );
    expect(plan.steps[2].statements).toEqual([
      'ALTER TABLE "shop"."orders" ALTER COLUMN "email" SET NOT NULL;',
      'ALTER TABLE "shop"."orders" DROP CONSTRAINT "noobdb_nn_email";',
    ]);
  });

  it("インデックスはトランザクション外の CONCURRENTLY 段階 (ロック待ちの上限は付けない)", () => {
    const st = buildAlterPlan(
      "postgres",
      form({ indexes: [{ name: "idx_o", columns: ["total"], unique: true }] }),
    ).statements;
    const plan = buildAlterExecutionPlan("postgres", st, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 5,
    });
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0];
    expect(step.transactional).toBe(false);
    expect(step.statements).toEqual([
      'CREATE UNIQUE INDEX CONCURRENTLY "idx_o" ON "shop"."orders" ("total");',
    ]);
    expect(stepStatementsToSend(plan, step)).toEqual(step.statements);
  });

  it("対象のない文は順序を保って 1 トランザクションにまとめる", () => {
    const st = buildAlterPlan(
      "postgres",
      form({
        added: [{ name: "note", type: "text", notNull: false, defaultValue: "", comment: "" }] as never,
        addedForeignKeys: [fk],
        indexes: [{ name: "idx_o", columns: ["total"], unique: false }],
      }),
    ).statements;
    const plan = buildAlterExecutionPlan("postgres", st, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 5,
    });
    expect(plan.steps.map((s) => s.phase)).toEqual([
      "alter",
      "addNotValid",
      "validate",
      "createIndexConcurrently",
    ]);
  });

  it("MySQL / SQLite は段階に分けない (MySQL はロック待ちの上限だけ付ける)", () => {
    const my = buildAlterPlan("mysql", form({ addedForeignKeys: [fk] })).statements;
    expect(canStage("mysql", my)).toBe(false);
    const plan = buildAlterExecutionPlan("mysql", my, { database: "shop", staged: true, lockTimeoutSecs: 2 });
    expect(plan.staged).toBe(false);
    expect(stepStatementsToSend(plan, plan.steps[0])[0]).toBe("SET SESSION lock_wait_timeout = 2;");
    const lite = buildAlterExecutionPlan("sqlite", [], { database: null, staged: true, lockTimeoutSecs: 5 });
    expect(lite.lockTimeoutSecs).toBe(0);
    expect(planNeedsRunner(lite)).toBe(false);
  });

  it("MySQL の ALGORITHM=INPLACE, LOCK=NONE は壊さない (文はそのまま)", () => {
    const st = [
      {
        sql: "ALTER TABLE `t` ADD INDEX `i` (`a`), ALGORITHM=INPLACE, LOCK=NONE;",
        kind: "createIndex",
        destructive: false,
      },
    ] as never;
    const plan = buildAlterExecutionPlan("mysql", st, { database: "db", staged: false, lockTimeoutSecs: 5 });
    expect(plan.steps[0].statements).toEqual([
      "ALTER TABLE `t` ADD INDEX `i` (`a`), ALGORITHM=INPLACE, LOCK=NONE;",
    ]);
  });

  it("段階のプレビューは区切りコメントを含む", () => {
    const plan = buildAlterExecutionPlan("postgres", pgFk, {
      database: "shop",
      staged: true,
      lockTimeoutSecs: 0,
    });
    const text = planPreviewSql(plan, (_s, i) => `stage ${i + 1}`);
    expect(text).toContain("-- stage 1\nALTER TABLE");
    expect(text).toContain("\n\n-- stage 2\n");
    const flat = buildAlterExecutionPlan("postgres", pgFk, {
      database: "shop",
      staged: false,
      lockTimeoutSecs: 5,
    });
    expect(planPreviewSql(flat, () => "x")).not.toContain("--");
    expect(planPreviewSql(flat, () => "x")).not.toContain("lock_timeout");
  });
});

describe("buildIndexExecutionPlan", () => {
  const sql = buildCreateIndexSql("postgres", "public", "orders", ["total"], {
    name: "idx_t",
    concurrently: true,
  });
  it("CREATE INDEX CONCURRENTLY を生成する (PostgreSQL のみ)", () => {
    expect(sql).toBe('CREATE INDEX CONCURRENTLY "idx_t" ON "public"."orders" ("total");');
    expect(
      buildCreateIndexSql("postgres", null, "o", ["a"], { name: "i", unique: true, concurrently: true }),
    ).toBe('CREATE UNIQUE INDEX CONCURRENTLY "i" ON "o" ("a");');
    expect(buildCreateIndexSql("mysql", "db", "o", ["a"], { name: "i", concurrently: true })).toBe(
      "CREATE INDEX `i` ON `db`.`o` (`a`);",
    );
    expect(buildCreateIndexSql("sqlite", null, "o", ["a"], { name: "i", concurrently: true })).toBe(
      'CREATE INDEX "i" ON "o" ("a");',
    );
    expect(indexNameOfCreateSql(sql)).toBe("idx_t");
  });
  it("CONCURRENTLY はトランザクション外で、失敗時の後始末と INVALID 確認を持つ", () => {
    const plan = buildIndexExecutionPlan("postgres", sql, {
      database: "public",
      indexName: "idx_t",
      kind: "create",
      concurrently: true,
      lockTimeoutSecs: 5,
    });
    const step = plan.steps[0];
    expect(step.transactional).toBe(false);
    expect(step.invalidIndex).toBe("idx_t");
    expect(step.undoOnFail).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_t";']);
    expect(planNeedsRunner(plan)).toBe(true);
  });
  it("DROP INDEX CONCURRENTLY", () => {
    const drop = buildDropIndexSql("postgres", "public", "orders", "idx_t", { concurrently: true });
    expect(drop).toBe('DROP INDEX CONCURRENTLY "idx_t";');
    expect(buildDropIndexSql("postgres", "public", "orders", "idx_t")).toBe('DROP INDEX "idx_t";');
    expect(buildDropIndexSql("mysql", "db", "o", "i", { concurrently: true })).toBe(
      "DROP INDEX `i` ON `db`.`o`;",
    );
    const plan = buildIndexExecutionPlan("postgres", drop, {
      database: "public",
      indexName: "idx_t",
      kind: "drop",
      concurrently: true,
      lockTimeoutSecs: 5,
    });
    expect(plan.steps[0].transactional).toBe(false);
    expect(plan.steps[0].undoOnFail).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "idx_t";']);
  });
  it("通常の作成は 1 トランザクション + ロック待ちの上限 (MySQL / PostgreSQL)、SQLite は付けない", () => {
    const pg = buildIndexExecutionPlan("postgres", "CREATE INDEX i ON t (a);", {
      database: null,
      indexName: "i",
      kind: "create",
      concurrently: false,
      lockTimeoutSecs: 4,
    });
    expect(stepStatementsToSend(pg, pg.steps[0])).toEqual([
      "SET LOCAL lock_timeout = '4s';",
      "CREATE INDEX i ON t (a);",
    ]);
    const lite = buildIndexExecutionPlan("sqlite", "CREATE INDEX i ON t (a);", {
      database: null,
      indexName: "i",
      kind: "create",
      concurrently: true,
      lockTimeoutSecs: 4,
    });
    expect(planNeedsRunner(lite)).toBe(false);
  });
  it("withConcurrently は二重に付けない", () => {
    expect(withConcurrently("CREATE INDEX CONCURRENTLY a ON t (x);")).toBe(
      "CREATE INDEX CONCURRENTLY a ON t (x);",
    );
  });
});

describe("buildFailureGuide", () => {
  const pgFk = buildAlterPlan(
    "postgres",
    form({ addedForeignKeys: [fk], indexes: [{ name: "i", columns: ["a"], unique: false }] }),
  ).statements;
  const plan = buildAlterExecutionPlan("postgres", pgFk, {
    database: "shop",
    staged: true,
    lockTimeoutSecs: 0,
  });
  const label = (_s: unknown, i: number) => `s${i + 1}`;

  it("VALIDATE で失敗: NOT VALID の制約が残る。残りと後始末を示す", () => {
    const g = buildFailureGuide(plan, 1, label);
    expect(g.appliedSteps).toBe(1);
    expect(g.totalSteps).toBe(3);
    expect(g.cleanupSql).toBe('ALTER TABLE "shop"."orders" DROP CONSTRAINT "fk_user_id";');
    expect(g.remainingSql).toContain("-- s2");
    expect(g.remainingSql).toContain("VALIDATE CONSTRAINT");
    expect(g.remainingSql).toContain("CREATE INDEX CONCURRENTLY");
  });
  it("完了済みの束は後始末に含めない。CONCURRENTLY の失敗は INVALID の DROP を案内", () => {
    const g = buildFailureGuide(plan, 2, label);
    expect(g.cleanupSql).toBe('DROP INDEX CONCURRENTLY IF EXISTS "shop"."i";');
  });
  it("最初の段階で失敗したら後始末は不要", () => {
    expect(buildFailureGuide(plan, 0, label).cleanupSql).toBe("");
  });
});

describe("エラー判定と補助 SQL", () => {
  it("ロック待ちのタイムアウト", () => {
    expect(isLockTimeoutError("postgres", "ERROR: canceling statement due to lock timeout")).toBe(true);
    expect(isLockTimeoutError("postgres", "deadlock detected")).toBe(false);
    expect(isLockTimeoutError("mysql", "Lock wait timeout exceeded; try restarting transaction")).toBe(true);
    expect(isLockTimeoutError("mysql", "Duplicate entry")).toBe(false);
    expect(isLockTimeoutError("sqlite", "database is locked")).toBe(false);
  });
  it("INVALID インデックスの確認 SQL", () => {
    expect(invalidIndexLookupSql("public", "idx's")).toContain(
      "c.relname = 'idx''s' AND n.nspname = 'public'",
    );
    expect(invalidIndexLookupSql(null, "i")).toContain("current_schemas(false)");
  });
});
