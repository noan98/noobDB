import { describe, expect, it } from "vitest";
import {
  buildCreatePolicySql,
  buildPolicyStatements,
  formatPolicyPreview,
  parseRoles,
  usingAllowed,
  validatePolicyName,
  withCheckAllowed,
  type PolicyDraft,
} from "../components/policySql";

// PostgreSQL の RLS ポリシー `CREATE POLICY` の組み立て (#2159)。

const base: PolicyDraft = {
  schema: "public",
  table: "docs",
  name: "own_rows",
  kind: "PERMISSIVE",
  command: "ALL",
  roles: "",
  using: "owner = current_user",
  withCheck: "",
  enableRls: false,
  forceRls: false,
};

describe("buildCreatePolicySql", () => {
  it("ロール未指定は PUBLIC、USING だけを括弧で包む", () => {
    expect(buildCreatePolicySql(base)).toBe(
      'CREATE POLICY "own_rows" ON "public"."docs"\n  AS PERMISSIVE\n  FOR ALL\n  TO PUBLIC\n  USING (owner = current_user)',
    );
  });

  it("ロールは引用し、PUBLIC / CURRENT_USER などの特殊名は引用しない", () => {
    const sql = buildCreatePolicySql({ ...base, roles: 'app_user, "Odd"x, current_user ,public,' });
    expect(sql).toContain('TO "app_user", """Odd""x", CURRENT_USER, PUBLIC');
    expect(parseRoles(" a, ,b,")).toEqual(["a", "b"]);
  });

  it("識別子の引用符は二重にする", () => {
    const sql = buildCreatePolicySql({ ...base, name: 'we"ird', table: "my table", schema: 's"1' });
    expect(sql).toContain('CREATE POLICY "we""ird" ON "s""1"."my table"');
  });

  it("INSERT は WITH CHECK だけ、SELECT / DELETE は USING だけを出す", () => {
    const both = { ...base, using: "a = 1", withCheck: "b = 2" };
    const ins = buildCreatePolicySql({ ...both, command: "INSERT" });
    expect(ins).toContain("WITH CHECK (b = 2)");
    expect(ins).not.toContain("USING");
    for (const command of ["SELECT", "DELETE"] as const) {
      const sql = buildCreatePolicySql({ ...both, command });
      expect(sql).toContain("USING (a = 1)");
      expect(sql).not.toContain("WITH CHECK");
    }
    const upd = buildCreatePolicySql({ ...both, command: "UPDATE", kind: "RESTRICTIVE" });
    expect(upd).toContain("AS RESTRICTIVE");
    expect(upd).toContain("USING (a = 1)\n  WITH CHECK (b = 2)");
    expect(usingAllowed("INSERT")).toBe(false);
    expect(withCheckAllowed("SELECT")).toBe(false);
    expect(withCheckAllowed("ALL")).toBe(true);
  });

  it("式の前後の空白と末尾の ; を除き、空の式は句ごと出さない", () => {
    expect(buildCreatePolicySql({ ...base, using: "  true ;  " })).toContain("USING (true)");
    expect(buildCreatePolicySql({ ...base, using: "   " })).not.toContain("USING");
  });
});

describe("buildPolicyStatements", () => {
  it("RLS を有効にするなら ENABLE → CREATE POLICY → FORCE の順に並べる", () => {
    const stmts = buildPolicyStatements({ ...base, enableRls: true, forceRls: true });
    expect(stmts).toEqual([
      'ALTER TABLE "public"."docs" ENABLE ROW LEVEL SECURITY',
      expect.stringMatching(/^CREATE POLICY "own_rows"/),
      'ALTER TABLE "public"."docs" FORCE ROW LEVEL SECURITY',
    ]);
  });

  it("有効化しなければポリシーだけ。有効済みの表への FORCE だけも出せる", () => {
    expect(buildPolicyStatements(base)).toHaveLength(1);
    const stmts = buildPolicyStatements({ ...base, forceRls: true });
    expect(stmts).toHaveLength(2);
    expect(stmts[1]).toBe('ALTER TABLE "public"."docs" FORCE ROW LEVEL SECURITY');
  });

  it("プレビューは各文の末尾に ; を付けて改行で連ねる", () => {
    expect(formatPolicyPreview(["A", "B"])).toBe("A;\nB;");
  });
});

describe("validatePolicyName", () => {
  it("空・63 バイト超・同じ表の既存名を弾く", () => {
    expect(validatePolicyName("  ", [])).toBe("empty");
    expect(validatePolicyName("a".repeat(64), [])).toBe("tooLong");
    expect(validatePolicyName("あ".repeat(22), [])).toBe("tooLong");
    expect(validatePolicyName("a".repeat(63), [])).toBeNull();
    expect(validatePolicyName("p", ["p", "q"])).toBe("duplicate");
    expect(validatePolicyName("r", ["p", "q"])).toBeNull();
  });
});
