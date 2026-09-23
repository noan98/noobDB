import { describe, expect, it } from "vitest";
import type { Assertion, AssertionOutcome } from "../api/tauri";
import {
  describeRule,
  draftFromAssertion,
  draftToRequest,
  draftToRule,
  emptyAssertionDraft,
  observedText,
  parseColumnList,
  parseValueList,
  runAssertionsSequentially,
  summarizeRuns,
  type AssertionDraft,
  type AssertionRunState,
} from "../components/assertions";
import { dictionaries } from "../i18n";

// データ品質アサーション (#742) のフロント側純ロジック。ルール → SQL の変換は
// バックエンド (`db::assertions`) の単一ソースで、Rust 側の単体テストが方言別に
// 固定している。ここではフォーム ⇔ ルールの組み立てと、一括検証の順序・中止規則を固定する。

const profile = { id: "p1", group: "prod" };

function draft(patch: Partial<AssertionDraft>): AssertionDraft {
  return { ...emptyAssertionDraft({ table: "users" }), name: "n", ...patch };
}

function outcome(id: string, passed: boolean, observed = passed ? 0 : 3): AssertionOutcome {
  return {
    id,
    passed,
    observed,
    check_sql: "SELECT 1",
    violations_sql: `SELECT * FROM t -- ${id}`,
    elapsed_ms: 1,
  };
}

describe("parseColumnList / parseValueList", () => {
  it("列はカンマと改行で区切り、空要素を捨てる", () => {
    expect(parseColumnList(" a, b\n c ,, ")).toEqual(["a", "b", "c"]);
  });

  it("値は改行だけで区切る (値にカンマを含められる)", () => {
    expect(parseValueList("a,b\n  c  \n\n")).toEqual(["a,b", "c"]);
  });
});

describe("draftToRule", () => {
  it("6 種のルールをそれぞれ組み立てる", () => {
    expect(draftToRule(draft({ kind: "not_null", column: " email " }))).toEqual({
      ok: true,
      rule: { kind: "not_null", column: "email" },
    });
    expect(draftToRule(draft({ kind: "unique", columns: "tenant_id, email" }))).toEqual({
      ok: true,
      rule: { kind: "unique", columns: ["tenant_id", "email"] },
    });
    expect(draftToRule(draft({ kind: "accepted_values", column: "s", values: "a\nb" }))).toEqual({
      ok: true,
      rule: { kind: "accepted_values", column: "s", values: ["a", "b"] },
    });
    expect(draftToRule(draft({ kind: "range", column: "age", min: "0", max: " " }))).toEqual({
      ok: true,
      rule: { kind: "range", column: "age", min: "0", max: null },
    });
    expect(
      draftToRule(
        draft({ kind: "referential", columns: "order_id", refTable: "orders", refColumns: "id" }),
      ),
    ).toEqual({
      ok: true,
      rule: {
        kind: "referential",
        columns: ["order_id"],
        ref_schema: null,
        ref_table: "orders",
        ref_columns: ["id"],
      },
    });
    expect(draftToRule(draft({ kind: "row_count", op: "between", count: "1", countMax: "10" }))).toEqual({
      ok: true,
      rule: { kind: "row_count", op: "between", value: 1, max: 10 },
    });
    expect(draftToRule(draft({ kind: "row_count", op: "gt", count: "0", countMax: "99" }))).toEqual({
      ok: true,
      rule: { kind: "row_count", op: "gt", value: 0, max: null },
    });
  });

  it("足りない入力をフィールド単位のエラーで返す", () => {
    const cases: [Partial<AssertionDraft>, string][] = [
      [{ table: " " }, "table"],
      [{ kind: "not_null", column: "" }, "column"],
      [{ kind: "unique", columns: " , " }, "columns"],
      [{ kind: "accepted_values", column: "s", values: "\n" }, "values"],
      [{ kind: "range", column: "a", min: "", max: "" }, "bounds"],
      [{ kind: "referential", columns: "a", refTable: "" }, "refTable"],
      [{ kind: "referential", columns: "a, b", refTable: "r", refColumns: "x" }, "refColumns"],
      [{ kind: "row_count", op: "gt", count: "-1" }, "count"],
      [{ kind: "row_count", op: "gt", count: "1.5" }, "count"],
      [{ kind: "row_count", op: "between", count: "5", countMax: "4" }, "countMax"],
      [{ kind: "row_count", op: "between", count: "5", countMax: "" }, "countMax"],
    ];
    for (const [patch, error] of cases) {
      expect(draftToRule(draft(patch)), JSON.stringify(patch)).toEqual({ ok: false, error });
    }
  });
});

describe("draftToRequest", () => {
  it("スコープを接続中のプロファイルから決める", () => {
    const base = draft({ kind: "not_null", column: "email", schema: " public " });
    const r1 = draftToRequest({ ...base, scopeKind: "profile" }, profile);
    expect(r1).toMatchObject({ ok: true, req: { scope: { kind: "profile", profile_id: "p1" }, schema: "public" } });
    const r2 = draftToRequest({ ...base, scopeKind: "group" }, profile);
    expect(r2).toMatchObject({ ok: true, req: { scope: { kind: "group", group: "prod" } } });
    const r3 = draftToRequest({ ...base, scopeKind: "any" }, profile);
    expect(r3).toMatchObject({ ok: true, req: { scope: { kind: "any" } } });
    // 未接続なら全接続扱い。
    expect(draftToRequest({ ...base, scopeKind: "profile" }, null)).toMatchObject({
      ok: true,
      req: { scope: { kind: "any" } },
    });
  });

  it("グループの無い接続でグループスコープは選べない", () => {
    expect(
      draftToRequest(draft({ kind: "not_null", column: "a", scopeKind: "group" }), { id: "p1", group: null }),
    ).toEqual({ ok: false, error: "scopeGroup" });
  });

  it("名前が空なら保存できない。新規では id を送らない", () => {
    expect(draftToRequest(draft({ name: " ", column: "a" }), profile)).toEqual({ ok: false, error: "name" });
    const r = draftToRequest(draft({ column: "a" }), profile);
    expect(r.ok && "id" in r.req).toBe(false);
  });

  it("保存済みアサーションを編集状態へ戻して再保存すると同じ内容になる (往復)", () => {
    const saved: Assertion[] = [
      { id: "a1", name: "nn", scope: { kind: "profile", profile_id: "p1" }, schema: null, table: "users", rule: { kind: "not_null", column: "email" } },
      { id: "a2", name: "uq", scope: { kind: "group", group: "prod" }, schema: "s", table: "t", rule: { kind: "unique", columns: ["a", "b"] } },
      { id: "a3", name: "av", scope: { kind: "any" }, schema: null, table: "t", rule: { kind: "accepted_values", column: "s", values: ["x", "y,z"] } },
      { id: "a4", name: "rg", scope: { kind: "any" }, schema: null, table: "t", rule: { kind: "range", column: "d", min: null, max: "2024-12-31" } },
      { id: "a5", name: "rf", scope: { kind: "any" }, schema: null, table: "t", rule: { kind: "referential", columns: ["o"], ref_schema: "x", ref_table: "orders", ref_columns: ["id"] } },
      { id: "a6", name: "rc", scope: { kind: "any" }, schema: null, table: "t", rule: { kind: "row_count", op: "between", value: 1, max: 5 } },
    ];
    for (const a of saved) {
      const r = draftToRequest(draftFromAssertion(a), profile);
      expect(r, a.id).toEqual({ ok: true, req: a });
    }
  });
});

describe("表示整形", () => {
  it("ルールの要約キーは en / ja の両方に存在する", () => {
    const rules: Assertion["rule"][] = [
      { kind: "not_null", column: "c" },
      { kind: "unique", columns: ["c"] },
      { kind: "accepted_values", column: "c", values: ["a"] },
      { kind: "range", column: "c", min: "1", max: null },
      { kind: "referential", columns: ["c"], ref_schema: null, ref_table: "r", ref_columns: ["id"] },
      { kind: "row_count", op: "gt", value: 0, max: null },
      { kind: "row_count", op: "between", value: 0, max: 3 },
    ];
    for (const rule of rules) {
      const d = describeRule({ schema: "s", table: "t", rule });
      expect(dictionaries.en[d.key]).toBeTruthy();
      expect(dictionaries.ja[d.key]).toBeTruthy();
      expect(d.params?.table).toBe("s.t");
    }
  });

  it("件数は row_count なら行数、それ以外は違反件数として見せる", () => {
    expect(observedText({ kind: "row_count", op: "gt", value: 0, max: null }, outcome("x", true, 7)).key).toBe(
      "assertObservedRows",
    );
    expect(observedText({ kind: "not_null", column: "c" }, outcome("x", false, 2))).toEqual({
      key: "assertObservedViolations",
      params: { count: "2" },
    });
  });
});

describe("runAssertionsSequentially", () => {
  it("1 件ずつ順に実行し、1 件のエラーで残りを止めない", async () => {
    const calls: string[] = [];
    const states = new Map<string, AssertionRunState>();
    const history: string[] = [];
    await runAssertionsSequentially(
      ["a", "b", "c"],
      async (id) => {
        calls.push(id);
        if (id === "b") throw new Error("timeout");
        return outcome(id, id === "a");
      },
      (id, st) => {
        states.set(id, st);
        history.push(`${id}:${st.status}`);
      },
      () => false,
    );
    expect(calls).toEqual(["a", "b", "c"]);
    expect(history).toEqual([
      "a:running",
      "a:passed",
      "b:running",
      "b:error",
      "c:running",
      "c:failed",
    ]);
    expect(summarizeRuns(["a", "b", "c"], states)).toEqual({ passed: 1, failed: 1, errored: 1, total: 3 });
  });

  it("中止は次の 1 件の前で効き、残りを cancelled にする", async () => {
    let cancelled = false;
    const states = new Map<string, AssertionRunState>();
    await runAssertionsSequentially(
      ["a", "b", "c"],
      async (id) => {
        cancelled = true; // 1 件目の実行中に中止が押された
        return outcome(id, true);
      },
      (id, st) => states.set(id, st),
      () => cancelled,
    );
    expect(states.get("a")?.status).toBe("passed");
    expect(states.get("b")?.status).toBe("cancelled");
    expect(states.get("c")?.status).toBe("cancelled");
  });

  it("集計は表示中の ID だけを数える", () => {
    const states = new Map<string, AssertionRunState>([
      ["a", { status: "passed", outcome: outcome("a", true) }],
      ["other", { status: "failed", outcome: outcome("other", false) }],
    ]);
    expect(summarizeRuns(["a", "b"], states)).toEqual({ passed: 1, failed: 0, errored: 0, total: 2 });
  });
});
