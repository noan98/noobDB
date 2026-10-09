import { describe, expect, it } from "vitest";
import type { SchemaDiff, SyncStatement, TableColumnInfo } from "../api/tauri";
import {
  buildSyncRiskPrompt,
  buildSyncRiskSystem,
  countDmlStatements,
  selectStatementsForPrompt,
  finalizeRiskItems,
  isDestructiveStatement,
  parseSyncRiskResponse,
  SYNC_RISK_FORMAT,
  SYNC_RISK_MAX_STATEMENTS,
  summarizeSchemaDiff,
  type SyncRiskInput,
} from "../ai/syncRisk";

function col(over: Partial<TableColumnInfo> = {}): TableColumnInfo {
  return {
    name: "email",
    data_type: "varchar(50)",
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

function stmt(sql: string, kind: SyncStatement["kind"], destructive = false, table = "users"): SyncStatement {
  return { sql, table, kind, destructive };
}

const DIFF: SchemaDiff = {
  source_driver: "mysql",
  target_driver: "mysql",
  tables: [
    { name: "same_tbl", status: "same", columns: [] },
    {
      name: "users",
      status: "different",
      columns: [
        {
          name: "email",
          status: "different",
          source: col({ data_type: "varchar(50)", default: "secret-default-value" }),
          target: col({ data_type: "varchar(255)", nullable: true }),
          changed_fields: ["data_type", "nullable", "default"],
        },
      ],
    },
    {
      name: "legacy",
      status: "target_only",
      columns: [
        { name: "id", status: "target_only", source: null, target: col({ name: "id", data_type: "int" }), changed_fields: [] },
      ],
    },
  ],
};

function input(over: Partial<SyncRiskInput> = {}): SyncRiskInput {
  return {
    planKind: "schema",
    sourceDriver: "mysql",
    targetDriver: "mysql",
    statements: [stmt("ALTER TABLE users MODIFY email varchar(50) NOT NULL", "alter_column"), stmt("DROP TABLE legacy", "drop_table", true, "legacy")],
    warnings: ["users.email: key changes are not auto-generated"],
    allowDestructive: true,
    allowDelete: false,
    diff: DIFF,
    dataSummary: null,
    maskLiterals: true,
    ...over,
  };
}

describe("summarizeSchemaDiff (#697)", () => {
  it("差分のあるテーブル / カラムだけを列挙し、同一テーブルとデフォルト値は含めない", () => {
    const text = summarizeSchemaDiff(DIFF).join("\n");
    expect(text).toContain("table users: different");
    expect(text).toContain("table legacy: target_only");
    expect(text).toContain("varchar(50)");
    expect(text).toContain("varchar(255)");
    expect(text).toContain("has default");
    expect(text).not.toContain("same_tbl");
    expect(text).not.toContain("secret-default-value");
  });
});

describe("buildSyncRiskPrompt (#697)", () => {
  it("方言・フラグ・文の index・警告を含み、リテラルはマスクされる", () => {
    const p = buildSyncRiskPrompt(
      input({ statements: [stmt("UPDATE t SET a = 'secret-literal'", "alter_column"), stmt("DROP TABLE legacy", "drop_table", true)] }),
    );
    expect(p).toContain("Target dialect: MySQL");
    expect(p).toContain("allow_destructive");
    expect(p).toContain("#0 [alter_column]");
    expect(p).toContain("#1 [drop_table] table=users DESTRUCTIVE");
    expect(p).toContain("DROP TABLE legacy");
    expect(p).toContain("key changes are not auto-generated");
    expect(p).not.toContain("secret-literal");
    expect(p).toContain("implicitly commits");
  });

  it("マスク無効ならリテラルも送る", () => {
    const p = buildSyncRiskPrompt(input({ maskLiterals: false, statements: [stmt("UPDATE t SET a = 'lit'", "alter_column")] }));
    expect(p).toContain("'lit'");
  });

  it("データ比較は件数のみ。セル値も行 DML の SQL 本文も送らない", () => {
    const p = buildSyncRiskPrompt(
      input({
        planKind: "data",
        diff: DIFF,
        allowDelete: true,
        maskLiterals: false,
        statements: [
          stmt("INSERT INTO `users` (`id`,`email`) VALUES (1,'alice@example.com')", "insert_row"),
          stmt("UPDATE `users` SET `email`='bob@example.com' WHERE `id`=2", "update_row"),
          stmt("DELETE FROM `users` WHERE `id`=3", "delete_row", true),
        ],
        dataSummary: { table: "users", truncated: false },
      }),
    );
    expect(p).toContain("rows to insert: 1");
    expect(p).toContain("rows to delete: 1");
    expect(p).toContain("#2 [delete_row] table=users DESTRUCTIVE");
    expect(p).not.toContain("alice@example.com");
    expect(p).not.toContain("bob@example.com");
    expect(p).not.toContain("INSERT INTO");
    expect(p).not.toContain("DELETE FROM");
    // スキーマ差分も付けない。
    expect(p).not.toContain("Schema differences");
  });

  it("データ比較の件数は生成された DML の件数 (allow_delete=false で DELETE が無ければ 0)", () => {
    const p = buildSyncRiskPrompt(
      input({
        planKind: "data",
        allowDelete: false,
        statements: [stmt("INSERT INTO `users` VALUES (1)", "insert_row"), stmt("UPDATE `users` SET a=1", "update_row")],
        dataSummary: { table: "users", truncated: false },
      }),
    );
    expect(p).toContain("rows to insert: 1");
    expect(p).toContain("rows to update: 1");
    expect(p).toContain("rows to delete: 0");
    expect(p).toContain("allow_delete=false");
    expect(countDmlStatements([stmt("x", "insert_row"), stmt("y", "delete_row", true), stmt("z", "add_column")])).toEqual({
      inserts: 1,
      updates: 0,
      deletes: 1,
    });
  });

  it("スキーマ比較のフラグは生成時の値を「許可されていたか」の形で渡す", () => {
    const p = buildSyncRiskPrompt(input({ allowDestructive: false }));
    expect(p).toContain("allow_destructive=false (whether DROP");
  });

  it("破壊的な文が上限を超えるときは非破壊の文を除外する", () => {
    const many = Array.from({ length: SYNC_RISK_MAX_STATEMENTS + 20 }, (_, i) => stmt(`DROP TABLE d${i}`, "drop_table", true));
    many.push(stmt("ALTER TABLE keep_me ADD c int", "add_column"));
    const p = buildSyncRiskPrompt(input({ statements: many }));
    expect(p).not.toContain("keep_me");
    expect(selectStatementsForPrompt(many)).toHaveLength(SYNC_RISK_MAX_STATEMENTS);
  });

  it("巨大プランでも破壊的な文を優先して上限内に収め、index は元のまま", () => {
    const many = Array.from({ length: SYNC_RISK_MAX_STATEMENTS + 50 }, (_, i) => stmt(`ALTER TABLE t${i} ADD c int`, "add_column"));
    many.push(stmt("DROP TABLE last_one", "drop_table", true));
    const p = buildSyncRiskPrompt(input({ statements: many }));
    expect(p).toContain(`#${many.length - 1} [drop_table]`);
    expect(p).toContain(`${SYNC_RISK_MAX_STATEMENTS} shown`);
  });

  it("システムプロンプトは MySQL の best-effort 逐次を指示する", () => {
    expect(buildSyncRiskSystem("ja")).toContain("best-effort");
    expect(buildSyncRiskSystem("ja")).toContain("Japanese");
    expect(buildSyncRiskSystem("en")).toContain("English");
  });

  it("format は全オブジェクトが additionalProperties: false", () => {
    const s = SYNC_RISK_FORMAT.schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.risk_items.items.additionalProperties).toBe(false);
  });
});

describe("parseSyncRiskResponse (#697)", () => {
  const ok = { summary: "S", risk_items: [{ statement_index: 1, risk: "R", severity: "high" }], recommendation: "Rec" };

  it("正しい JSON / コードフェンス付きを受け付ける", () => {
    expect(parseSyncRiskResponse(JSON.stringify(ok))).toEqual({ ok: true, value: ok });
    expect(parseSyncRiskResponse("```json\n" + JSON.stringify(ok) + "\n```").ok).toBe(true);
  });

  it("不正な severity / 非 JSON は本文をそのまま返す", () => {
    const bad = JSON.stringify({ ...ok, risk_items: [{ statement_index: 1, risk: "R", severity: "critical" }] });
    expect(parseSyncRiskResponse(bad)).toEqual({ ok: false, raw: bad });
    expect(parseSyncRiskResponse("plain")).toEqual({ ok: false, raw: "plain" });
  });
});

describe("finalizeRiskItems (#697)", () => {
  const statements = [
    stmt("ALTER TABLE a ADD c int", "add_column"),
    stmt("DROP TABLE b", "drop_table", true),
    stmt("DELETE FROM c WHERE id = 1", "delete_row", true),
  ];

  it("範囲外・負の index の項目を捨てる", () => {
    const out = finalizeRiskItems(
      [
        { statement_index: 0, risk: "ok", severity: "low" },
        { statement_index: 3, risk: "out", severity: "high" },
        { statement_index: -1, risk: "neg", severity: "high" },
      ],
      [statements[0]],
      "missing",
    );
    expect(out).toEqual([{ statement_index: 0, risk: "ok", severity: "low" }]);
  });

  it("説明の無い破壊的文には high のバッジを補い、index 順に並べる", () => {
    const out = finalizeRiskItems([{ statement_index: 2, risk: "rows lost", severity: "high" }], statements, "missing");
    expect(out).toEqual([
      { statement_index: 1, risk: "missing", severity: "high" },
      { statement_index: 2, risk: "rows lost", severity: "high" },
    ]);
  });

  it("応答が空でも全ての破壊的文が補完される", () => {
    const out = finalizeRiskItems([], statements, "missing");
    expect(out.map((i) => i.statement_index)).toEqual([1, 2]);
  });

  it("破壊的判定は destructive フラグ・種別・SQL 先頭 (DROP / DELETE / TRUNCATE) のどれでも", () => {
    expect(isDestructiveStatement(stmt("TRUNCATE TABLE x", "alter_column"))).toBe(true);
    expect(isDestructiveStatement(stmt("  drop index i", "alter_column"))).toBe(true);
    expect(isDestructiveStatement(stmt("x", "drop_column"))).toBe(true);
    expect(isDestructiveStatement(stmt("ALTER TABLE x ADD c int", "add_column"))).toBe(false);
  });
});
