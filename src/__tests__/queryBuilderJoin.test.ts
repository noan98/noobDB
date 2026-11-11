import { describe, expect, it } from "vitest";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import {
  buildSql,
  computeBuilderBlockedReason,
  liveWhereConditions,
  type AdvancedSelectInput,
  type OrderByItem,
  type QueryBuilderSnapshot,
  type WhereCondition,
} from "../components/QueryBuilder";
import { fkRelations } from "../components/fkJoin";
import {
  completeOn,
  fkJoinCandidates,
  joinFromCandidate,
  legacySelectColumns,
  manualJoin,
  restoreJoinFields,
  uniqueJoinAlias,
  type QbJoin,
} from "../components/queryBuilderJoin";
import { normalizePersistedWorkspace } from "../tabPersistence";

/**
 * クエリビルダの JOIN / GROUP BY / 集計 / HAVING (#2242)。3 ドライバで生成 SQL を固定する。
 * 画面ではなく純ロジック (`buildSql` の結合・集計経路、外部キー候補、スナップショット移行)。
 */

const col = (name: string, type = "int", nullable = true, key = ""): TableColumnInfo => ({
  name,
  data_type: type,
  nullable,
  key,
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
});

const ORDERS = [
  col("id", "int", false, "PRI"),
  col("customer_id"),
  col("total", "decimal"),
  col("status", "varchar"),
];
const CUSTOMERS = [col("id", "int", false, "PRI"), col("name", "varchar")];
const EMPLOYEES = [col("id", "int", false, "PRI"), col("manager_id"), col("name", "varchar")];

const toCustomers: QbJoin = {
  table: "customers",
  alias: "customers",
  type: "INNER",
  on: [{ leftColumn: "customer_id", rightColumn: "id" }],
};

function adv(over: Partial<AdvancedSelectInput> = {}): AdvancedSelectInput {
  return {
    joins: [],
    selectItems: [],
    aggColumns: [],
    having: [],
    infoByAlias: { orders: ORDERS, customers: CUSTOMERS, employees: EMPLOYEES, employees_2: EMPLOYEES },
    ...over,
  };
}

function select(
  driver: string,
  a: AdvancedSelectInput,
  opts: {
    base?: string;
    selectAll?: boolean;
    where?: WhereCondition[];
    orderBy?: OrderByItem[];
    limit?: boolean;
  } = {},
): string {
  const base = opts.base ?? "orders";
  return buildSql(
    driver,
    a.infoByAlias[base] ?? [],
    "SELECT",
    "shop",
    base,
    [],
    opts.selectAll ?? false,
    (opts.where ?? []).length > 0,
    opts.where ?? [],
    opts.orderBy ?? [],
    opts.limit ?? false,
    "100",
    [],
    [],
    "",
    a,
  );
}

describe("結合 + 集計 + HAVING を 3 ドライバで生成する", () => {
  const input = adv({
    joins: [toCustomers],
    selectItems: [{ table: "customers", column: "name" }],
    aggColumns: [
      { column: "*", agg: "COUNT", as: "n" },
      { column: "total", agg: "SUM", as: "revenue" },
    ],
    having: [{ column: "*", agg: "COUNT", operator: ">", value: "5" }],
  });
  const orderBy: OrderByItem[] = [{ column: "total", agg: "SUM", direction: "DESC" }];

  it("MySQL", () => {
    expect(select("mysql", input, { orderBy, limit: true })).toBe(
      "SELECT `customers`.`name`, COUNT(*) AS `n`, SUM(`orders`.`total`) AS `revenue` " +
        "FROM `shop`.`orders` INNER JOIN `shop`.`customers` ON `orders`.`customer_id` = `customers`.`id` " +
        "GROUP BY `customers`.`name` HAVING COUNT(*) > 5 ORDER BY SUM(`orders`.`total`) DESC LIMIT 100;",
    );
  });

  it("PostgreSQL", () => {
    expect(select("postgres", input, { orderBy, limit: true })).toBe(
      'SELECT "customers"."name", COUNT(*) AS "n", SUM("orders"."total") AS "revenue" ' +
        'FROM "shop"."orders" INNER JOIN "shop"."customers" ON "orders"."customer_id" = "customers"."id" ' +
        'GROUP BY "customers"."name" HAVING COUNT(*) > 5 ORDER BY SUM("orders"."total") DESC LIMIT 100;',
    );
  });

  it("SQLite (データベース修飾なし)", () => {
    expect(select("sqlite", input, { orderBy, limit: true })).toBe(
      'SELECT "customers"."name", COUNT(*) AS "n", SUM("orders"."total") AS "revenue" ' +
        'FROM "orders" INNER JOIN "customers" ON "orders"."customer_id" = "customers"."id" ' +
        'GROUP BY "customers"."name" HAVING COUNT(*) > 5 ORDER BY SUM("orders"."total") DESC LIMIT 100;',
    );
  });

  it("3 表の結合は ON を AND でつなぎ、LEFT も使える", () => {
    const three = adv({
      joins: [
        toCustomers,
        {
          table: "employees",
          alias: "employees",
          type: "LEFT",
          on: [
            { leftTable: "customers", leftColumn: "id", rightColumn: "id" },
            { leftColumn: "status", rightColumn: "name" },
          ],
        },
      ],
      selectItems: [{ column: "id" }],
    });
    expect(select("postgres", three)).toBe(
      'SELECT "orders"."id" FROM "shop"."orders" ' +
        'INNER JOIN "shop"."customers" ON "orders"."customer_id" = "customers"."id" ' +
        'LEFT JOIN "shop"."employees" ON "customers"."id" = "employees"."id" AND "orders"."status" = "employees"."name";',
    );
  });
});

describe("GROUP BY の自動生成と境界", () => {
  it("集計しない列がすべて GROUP BY に入る (複数列・重複なし)", () => {
    const a = adv({
      joins: [toCustomers],
      selectItems: [{ table: "customers", column: "name" }, { column: "status" }],
      aggColumns: [
        { column: "id", agg: "COUNT_DISTINCT", as: "orders_n" },
        // 集計なしの別名つき列も GROUP BY に入る。
        { column: "status", as: "st" },
      ],
    });
    expect(select("mysql", a)).toBe(
      "SELECT `customers`.`name`, `orders`.`status`, COUNT(DISTINCT `orders`.`id`) AS `orders_n`, `orders`.`status` AS `st` " +
        "FROM `shop`.`orders` INNER JOIN `shop`.`customers` ON `orders`.`customer_id` = `customers`.`id` " +
        "GROUP BY `customers`.`name`, `orders`.`status`;",
    );
  });

  it("集計がなければ GROUP BY を出さない (結合だけ)", () => {
    const a = adv({ joins: [toCustomers], selectItems: [{ table: "customers", column: "name" }] });
    expect(select("mysql", a)).not.toContain("GROUP BY");
  });

  it("全部集計なら GROUP BY を出さない", () => {
    const a = adv({
      aggColumns: [
        { column: "total", agg: "AVG" },
        { column: "*", agg: "COUNT" },
      ],
    });
    expect(select("postgres", a)).toBe('SELECT AVG("orders"."total"), COUNT(*) FROM "shop"."orders";');
  });

  it("結合なしの集計も修飾付きで出る", () => {
    const a = adv({ selectItems: [{ column: "status" }], aggColumns: [{ column: "total", agg: "MAX" }] });
    expect(select("sqlite", a)).toBe(
      'SELECT "orders"."status", MAX("orders"."total") FROM "orders" GROUP BY "orders"."status";',
    );
  });

  it("HAVING だけがあるときも、選んだ列を GROUP BY に入れる", () => {
    const a = adv({
      selectItems: [{ column: "status" }],
      having: [{ column: "*", agg: "COUNT", operator: ">=", value: "2" }],
    });
    expect(select("mysql", a)).toBe(
      "SELECT `orders`.`status` FROM `shop`.`orders` GROUP BY `orders`.`status` HAVING COUNT(*) >= 2;",
    );
  });

  it("「すべての列」+ 結合は 表.* を並べる", () => {
    const a = adv({ joins: [toCustomers] });
    expect(select("postgres", a, { selectAll: true })).toBe(
      'SELECT "orders".*, "customers".* FROM "shop"."orders" INNER JOIN "shop"."customers" ON "orders"."customer_id" = "customers"."id";',
    );
  });
});

describe("自己結合と同名列の別名", () => {
  const self: QbJoin = {
    table: "employees",
    alias: "employees_2",
    type: "LEFT",
    on: [{ leftColumn: "manager_id", rightColumn: "id" }],
  };

  it("自己結合は別名つきで JOIN し、同名の列には自動で別名を付ける", () => {
    const a = adv({
      joins: [self],
      selectItems: [{ column: "name" }, { table: "employees_2", column: "name" }, { column: "id" }],
    });
    expect(select("mysql", a, { base: "employees" })).toBe(
      "SELECT `employees`.`name` AS `employees_name`, `employees_2`.`name` AS `employees_2_name`, `employees`.`id` " +
        "FROM `shop`.`employees` LEFT JOIN `shop`.`employees` AS `employees_2` ON `employees`.`manager_id` = `employees_2`.`id`;",
    );
  });

  it("利用者が付けた別名は自動の別名より優先し、衝突しなければ付けない", () => {
    const a = adv({
      joins: [self],
      selectItems: [{ column: "name" }],
      aggColumns: [{ table: "employees_2", column: "name", as: "manager" }],
    });
    expect(select("postgres", a, { base: "employees" })).toContain(
      'SELECT "employees"."name", "employees_2"."name" AS "manager" FROM',
    );
  });

  it("別名の識別子は各ドライバの引用符で閉じる (引用符を含む名前)", () => {
    const a = adv({
      selectItems: [{ column: "id" }],
      aggColumns: [{ column: "*", agg: "COUNT", as: 'a"b`c' }],
    });
    expect(select("postgres", a)).toContain('AS "a""b`c"');
    expect(select("mysql", a)).toContain('AS `a"b``c`');
  });
});

describe("WHERE / HAVING の値のクォート", () => {
  it("結合先の列は型に応じてクォートし、NULL と IS NULL を出し分ける", () => {
    const a = adv({ joins: [toCustomers], selectItems: [{ column: "id" }] });
    const where: WhereCondition[] = [
      { table: "customers", column: "name", operator: "=", value: "it's" },
      { table: "customers", column: "name", operator: "=", value: "NULL", connector: "AND" },
      { table: "customers", column: "name", operator: "IS NOT NULL", value: "", connector: "OR" },
      { column: "status", operator: "=", value: "123", connector: "AND" },
    ];
    expect(select("postgres", a, { where })).toBe(
      'SELECT "orders"."id" FROM "shop"."orders" INNER JOIN "shop"."customers" ON "orders"."customer_id" = "customers"."id" ' +
        'WHERE "customers"."name" = \'it\'\'s\' AND "customers"."name" = NULL OR "customers"."name" IS NOT NULL AND "orders"."status" = \'123\';',
    );
  });

  it("バックスラッシュは MySQL だけ二重にする", () => {
    const a = adv({ joins: [toCustomers], selectItems: [{ column: "id" }] });
    const where: WhereCondition[] = [{ table: "customers", column: "name", operator: "=", value: "a\\b" }];
    expect(select("mysql", a, { where })).toContain("`customers`.`name` = 'a\\\\b'");
    expect(select("postgres", a, { where })).toContain('"customers"."name" = \'a\\b\'');
    expect(select("sqlite", a, { where })).toContain('"customers"."name" = \'a\\b\'');
  });

  it("MIN / MAX の HAVING は元の列の型でクォートし、COUNT / SUM は数値のまま", () => {
    const a = adv({
      joins: [toCustomers],
      aggColumns: [{ table: "customers", column: "name", agg: "MIN" }],
      having: [
        { table: "customers", column: "name", agg: "MIN", operator: ">", value: "abc" },
        { column: "total", agg: "SUM", operator: "<=", value: "1000.5" },
        { column: "*", agg: "COUNT", operator: "!=", value: "0" },
      ],
    });
    expect(select("mysql", a)).toContain(
      "HAVING MIN(`customers`.`name`) > 'abc' AND SUM(`orders`.`total`) <= 1000.5 AND COUNT(*) != 0",
    );
  });

  it("HAVING の値が空なら <value> を出す (実行はブロックされる)", () => {
    const a = adv({
      aggColumns: [{ column: "*", agg: "COUNT" }],
      having: [{ column: "*", agg: "COUNT", operator: ">", value: "" }],
    });
    expect(select("mysql", a)).toContain("HAVING COUNT(*) > <value>");
  });
});

describe("結合を使わない形は従来どおり", () => {
  it("advanced が空なら従来の SELECT (修飾なし)", () => {
    const sql = buildSql(
      "mysql",
      ORDERS,
      "SELECT",
      "shop",
      "orders",
      ["id"],
      false,
      false,
      [],
      [],
      true,
      "10",
      [],
      [],
    );
    expect(sql).toBe("SELECT `id` FROM `shop`.`orders` LIMIT 10;");
    // 結合も集計も無ければ、adv を渡しても従来の経路 (修飾なし) を通る。
    expect(select("mysql", adv({ selectItems: [{ column: "id" }] }), { limit: true })).toBe(
      "SELECT * FROM `shop`.`orders` LIMIT 100;",
    );
  });

  it("INSERT / UPDATE / DELETE は結合を無視する", () => {
    const a = adv({ joins: [toCustomers], aggColumns: [{ column: "*", agg: "COUNT" }] });
    const where: WhereCondition[] = [{ column: "id", operator: "=", value: "1" }];
    const del = buildSql(
      "mysql",
      ORDERS,
      "DELETE",
      "shop",
      "orders",
      [],
      true,
      true,
      where,
      [],
      false,
      "",
      [],
      [],
      "",
      a,
    );
    expect(del).toBe("DELETE FROM `shop`.`orders` WHERE `id` = 1;");
    const upd = buildSql(
      "postgres",
      ORDERS,
      "UPDATE",
      "shop",
      "orders",
      [],
      true,
      true,
      where,
      [],
      false,
      "",
      [{ column: "status", value: "x" }],
      [],
      "",
      a,
    );
    expect(upd).toBe('UPDATE "shop"."orders" SET "status" = \'x\' WHERE "id" = 1;');
  });

  it("外した結合を指す条件・並べ替えは落とす", () => {
    const where: WhereCondition[] = [{ table: "customers", column: "name", operator: "=", value: "x" }];
    const orderBy: OrderByItem[] = [{ table: "customers", column: "name", direction: "ASC" }];
    const sql = buildSql(
      "mysql",
      ORDERS,
      "SELECT",
      "shop",
      "orders",
      ["id"],
      false,
      true,
      where,
      orderBy,
      false,
      "",
      [],
      [],
    );
    expect(sql).toContain("WHERE <column> = <value>");
    expect(sql).not.toContain("ORDER BY");
    expect(liveWhereConditions(where, "orders", ["customers"])[0].column).toBe("name");
    expect(liveWhereConditions(where, "orders", [])[0].column).toBe("");
  });
});

describe("computeBuilderBlockedReason (結合・集計)", () => {
  const base = {
    kind: "SELECT" as const,
    table: "orders",
    whereEnabled: false,
    whereConditions: [],
    setPairs: [],
    insertPairs: [],
    selectAll: false,
    selectColumns: [] as string[],
  };

  it("集計列があれば、素の列が 0 でも列の指定なしにならない", () => {
    expect(computeBuilderBlockedReason(base)).toBe("qbValidationNoSelectColumns");
    expect(
      computeBuilderBlockedReason({
        ...base,
        advanced: adv({ aggColumns: [{ column: "*", agg: "COUNT" }] }),
      }),
    ).toBeNull();
  });

  it("ON が未完成の結合・`*` の COUNT 以外・HAVING の値なしをブロックする", () => {
    const sel = { selectAll: false, selectColumns: ["id"] };
    expect(
      computeBuilderBlockedReason({
        ...base,
        ...sel,
        advanced: adv({ joins: [manualJoin("orders", [], "customers")] }),
      }),
    ).toBe("qbValidationJoinOn");
    expect(
      computeBuilderBlockedReason({
        ...base,
        advanced: adv({ aggColumns: [{ column: "*", agg: "SUM" }] }),
      }),
    ).toBe("qbValidationAggStar");
    expect(
      computeBuilderBlockedReason({
        ...base,
        advanced: adv({
          aggColumns: [{ column: "*", agg: "COUNT" }],
          having: [{ column: "*", agg: "COUNT", operator: ">", value: " " }],
        }),
      }),
    ).toBe("qbValidationNoHavingValue");
    expect(
      computeBuilderBlockedReason({
        ...base,
        selectAll: true,
        advanced: adv({ having: [{ column: "*", agg: "COUNT", operator: ">", value: "1" }] }),
      }),
    ).toBe("qbValidationHavingSelectAll");
  });

  it("集計があるとき、グループ化していない列での ORDER BY は ONLY_FULL_GROUP_BY に落ちるのでブロックする", () => {
    const a = adv({
      selectItems: [{ column: "status" }],
      aggColumns: [{ column: "*", agg: "COUNT" }],
    });
    const input = { ...base, selectColumns: ["status"], advanced: a };
    expect(computeBuilderBlockedReason({ ...input, orderBy: [{ column: "total", direction: "ASC" }] })).toBe(
      "qbValidationOrderNotGrouped",
    );
    expect(
      computeBuilderBlockedReason({ ...input, orderBy: [{ column: "status", direction: "ASC" }] }),
    ).toBeNull();
    expect(
      computeBuilderBlockedReason({ ...input, orderBy: [{ column: "*", agg: "COUNT", direction: "DESC" }] }),
    ).toBeNull();
    // 集計なしの問い合わせで集計の並べ替えを使うと不正な SQL になる。
    expect(
      computeBuilderBlockedReason({
        ...base,
        selectColumns: ["status"],
        advanced: adv({ selectItems: [{ column: "status" }] }),
        orderBy: [{ column: "*", agg: "COUNT", direction: "DESC" }],
      }),
    ).toBe("qbValidationOrderNotGrouped");
  });

  it("結合を外したあとに残った条件は、空の条件として数える", () => {
    expect(
      computeBuilderBlockedReason({
        ...base,
        selectAll: true,
        whereEnabled: true,
        whereConditions: [{ table: "customers", column: "name", operator: "=", value: "x" }],
      }),
    ).toBe("qbValidationNoWhereConditions");
  });
});

describe("外部キーからの表の追加候補", () => {
  const fks: ForeignKey[] = [
    {
      table: "orders",
      column: "customer_id",
      referenced_table: "customers",
      referenced_column: "id",
      constraint_name: "fk_oc",
    },
    {
      table: "employees",
      column: "manager_id",
      referenced_table: "employees",
      referenced_column: "id",
      constraint_name: "fk_mgr",
    },
    // 複合キー
    {
      table: "order_items",
      column: "order_id",
      referenced_table: "orders",
      referenced_column: "id",
      constraint_name: "fk_oi",
    },
    {
      table: "order_items",
      column: "line",
      referenced_table: "orders",
      referenced_column: "line",
      constraint_name: "fk_oi",
    },
    // 参照先の列が分からない制約は出さない
    {
      table: "orders",
      column: "x",
      referenced_table: "xs",
      referenced_column: null,
      constraint_name: "fk_x",
    },
  ];

  it("参照する側・参照される側の両方向を、ON の列の組つきで返す", () => {
    const cands = fkJoinCandidates({ baseTable: "orders", joins: [], fks });
    expect(cands.map((c) => [c.table, c.direction])).toEqual([
      ["customers", "outgoing"],
      ["order_items", "incoming"],
    ]);
    expect(cands[0].on).toEqual([{ leftTable: undefined, leftColumn: "customer_id", rightColumn: "id" }]);
    // 複合キーは同じ制約の列を 1 つの候補にまとめる。
    expect(cands[1].on).toEqual([
      { leftTable: undefined, leftColumn: "id", rightColumn: "order_id" },
      { leftTable: undefined, leftColumn: "line", rightColumn: "line" },
    ]);
  });

  it("結合済みの表からもつながる表を出す (3 表目)", () => {
    const j = joinFromCandidate("orders", [], fkJoinCandidates({ baseTable: "orders", joins: [], fks })[0]);
    expect(j).toMatchObject({ table: "customers", alias: "customers", type: "INNER" });
    const next = fkJoinCandidates({
      baseTable: "orders",
      joins: [j],
      fks: [
        ...fks,
        {
          table: "customers",
          column: "region_id",
          referenced_table: "regions",
          referenced_column: "id",
          constraint_name: "fk_cr",
        },
      ],
    });
    const region = next.find((c) => c.table === "regions");
    expect(region?.fromAlias).toBe("customers");
    expect(region?.on).toEqual([{ leftTable: "customers", leftColumn: "region_id", rightColumn: "id" }]);
  });

  it("自己参照は両方向を候補に出し、別名は <表>_2 になる", () => {
    const cands = fkJoinCandidates({ baseTable: "employees", joins: [], fks });
    expect(cands.map((c) => c.direction).sort()).toEqual(["incoming", "outgoing"]);
    const j = joinFromCandidate("employees", [], cands.find((c) => c.direction === "outgoing") ?? cands[0]);
    expect(j.alias).toBe("employees_2");
    expect(uniqueJoinAlias("employees", ["employees", "employees_2"])).toBe("employees_3");
    expect(uniqueJoinAlias("Customers", ["customers"])).toBe("Customers_2");
  });

  it("FK のない表は手動の結合 (ON は空の 1 組) で足す", () => {
    const j = manualJoin("orders", [], "customers");
    expect(j.on).toEqual([{ leftColumn: "", rightColumn: "" }]);
    expect(completeOn(j)).toEqual([]);
  });

  it("PostgreSQL が複合 FK を交差積で返し列対応を復元できないときは出さない", () => {
    const cross: ForeignKey[] = [
      { table: "a", column: "x", referenced_table: "b", referenced_column: "p", constraint_name: "k" },
      { table: "a", column: "x", referenced_table: "b", referenced_column: "q", constraint_name: "k" },
    ];
    expect(fkRelations("a", cross)).toEqual([]);
  });
});

describe("スナップショットの後方互換", () => {
  const legacy: QueryBuilderSnapshot = {
    kind: "SELECT",
    database: "shop",
    table: "orders",
    selectAll: false,
    selectColumns: ["id", "status"],
    whereEnabled: false,
    whereConditions: [{ column: "id", operator: "=", value: "1" }],
    limitEnabled: true,
    limit: "100",
    setPairs: [],
    insertPairs: [],
  };

  it("以前の形式 (selectColumns だけ) は基点の表の素の列に読み替える", () => {
    expect(restoreJoinFields(legacy)).toEqual({
      selectItems: [{ column: "id" }, { column: "status" }],
      aggColumns: [],
      joins: [],
      having: [],
    });
    expect(restoreJoinFields(null)).toEqual({ selectItems: [], aggColumns: [], joins: [], having: [] });
  });

  it("以前の形式から生成した SQL は結合前と同じ", () => {
    const items = restoreJoinFields(legacy).selectItems;
    const sql = buildSql(
      "mysql",
      ORDERS,
      "SELECT",
      "shop",
      "orders",
      legacySelectColumns(items),
      false,
      false,
      legacy.whereConditions,
      [],
      true,
      "100",
      [],
      [],
      "",
      adv({ selectItems: items }),
    );
    expect(sql).toBe("SELECT `id`, `status` FROM `shop`.`orders` LIMIT 100;");
  });

  it("新形式は selectItems を優先し、旧形式の読み手向けに基点の素の列だけを併記する", () => {
    const next: QueryBuilderSnapshot = {
      ...legacy,
      selectColumns: ["id"],
      selectItems: [{ column: "id" }, { table: "customers", column: "name" }],
      aggColumns: [{ column: "*", agg: "COUNT", as: "n" }],
      joins: [toCustomers],
      having: [{ column: "*", agg: "COUNT", operator: ">", value: "1" }],
    };
    const r = restoreJoinFields(next);
    expect(r.selectItems).toEqual(next.selectItems);
    expect(r.joins).toEqual([toCustomers]);
    expect(r.joins[0]).not.toBe(toCustomers); // 参照は共有しない
    expect(legacySelectColumns(r.selectItems)).toEqual(["id"]);
  });

  it("タブの永続化は新旧どちらのスナップショットも保持し、壊れた結合は捨てる", () => {
    const next: QueryBuilderSnapshot = {
      ...legacy,
      joins: [toCustomers],
      selectItems: [{ column: "id" }],
      aggColumns: [{ column: "*", agg: "COUNT" }],
      having: [{ column: "*", agg: "COUNT", operator: ">", value: "1" }],
      whereConditions: [{ table: "customers", column: "name", operator: "=", value: "x" }],
      orderBy: [{ column: "*", agg: "COUNT", direction: "DESC" }],
    };
    const tab = (builderSnapshot: unknown) => ({
      kind: "query",
      title: "Q",
      sql: "SELECT 1",
      builderSnapshot,
    });
    const restore = (s: unknown) =>
      normalizePersistedWorkspace({ panes: [{ tabs: [tab(s)], activeIndex: 0 }], activePane: 0 });
    expect(restore(legacy).panes[0].tabs[0].builderSnapshot).toEqual(legacy);
    expect(restore(next).panes[0].tabs[0].builderSnapshot).toEqual(next);
    expect(restore({ ...next, joins: [{ table: "x" }] }).panes[0].tabs[0].builderSnapshot).toBeUndefined();
    expect(
      restore({ ...next, aggColumns: [{ column: "id", agg: "MEDIAN" }] }).panes[0].tabs[0].builderSnapshot,
    ).toBeUndefined();
  });
});

describe("データ破壊の防止 (#2242 レビュー)", () => {
  const base = {
    table: "orders",
    whereEnabled: true,
    setPairs: [{ column: "status", value: "y" }],
    insertPairs: [],
    selectAll: true,
    selectColumns: [] as string[],
  };
  const conds: WhereCondition[] = [
    { column: "status", operator: "=", value: "x" },
    { table: "customers", column: "country", operator: "=", value: "JP", connector: "AND" },
  ];

  it("基点の条件 + 結合先の条件のまま DELETE / UPDATE に切り替えるとブロックされる", () => {
    for (const kind of ["DELETE", "UPDATE"] as const) {
      expect(computeBuilderBlockedReason({ ...base, kind, whereConditions: conds })).toBe(
        "qbValidationWhereForeignTable",
      );
    }
    // SELECT では結合先の条件は有効。
    expect(
      computeBuilderBlockedReason({
        ...base,
        kind: "SELECT",
        whereConditions: conds,
        advanced: adv({ joins: [toCustomers] }),
      }),
    ).toBeNull();
    // 基点の表の条件だけなら通る。
    expect(computeBuilderBlockedReason({ ...base, kind: "DELETE", whereConditions: [conds[0]] })).toBeNull();
  });

  it("HAVING の COUNT / SUM / AVG は数値以外を止める (MIN / MAX は止めない)", () => {
    const sel = { ...base, kind: "SELECT" as const, whereEnabled: false, whereConditions: [] };
    const h = (agg: "COUNT" | "MIN", value: string) =>
      computeBuilderBlockedReason({
        ...sel,
        advanced: adv({
          aggColumns: [{ column: "status", agg }],
          having: [{ column: "status", agg, operator: ">", value }],
        }),
        selectAll: false,
      });
    expect(h("COUNT", "abc")).toBe("qbValidationHavingNotNumber");
    expect(h("COUNT", "3")).toBeNull();
    expect(h("MIN", "abc")).toBeNull();
  });
});
