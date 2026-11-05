import { describe, expect, it } from "vitest";
import {
  classifyPlanNode,
  parsePlan,
  parsePostgresPlan,
  parseSqlitePlan,
  type PlanNode,
  type PlanNodeCategory,
} from "../components/explainPlan";

function node(kind: string, label: string, attrs: [string, unknown][] = []): PlanNode {
  return { id: "p", kind, label, cost: null, attrs, children: [] };
}

describe("classifyPlanNode (#2017)", () => {
  const cases: [string, PlanNode, PlanNodeCategory][] = [
    // PostgreSQL: kind は Node Type
    ["pg Seq Scan", node("Seq Scan", "Seq Scan on users"), "scan"],
    ["pg Index Scan", node("Index Scan", "Index Scan using users_pkey"), "index"],
    ["pg Index Only Scan", node("Index Only Scan", "Index Only Scan on t"), "index"],
    ["pg Bitmap Heap Scan", node("Bitmap Heap Scan", "Bitmap Heap Scan on t"), "index"],
    ["pg Bitmap Index Scan", node("Bitmap Index Scan", "Bitmap Index Scan using i"), "index"],
    ["pg Hash Join", node("Hash Join", "Hash Join"), "join"],
    ["pg Merge Join", node("Merge Join", "Merge Join"), "join"],
    ["pg Nested Loop", node("Nested Loop", "Nested Loop"), "join"],
    ["pg Sort", node("Sort", "Sort"), "sort"],
    ["pg Incremental Sort", node("Incremental Sort", "Incremental Sort"), "sort"],
    ["pg Aggregate", node("Aggregate", "Aggregate"), "aggregate"],
    ["pg HashAggregate", node("HashAggregate", "HashAggregate"), "aggregate"],
    ["pg WindowAgg", node("WindowAgg", "WindowAgg"), "aggregate"],
    ["pg Hash (join の build 側)", node("Hash", "Hash"), "other"],
    ["pg Limit", node("Limit", "Limit"), "other"],
    ["pg テーブル名に sort を含んでも Seq Scan", node("Seq Scan", "Seq Scan on sort_orders"), "scan"],
    // MySQL JSON
    ["mysql nested_loop", node("nested_loop", "Nested loop"), "join"],
    ["mysql ordering_operation", node("ordering_operation", "Ordering"), "sort"],
    ["mysql grouping_operation", node("grouping_operation", "Grouping"), "aggregate"],
    ["mysql duplicates_removal", node("duplicates_removal", "Duplicates removal"), "aggregate"],
    ["mysql query_block", node("query_block", "Query block"), "other"],
    ["mysql table ALL", node("table", "Table: t", [["access_type", "ALL"]]), "scan"],
    ["mysql table ref", node("table", "Table: t", [["access_type", "ref"]]), "index"],
    ["mysql table range", node("table", "Table: t", [["access_type", "range"]]), "index"],
    [
      "mysql table index (全インデックス走査)",
      node("table", "Table: t", [["access_type", "index"]]),
      "index",
    ],
    ["mysql table access_type 不明", node("table", "Table: t"), "other"],
    // MySQL TREE (EXPLAIN ANALYZE)
    ["mysql tree Table scan", node("mysqlStep", "Table scan on t"), "scan"],
    ["mysql tree Index lookup", node("mysqlStep", "Index lookup on t using idx (a=1)"), "index"],
    ["mysql tree Index range scan", node("mysqlStep", "Index range scan on t using idx"), "index"],
    [
      "mysql tree Single-row index lookup",
      node("mysqlStep", "Single-row index lookup on t using PRIMARY"),
      "index",
    ],
    ["mysql tree Nested loop inner join", node("mysqlStep", "Nested loop inner join"), "join"],
    ["mysql tree Inner hash join", node("mysqlStep", "Inner hash join (t1.a = t2.a)"), "join"],
    ["mysql tree Sort", node("mysqlStep", "Sort: t.a DESC"), "sort"],
    ["mysql tree Aggregate", node("mysqlStep", "Aggregate: count(0)"), "aggregate"],
    ["mysql tree Group aggregate", node("mysqlStep", "Group aggregate: count(0)"), "aggregate"],
    ["mysql tree Filter", node("mysqlStep", "Filter: (t.a > 1)"), "other"],
    ["mysql tree Hash semijoin", node("mysqlStep", "Hash semijoin (t1.a = t2.a)"), "join"],
    [
      "mysql tree 条件式に sort を含む join",
      node("mysqlStep", "Inner hash join (t1.sort = t2.sort)"),
      "join",
    ],
    ["mysql tree 条件式に index を含む Filter", node("mysqlStep", "Filter: (o.index > 1)"), "other"],
    ["pg Group", node("Group", "Group"), "aggregate"],
    ["pg Sample Scan", node("Sample Scan", "Sample Scan on t"), "scan"],
    ["pg Tid Range Scan", node("Tid Range Scan", "Tid Range Scan on t"), "scan"],
    ["kind が Object.prototype のキー", node("constructor", "constructor"), "other"],
    ["sqlite 表名が sort の SCAN", node("sqliteStep", "SCAN sort"), "scan"],
    // SQLite
    ["sqlite SCAN", node("sqliteStep", "SCAN users"), "scan"],
    ["sqlite SEARCH USING INDEX", node("sqliteStep", "SEARCH users USING INDEX idx_a (a=?)"), "index"],
    ["sqlite SEARCH rowid", node("sqliteStep", "SEARCH users USING INTEGER PRIMARY KEY (rowid=?)"), "index"],
    ["sqlite SCAN COVERING INDEX", node("sqliteStep", "SCAN users USING COVERING INDEX idx_a"), "index"],
    ["sqlite ORDER BY の一時 B-tree", node("sqliteStep", "USE TEMP B-TREE FOR ORDER BY"), "sort"],
    ["sqlite GROUP BY の一時 B-tree", node("sqliteStep", "USE TEMP B-TREE FOR GROUP BY"), "aggregate"],
    ["sqlite DISTINCT の一時 B-tree", node("sqliteStep", "USE TEMP B-TREE FOR DISTINCT"), "aggregate"],
    ["sqlite 合成ルート", node("queryPlan", "QUERY PLAN"), "other"],
  ];
  it.each(cases)("%s", (_name, n, want) => {
    expect(classifyPlanNode(n)).toBe(want);
  });

  it("実際にパースした 3 ドライバのプランでも分類できる", () => {
    const pg = parsePostgresPlan(
      JSON.stringify([
        { Plan: { "Node Type": "Sort", Plans: [{ "Node Type": "Seq Scan", "Relation Name": "t" }] } },
      ]),
    );
    expect(pg.root && classifyPlanNode(pg.root)).toBe("sort");
    expect(pg.root && classifyPlanNode(pg.root.children[0])).toBe("scan");

    const my = parsePlan(
      JSON.stringify({ query_block: { select_id: 1, table: { table_name: "t", access_type: "ALL" } } }),
    );
    expect(my.root && classifyPlanNode(my.root)).toBe("other");
    expect(my.root && classifyPlanNode(my.root.children[0])).toBe("scan");

    const sq = parseSqlitePlan([{ id: 2, parent: 0, detail: "SEARCH t USING INDEX i (a=?)" }]);
    expect(sq.root && classifyPlanNode(sq.root)).toBe("index");
  });
});
