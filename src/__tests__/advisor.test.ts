import { describe, expect, it } from "vitest";

import type { AdvisorRuleId, HealthFinding } from "../api/tauri";
import {
  findingDescription,
  findingTarget,
  nextAdvisorSort,
  reasonTextKey,
  ruleTitleKey,
  severityLabelKey,
  severityRole,
  sortFindings,
} from "../components/advisor";
import { dictionaries } from "../i18n";

// i18n の実キーテーブルを import して、advisor.ts が返すキーが実在し翻訳文が
// 空でないことを固定する (キー名のタイポやテンプレート欠落を検出)。

function finding(partial: Partial<HealthFinding> & Pick<HealthFinding, "rule">): HealthFinding {
  return {
    severity: "medium",
    table: "t",
    columns: [],
    context: [],
    fix_ddl: null,
    statistical: false,
    ...partial,
  };
}

describe("severityRole", () => {
  it("重要度を semantic 役割へマップする", () => {
    expect(severityRole("high")).toBe("danger");
    expect(severityRole("medium")).toBe("warning");
    expect(severityRole("low")).toBe("info");
  });
});

describe("severityLabelKey", () => {
  it("各重要度にラベルキーを返す", () => {
    expect(severityLabelKey("high")).toBe("advisorSeverityHigh");
    expect(severityLabelKey("medium")).toBe("advisorSeverityMedium");
    expect(severityLabelKey("low")).toBe("advisorSeverityLow");
  });
});

describe("ruleTitleKey", () => {
  it("全ルールに見出しキーを返す", () => {
    const rules = [
      "fk_missing_index",
      "duplicate_index",
      "redundant_index",
      "missing_primary_key",
      "unused_index",
      "fk_type_mismatch",
      "sqlite_integer_pk_hint",
    ] as const;
    for (const r of rules) {
      expect(ruleTitleKey(r)).toMatch(/^advisorRule/);
    }
  });
});

describe("findingDescription", () => {
  it("FK 欠落は table/columns/ref を差し込む", () => {
    const d = findingDescription(
      finding({ rule: "fk_missing_index", table: "orders", columns: ["user_id"], context: ["users"] }),
    );
    expect(d.key).toBe("advisorRuleFkMissingIndexDesc");
    expect(d.params).toEqual({ table: "orders", columns: "user_id", ref: "users" });
  });

  it("型不一致は両端の型を差し込む", () => {
    const d = findingDescription(
      finding({
        rule: "fk_type_mismatch",
        table: "orders",
        columns: ["user_id"],
        context: ["bigint", "users.id", "int"],
      }),
    );
    expect(d.key).toBe("advisorRuleFkTypeMismatchDesc");
    expect(d.params.srcType).toBe("bigint");
    expect(d.params.ref).toBe("users.id");
    expect(d.params.refType).toBe("int");
  });

  it("重複インデックスは両インデックス名を差し込む", () => {
    const d = findingDescription(
      finding({
        rule: "duplicate_index",
        table: "t",
        columns: ["a"],
        context: ["idx_a2", "idx_a1"],
      }),
    );
    expect(d.params.index).toBe("idx_a2");
    expect(d.params.other).toBe("idx_a1");
  });

  it("context 不足でも空文字で安全に埋める", () => {
    const d = findingDescription(finding({ rule: "unused_index", context: [] }));
    expect(d.params.index).toBe("");
  });
});

describe("reasonTextKey", () => {
  it("既知の理由コードをマップし、未知はフォールバックする", () => {
    expect(reasonTextKey("unsupported_driver")).toBe("advisorReasonUnsupportedDriver");
    expect(reasonTextKey("performance_schema_off")).toBe("advisorReasonPerformanceSchemaOff");
    expect(reasonTextKey("stats_unreadable")).toBe("advisorReasonStatsUnreadable");
    expect(reasonTextKey("something_new")).toBe("advisorReasonUnknown");
  });
});

describe("findingTarget", () => {
  it("列があれば table (cols)、無ければテーブル名のみ", () => {
    expect(findingTarget(finding({ rule: "unused_index", table: "t", columns: ["a", "b"] }))).toBe(
      "t (a, b)",
    );
    expect(findingTarget(finding({ rule: "missing_primary_key", table: "logs", columns: [] }))).toBe(
      "logs",
    );
  });
});

describe("i18n キーが実在する", () => {
  it("advisor.ts が返す全キーが en/ja テーブルに存在する", () => {
    const keys = [
      severityLabelKey("high"),
      severityLabelKey("medium"),
      severityLabelKey("low"),
      ruleTitleKey("fk_missing_index"),
      ruleTitleKey("duplicate_index"),
      ruleTitleKey("redundant_index"),
      ruleTitleKey("missing_primary_key"),
      ruleTitleKey("unused_index"),
      ruleTitleKey("fk_type_mismatch"),
      ruleTitleKey("sqlite_integer_pk_hint"),
      reasonTextKey("unsupported_driver"),
      reasonTextKey("performance_schema_off"),
      reasonTextKey("stats_unreadable"),
      reasonTextKey("x"),
    ];
    for (const k of keys) {
      expect(dictionaries.en[k], `missing en i18n key: ${k}`).toBeTruthy();
      expect(dictionaries.ja[k], `missing ja i18n key: ${k}`).toBeTruthy();
    }
  });
});

describe("sortFindings", () => {
  const list = [
    finding({ rule: "unused_index", severity: "low", table: "b" }),
    finding({ rule: "missing_primary_key", severity: "high", table: "c" }),
    finding({ rule: "duplicate_index", severity: "medium", table: "a" }),
    finding({ rule: "fk_missing_index", severity: "high", table: "a2" }),
  ];
  const label = (f: HealthFinding) => f.rule;

  it("重要度の昇順は high → medium → low で、同値は元の順を保つ", () => {
    expect(sortFindings(list, "severity", "asc", label).map((f) => f.table)).toEqual(["c", "a2", "a", "b"]);
    expect(sortFindings(list, "severity", "desc", label).map((f) => f.severity)).toEqual([
      "low",
      "medium",
      "high",
      "high",
    ]);
  });

  it("対象は findingTarget の文字列、ルールは表示ラベルで比較する", () => {
    expect(sortFindings(list, "target", "asc", label).map((f) => f.table)).toEqual(["a", "a2", "b", "c"]);
    expect(sortFindings(list, "rule", "asc", label).map((f) => f.rule)).toEqual([
      "duplicate_index",
      "fk_missing_index",
      "missing_primary_key",
      "unused_index",
    ]);
  });

  it("入力配列を書き換えない", () => {
    const before = list.map((f) => f.table);
    sortFindings(list, "target", "desc", label);
    expect(list.map((f) => f.table)).toEqual(before);
  });
});

describe("nextAdvisorSort", () => {
  it("同じ列は 昇順 → 降順 → 解除、別の列は昇順から", () => {
    expect(nextAdvisorSort(null, "rule")).toEqual({ key: "rule", dir: "asc" });
    expect(nextAdvisorSort({ key: "rule", dir: "asc" }, "rule")).toEqual({ key: "rule", dir: "desc" });
    expect(nextAdvisorSort({ key: "rule", dir: "desc" }, "rule")).toBeNull();
    expect(nextAdvisorSort({ key: "rule", dir: "desc" }, "target")).toEqual({ key: "target", dir: "asc" });
  });
});

describe("未知ルールのフォールバック (#1194)", () => {
  it("union に無いルールでも見出し・説明が空にならない", () => {
    const unknown = "brand_new_rule" as unknown as AdvisorRuleId;
    expect(ruleTitleKey(unknown)).toBe("advisorRuleUnknownTitle");
    const d = findingDescription({
      rule: unknown,
      severity: "low",
      table: "t",
      columns: [],
      context: [],
      fix_ddl: null,
      statistical: false,
    });
    expect(d.key).toBe("advisorRuleUnknownDesc");
    expect(d.params.table).toBe("t");
  });
});
