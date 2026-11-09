import { describe, expect, it } from "vitest";
import vectors from "./fixtures/createTableOptionVectors.json";
import { buildCreateTableSql, buildCreateTableStatements, type ColumnDef } from "../components/createTable";
import {
  emptyPartitionSpec,
  emptyTableOptions,
  hasTableOptions,
  partitionMethods,
  tableOptionProblems,
  type PartitionSpec,
  type TableOptions,
} from "../components/tableOptions";

// CREATE TABLE ウィザードのテーブルオプション (#2161)。方言ごとの境界ケースを固定する。

const col = (over: Partial<ColumnDef>): ColumnDef => ({
  name: "c",
  type: "TEXT",
  notNull: false,
  primaryKey: false,
  unique: false,
  autoIncrement: false,
  defaultValue: "",
  ...over,
});

const id = (over: Partial<ColumnDef> = {}) =>
  col({ name: "id", type: "INTEGER", notNull: true, primaryKey: true, ...over });

const opts = (over: Partial<TableOptions>): TableOptions => ({ ...emptyTableOptions(), ...over });
const part = (driver: string, over: Partial<PartitionSpec>): PartitionSpec => ({
  ...emptyPartitionSpec(driver),
  ...over,
});

describe("オプション無しは従来どおりの CREATE TABLE", () => {
  it("options を渡さない / 空でも出力が変わらない", () => {
    const form = { table: "t", columns: [id({ autoIncrement: true })] };
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      expect(buildCreateTableSql(driver, { ...form, options: emptyTableOptions() })).toBe(
        buildCreateTableSql(driver, form),
      );
    }
    expect(buildCreateTableSql("sqlite", form)).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(hasTableOptions("mysql", emptyTableOptions())).toBe(false);
  });
});

describe("MySQL", () => {
  it("ENGINE / DEFAULT CHARSET / COLLATE を閉じ括弧の後ろに並べる", () => {
    const sql = buildCreateTableSql("mysql", {
      database: "app",
      table: "t",
      columns: [id()],
      options: opts({ engine: "InnoDB", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
    });
    expect(sql).toBe(
      "CREATE TABLE `app`.`t` (\n  `id` INTEGER NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
    );
  });

  it("指定した項目だけを出す", () => {
    const sql = buildCreateTableSql("mysql", {
      table: "t",
      columns: [id()],
      options: opts({ engine: "MyISAM" }),
    });
    expect(sql).toMatch(/\) ENGINE=MyISAM;$/);
    expect(sql).not.toContain("CHARSET");
  });

  it("ENGINE などは英数字とアンダースコアだけ。COLLATE は文字セットで始まる必要がある", () => {
    const cols = [id()];
    expect(tableOptionProblems("mysql", cols, opts({ engine: "Inno DB; DROP" }))).toEqual([
      { code: "token", field: "engine" },
    ]);
    expect(
      tableOptionProblems("mysql", cols, opts({ charset: "utf8mb4", collation: "latin1_swedish_ci" })),
    ).toEqual([{ code: "collationMismatch" }]);
    // 文字セットだけ / 照合順序だけは文字セットとの食い違いを判定できないので通す。
    expect(tableOptionProblems("mysql", cols, opts({ collation: "latin1_swedish_ci" }))).toEqual([]);
    expect(
      tableOptionProblems("mysql", cols, opts({ charset: "UTF8MB4", collation: "utf8mb4_bin" })),
    ).toEqual([]);
  });

  it("RANGE パーティション: 数値の上限と MAXVALUE (括弧なし)", () => {
    const columns = [id({ type: "INT" })];
    const range = (to: string) =>
      buildCreateTableSql("mysql", {
        table: "t",
        columns,
        options: opts({ partition: part("mysql", { method: "RANGE", key: "id", firstName: "p0", to }) }),
      });
    expect(range("1000")).toContain(
      "\nPARTITION BY RANGE (`id`) (\n  PARTITION `p0` VALUES LESS THAN (1000)\n);",
    );
    expect(range("maxvalue")).toContain("PARTITION `p0` VALUES LESS THAN MAXVALUE\n);");
  });

  it("文字列の境界値は RANGE COLUMNS に切り替わる。式のキーは切り替えない", () => {
    const columns = [
      id({ type: "INT" }),
      col({ name: "created", type: "DATE", primaryKey: true, notNull: true }),
    ];
    const sql = buildCreateTableSql("mysql", {
      table: "t",
      columns,
      options: opts({
        partition: part("mysql", { method: "RANGE", key: "created", firstName: "p0", to: "'2026-01-01'" }),
      }),
    });
    expect(sql).toContain(
      "PARTITION BY RANGE COLUMNS (`created`) (\n  PARTITION `p0` VALUES LESS THAN ('2026-01-01')",
    );
    const expr = buildCreateTableSql("mysql", {
      table: "t",
      columns,
      options: opts({
        partition: part("mysql", { method: "RANGE", key: "YEAR(created)", firstName: "p0", to: "2026" }),
      }),
    });
    expect(expr).toContain("PARTITION BY RANGE (YEAR(created)) (");
    expect(expr).not.toContain("COLUMNS");
  });

  it("LIST パーティションと HASH / KEY (PARTITIONS 数)", () => {
    const columns = [id({ type: "INT" })];
    const list = buildCreateTableSql("mysql", {
      table: "t",
      columns,
      options: opts({
        partition: part("mysql", { method: "LIST", key: "id", firstName: "pa", values: "1, 2, 3" }),
      }),
    });
    expect(list).toContain("PARTITION BY LIST (`id`) (\n  PARTITION `pa` VALUES IN (1, 2, 3)\n);");
    for (const method of ["HASH", "KEY"] as const) {
      const sql = buildCreateTableSql("mysql", {
        table: "t",
        columns,
        options: opts({ partition: part("mysql", { method, key: "id", modulus: "8" }) }),
      });
      expect(sql).toContain(`PARTITION BY ${method} (\`id\`) PARTITIONS 8;`);
    }
  });

  it("RANGE / LIST は最初のパーティションが必須。HASH / KEY は数が要る", () => {
    const columns = [id({ type: "INT" })];
    const p = (over: Partial<PartitionSpec>) =>
      tableOptionProblems("mysql", columns, opts({ partition: part("mysql", { key: "id", ...over }) }));
    expect(p({ method: "RANGE" })).toEqual([{ code: "partitionNeedsFirst" }]);
    expect(p({ method: "RANGE", firstName: "p0" })).toEqual([
      { code: "partitionBound", error: "rangeEmpty" },
    ]);
    expect(p({ method: "LIST", firstName: "p0" })).toEqual([{ code: "partitionBound", error: "listEmpty" }]);
    expect(p({ method: "HASH", modulus: "0" })).toEqual([{ code: "partitionCount" }]);
    expect(p({ method: "KEY", modulus: "x" })).toEqual([{ code: "partitionCount" }]);
    expect(p({ method: "HASH", modulus: "4" })).toEqual([]);
  });
});

describe("MySQL の RANGE COLUMNS と外部キー", () => {
  const columns = [id({ type: "INT" }), col({ name: "y", type: "INT", primaryKey: true, notNull: true })];
  const range = (over: Partial<PartitionSpec>) =>
    opts({ partition: part("mysql", { method: "RANGE", key: "id, y", firstName: "p0", ...over }) });

  it("素の列 2 つ以上のキーは、境界の数がキーの列数と一致しないと問題になる", () => {
    expect(tableOptionProblems("mysql", columns, range({ to: "10" }))).toEqual([
      { code: "partitionBound", error: "rangeEmpty" },
    ]);
    expect(tableOptionProblems("mysql", columns, range({ to: "10, 20, 30" }))).toEqual([
      { code: "partitionBound", error: "rangeEmpty" },
    ]);
    expect(tableOptionProblems("mysql", columns, range({ to: "10, 20" }))).toEqual([]);
    expect(buildCreateTableSql("mysql", { table: "t", columns, options: range({ to: "10, 20" }) })).toContain(
      "PARTITION BY RANGE COLUMNS (`id`, `y`) (\n  PARTITION `p0` VALUES LESS THAN (10, 20)",
    );
  });

  it("1 列・式のキーは LESS THAN の値が 1 つでないと問題になる", () => {
    const single = (over: Partial<PartitionSpec>) =>
      opts({ partition: part("mysql", { method: "RANGE", key: "id", firstName: "p0", ...over }) });
    expect(tableOptionProblems("mysql", columns, single({ key: "y", to: "10, 20" }))).toEqual([
      { code: "partitionBound", error: "rangeEmpty" },
    ]);
    expect(tableOptionProblems("mysql", columns, single({ key: "y", to: "MAXVALUE" }))).toEqual([]);
  });

  it("複数列の LIST COLUMNS は値をタプルで書かないと問題になる", () => {
    const list = (values: string) =>
      opts({ partition: part("mysql", { method: "LIST", key: "id, y", firstName: "p0", values }) });
    expect(tableOptionProblems("mysql", columns, list("1, 2"))).toEqual([
      { code: "partitionBound", error: "listEmpty" },
    ]);
    expect(tableOptionProblems("mysql", columns, list("(1, 2), (3, 4)"))).toEqual([]);
  });

  const fk = {
    name: "",
    columns: ["y"],
    refTable: "other",
    refColumns: ["id"],
    onDelete: "" as const,
    onUpdate: "" as const,
  };

  it("パーティション表と完成済みの外部キーは同時に指定できない (ER 1506)", () => {
    const o = opts({ partition: part("mysql", { method: "HASH", key: "id", modulus: "4" }) });
    expect(tableOptionProblems("mysql", [id({ type: "INT" })], o, [fk])).toEqual([
      { code: "partitionForeignKey" },
    ]);
    expect(tableOptionProblems("mysql", [id({ type: "INT" })], o, [])).toEqual([]);
    // パーティションを使わなければ外部キーは問題にならない。
    expect(tableOptionProblems("mysql", [id({ type: "INT" })], opts({ engine: "InnoDB" }), [fk])).toEqual([]);
    // PostgreSQL はパーティション表にも外部キーを付けられる。
    const pg = opts({ partition: part("postgres", { method: "HASH", key: "id" }) });
    expect(tableOptionProblems("postgres", [id({ type: "INT" })], pg, [fk])).toEqual([]);
  });
});

describe("PostgreSQL", () => {
  it("最初の子パーティションは親と別の文として返る (1 回に 1 文しか流せない)", () => {
    const statements = buildCreateTableStatements("postgres", {
      table: "t",
      columns: [id({ type: "INT" })],
      options: opts({
        partition: part("postgres", { method: "HASH", key: "id", firstName: "t_p0", modulus: "2" }),
      }),
    });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE "t" \(/);
    expect(statements[0]).not.toContain("PARTITION OF");
    expect(statements[1]).toBe(
      `CREATE TABLE "t_p0" PARTITION OF "t" FOR VALUES WITH (MODULUS 2, REMAINDER 0);`,
    );
    expect(statements.join("\n")).toBe(
      buildCreateTableSql("postgres", {
        table: "t",
        columns: [id({ type: "INT" })],
        options: opts({
          partition: part("postgres", { method: "HASH", key: "id", firstName: "t_p0", modulus: "2" }),
        }),
      }),
    );
  });

  it("UNLOGGED は CREATE の後ろに入る", () => {
    const sql = buildCreateTableSql("postgres", {
      database: "public",
      table: "t",
      columns: [id()],
      options: opts({ unlogged: true }),
    });
    expect(sql.startsWith('CREATE UNLOGGED TABLE "public"."t" (')).toBe(true);
  });

  it("パーティション表は UNLOGGED にならない (PostgreSQL がエラーにする)", () => {
    const sql = buildCreateTableSql("postgres", {
      table: "t",
      columns: [id()],
      options: opts({ unlogged: true, partition: part("postgres", { method: "HASH", key: "id" }) }),
    });
    expect(sql).not.toContain("UNLOGGED");
    expect(sql).toContain('PARTITION BY HASH ("id");');
  });

  it("RANGE の親と最初の子パーティション (境界は ATTACH と同じビルダー)", () => {
    const columns = [
      col({ name: "id", type: "BIGINT", notNull: true, primaryKey: true }),
      col({ name: "created_at", type: "TIMESTAMPTZ", notNull: true, primaryKey: true }),
    ];
    const sql = buildCreateTableSql("postgres", {
      database: "app",
      table: "events",
      columns,
      options: opts({
        partition: part("postgres", {
          method: "RANGE",
          key: "created_at",
          firstName: "events_2026_01",
          from: "2026-01-01",
          to: "2026-02-01",
        }),
      }),
    });
    expect(sql).toContain('PRIMARY KEY ("id", "created_at")\n) PARTITION BY RANGE ("created_at");');
    expect(sql).toContain(
      `CREATE TABLE "app"."events_2026_01" PARTITION OF "app"."events" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');`,
    );
  });

  it("LIST / HASH の子パーティション。名前が空なら親だけ", () => {
    const columns = [id({ type: "INT" })];
    const make = (p: Partial<PartitionSpec>) =>
      buildCreateTableSql("postgres", {
        table: "t",
        columns,
        options: opts({ partition: part("postgres", { key: "id", ...p }) }),
      });
    expect(make({ method: "LIST", firstName: "t_a", values: "1, 2" })).toContain(
      `CREATE TABLE "t_a" PARTITION OF "t" FOR VALUES IN ('1', '2');`,
    );
    expect(make({ method: "HASH", firstName: "t_h0", modulus: "4", remainder: "0" })).toContain(
      `CREATE TABLE "t_h0" PARTITION OF "t" FOR VALUES WITH (MODULUS 4, REMAINDER 0);`,
    );
    expect(make({ method: "LIST" })).not.toContain("PARTITION OF");
  });

  it("キーの式は括弧で包み、複数列は並べる。素の列名は引用する", () => {
    const columns = [id({ type: "INT" }), col({ name: "Region" })];
    const sql = buildCreateTableSql("postgres", {
      table: "t",
      columns,
      options: opts({ partition: part("postgres", { method: "LIST", key: "lower(Region), id" }) }),
    });
    expect(sql).toContain('PARTITION BY LIST ((lower(Region)), "id");');
  });

  it("主キーにパーティションキーが無いと止める。式のキーは判定しない", () => {
    const columns = [id({ type: "INT" }), col({ name: "created_at", type: "TIMESTAMPTZ" })];
    const p = (key: string) =>
      tableOptionProblems(
        "postgres",
        columns,
        opts({ partition: part("postgres", { method: "RANGE", key }) }),
      );
    expect(p("created_at")).toEqual([{ code: "partitionKeyUnique", columns: ["created_at"] }]);
    expect(p("id")).toEqual([]);
    expect(p("date_trunc('month', created_at)")).toEqual([]);
    expect(p("")).toEqual([{ code: "partitionKeyEmpty" }]);
    expect(p("nope")).toEqual([{ code: "partitionKeyUnknown", columns: ["nope"] }]);
  });

  it("UNIQUE 列にもパーティションキーが要る", () => {
    const columns = [id({ type: "INT", primaryKey: false }), col({ name: "email", unique: true })];
    expect(
      tableOptionProblems(
        "postgres",
        columns,
        opts({ partition: part("postgres", { method: "LIST", key: "id" }) }),
      ),
    ).toEqual([{ code: "partitionKeyUnique", columns: ["id"] }]);
  });

  it("最初の子パーティションを作るなら境界が必要", () => {
    const columns = [id({ type: "INT" })];
    const p = (over: Partial<PartitionSpec>) =>
      tableOptionProblems(
        "postgres",
        columns,
        opts({ partition: part("postgres", { key: "id", firstName: "c", ...over }) }),
      );
    expect(p({ method: "RANGE", from: "1", to: "" })).toEqual([
      { code: "partitionBound", error: "rangeEmpty" },
    ]);
    expect(p({ method: "LIST" })).toEqual([{ code: "partitionBound", error: "listEmpty" }]);
    expect(p({ method: "HASH", modulus: "4", remainder: "4" })).toEqual([
      { code: "partitionBound", error: "hashRemainder" },
    ]);
    expect(p({ method: "RANGE", from: "1", to: "10" })).toEqual([]);
  });

  it("MySQL の KEY は PostgreSQL にない", () => {
    expect(partitionMethods("postgres")).toEqual(["RANGE", "LIST", "HASH"]);
    expect(partitionMethods("mysql")).toEqual(["RANGE", "LIST", "HASH", "KEY"]);
    expect(partitionMethods("sqlite")).toEqual([]);
  });
});

describe("SQLite", () => {
  it("STRICT / WITHOUT ROWID を閉じ括弧の後ろに並べる", () => {
    const columns = [id({ type: "INT" })];
    const sql = (o: Partial<TableOptions>) =>
      buildCreateTableSql("sqlite", { table: "t", columns, options: opts(o) });
    expect(sql({ strict: true })).toMatch(/\n\) STRICT;$/);
    expect(sql({ withoutRowid: true })).toMatch(/\n\) WITHOUT ROWID;$/);
    expect(sql({ strict: true, withoutRowid: true })).toMatch(/\n\) STRICT, WITHOUT ROWID;$/);
  });

  it("STRICT で使えない型を返す (大文字小文字は問わない)", () => {
    const columns = [
      id({ type: "integer" }),
      col({ name: "a", type: "VARCHAR(10)" }),
      col({ name: "b", type: "any" }),
      col({ name: "c", type: "NUMERIC" }),
      col({ name: "d", type: "" }),
    ];
    expect(tableOptionProblems("sqlite", columns, opts({ strict: true }))).toEqual([
      { code: "strictType", columns: ["a", "c"] },
    ]);
    expect(tableOptionProblems("sqlite", columns, opts({ strict: false }))).toEqual([]);
  });

  it("WITHOUT ROWID には主キーが要り、AUTOINCREMENT とは併用できない", () => {
    expect(tableOptionProblems("sqlite", [col({ name: "a" })], opts({ withoutRowid: true }))).toEqual([
      { code: "withoutRowidNoPrimaryKey" },
    ]);
    expect(
      tableOptionProblems("sqlite", [id({ autoIncrement: true })], opts({ withoutRowid: true })),
    ).toEqual([{ code: "withoutRowidAutoIncrement" }]);
    // 検証を通らない入力でも、SQL には AUTOINCREMENT を出さない (WITHOUT ROWID の表では構文エラーになる)。
    const sql = buildCreateTableSql("sqlite", {
      table: "t",
      columns: [id({ autoIncrement: true })],
      options: opts({ withoutRowid: true }),
    });
    expect(sql).not.toContain("AUTOINCREMENT");
    expect(sql).toContain('PRIMARY KEY ("id")');
  });

  it("ほかのドライバのオプションは無視する", () => {
    const o = opts({ engine: "bad engine", unlogged: true, partition: part("mysql", { key: "" }) });
    expect(tableOptionProblems("sqlite", [id()], o)).toEqual([]);
    expect(buildCreateTableSql("sqlite", { table: "t", columns: [id()], options: o })).not.toMatch(
      /ENGINE|UNLOGGED|PARTITION/,
    );
  });
});

// 共有ゴールデン: 同じ JSON を src-tauri/tests の mysql / postgres / sqlite 統合テストが実 DB で流す。
describe("共有ゴールデン (createTableOptionVectors.json)", () => {
  for (const c of vectors.cases) {
    it(`${c.name}: フォームから生成した文が JSON と一致し、検証を通る`, () => {
      const form = c.form as {
        table: string;
        columns: Partial<ColumnDef>[];
        options: Partial<TableOptions> & { partition?: Partial<PartitionSpec> };
      };
      const columns = form.columns.map((x) => col(x));
      const options = opts({
        ...form.options,
        partition: form.options.partition ? part(c.driver, form.options.partition) : null,
      });
      expect(tableOptionProblems(c.driver, columns, options)).toEqual([]);
      expect(buildCreateTableStatements(c.driver, { table: form.table, columns, options })).toEqual(
        c.statements,
      );
    });
  }
});
