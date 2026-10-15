import { describe, expect, it } from "vitest";
import {
  schemaCompareReportMarkdown,
  type SchemaCompareReportLabels,
} from "../components/schemaCompareReport";
import type { SchemaDiff } from "../api/tauri";

const labels: SchemaCompareReportLabels = {
  title: "T",
  source: "S",
  target: "G",
  summaryHeading: "Sum",
  statusLabels: { source_only: "so", target_only: "to", different: "diff", same: "same" },
  tablesHeading: "Tables",
  tableCol: "t",
  statusCol: "s",
  detailCol: "d",
  identical: "identical",
  planHeading: "Plan",
  planNote: "note",
  noStatements: "none",
  warningsHeading: "W",
  destructive: "destructive",
};

const diff: SchemaDiff = {
  source_driver: "mysql",
  target_driver: "mysql",
  warnings: [],
  tables: [
    {
      name: "a|b",
      status: "different",
      columns: [
        {
          name: "c",
          status: "different",
          source: null,
          target: null,
          changed_fields: ["data_type", "nullable"],
        },
      ],
    },
    { name: "x", status: "source_only", columns: [] },
    { name: "same_t", status: "same", columns: [] },
  ],
};

describe("schemaCompareReportMarkdown (#1624)", () => {
  it("要約・テーブル表・同期 SQL を出し、同一テーブルは hideSame で除く", () => {
    const md = schemaCompareReportMarkdown({
      source: "p1 / db1",
      target: "p2 / db2",
      diff,
      plan: {
        statements: [
          { sql: "ALTER TABLE a ADD c INT", table: "a", kind: "add_column", destructive: false },
          { sql: "DROP TABLE y;", table: "y", kind: "drop_table", destructive: true },
        ],
        warnings: ["w1"],
      },
      hideSame: true,
      labels,
    });
    expect(md).toContain("- S: `p1 / db1`");
    expect(md).toContain("- diff: 1\n- so: 1\n- to: 0\n- same: 1");
    expect(md).toContain("| a\\|b | diff | c (data_type, nullable) |");
    expect(md).toContain("| x | so |  |");
    expect(md).not.toContain("same_t");
    expect(md).toContain("```sql\nALTER TABLE a ADD c INT;\n-- destructive\nDROP TABLE y;\n```");
    expect(md).toContain("### W\n\n- w1");
  });

  it("プランが無ければ SQL 節を出さず、全件非表示なら identical を出す", () => {
    const md = schemaCompareReportMarkdown({
      source: "a",
      target: "b",
      diff: { ...diff, tables: [{ name: "same_t", status: "same", columns: [] }] },
      plan: null,
      hideSame: true,
      labels,
    });
    expect(md).not.toContain("## Plan");
    expect(md).toContain("identical");
  });

  it("SQL 本文に ``` があってもフェンスを長くして閉じない", () => {
    const md = schemaCompareReportMarkdown({
      source: "a",
      target: "b",
      diff,
      plan: {
        statements: [{ sql: "SELECT '```'", table: "t", kind: "add_column", destructive: false }],
        warnings: [],
      },
      hideSame: false,
      labels,
    });
    expect(md).toContain("````sql");
  });
});
