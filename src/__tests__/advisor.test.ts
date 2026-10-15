import { describe, expect, it } from "vitest";

import type { AdvisorRuleId, HealthFinding } from "../api/tauri";
import {
  findingDescription,
  findingsToTable,
  findingTarget,
  DEFAULT_ADVISOR_SORT,
  nextAdvisorSort,
  newFindingSet,
  reasonTextKey,
  reclaimableSummary,
  ruleTitleKey,
  severityLabelKey,
  severityRole,
  sortFindings,
} from "../components/advisor";
import { dictionaries } from "../i18n";
import { tableToCsv, tableToMarkdown } from "../components/tabularText";

// i18n の実キーテーブルを import して、advisor.ts が返すキーが実在し翻訳文が
// 空でないことを固定する (キー名のタイポやテンプレート欠落を検出)。

function finding(partial: Partial<HealthFinding> & Pick<HealthFinding, "rule">): HealthFinding {
  return {
    severity: "medium",
    table: "t",
    columns: [],
    context: [],
    fix_ddl: null,
    fix_ddl_online: null,
    statistical: false,
    size_bytes: null,
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
    expect(findingTarget(finding({ rule: "missing_primary_key", table: "logs", columns: [] }))).toBe("logs");
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
    expect(nextAdvisorSort({ key: "rule", dir: "asc" }, "rule")).toEqual({ key: "rule", dir: "desc" });
    expect(nextAdvisorSort({ key: "rule", dir: "desc" }, "target")).toEqual({ key: "target", dir: "asc" });
    expect(nextAdvisorSort(DEFAULT_ADVISOR_SORT, "rule")).toEqual({ key: "rule", dir: "asc" });
  });

  it("解除すると既定の重要度順 (高→低) に戻る", () => {
    expect(DEFAULT_ADVISOR_SORT).toEqual({ key: "severity", dir: "asc" });
    expect(nextAdvisorSort({ key: "rule", dir: "desc" }, "rule")).toEqual(DEFAULT_ADVISOR_SORT);
    // 重要度列自身の巡回: 昇順(既定) → 降順 → 既定へ
    expect(nextAdvisorSort(DEFAULT_ADVISOR_SORT, "severity")).toEqual({ key: "severity", dir: "desc" });
    expect(nextAdvisorSort({ key: "severity", dir: "desc" }, "severity")).toEqual(DEFAULT_ADVISOR_SORT);
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
      fix_ddl_online: null,
      statistical: false,
      size_bytes: null,
    });
    expect(d.key).toBe("advisorRuleUnknownDesc");
    expect(d.params.table).toBe("t");
  });
});

describe("findingsToTable (#1539)", () => {
  const labels = {
    headers: {
      severity: "Severity",
      rule: "Rule",
      table: "Table",
      columns: "Columns",
      detail: "Detail",
      fixDdl: "Fix",
      fixDdlOnline: "Fix online",
      statistical: "Stat",
      size: "Size",
    },
    severity: (s: string) => s.toUpperCase(),
    rule: (f: HealthFinding) => `rule:${f.rule}`,
    detail: (f: HealthFinding) => `detail of ${f.table}`,
  };
  const f1 = finding({
    rule: "fk_missing_index",
    severity: "high",
    table: "orders",
    columns: ["user_id", "shop_id"],
    fix_ddl: 'CREATE INDEX "i" ON "orders" ("user_id");\nSELECT 1;',
    fix_ddl_online: "CREATE INDEX CONCURRENTLY i ON orders (user_id)",
    statistical: true,
  });
  const f2 = finding({ rule: "fk_missing_index", table: "t,2" });

  it("表示順のまま 1 指摘 1 行にし、列は ', ' 連結、DDL が無ければ null", () => {
    const { header, rows } = findingsToTable([f1, f2], labels);
    expect(header).toHaveLength(9);
    expect(rows[0]).toEqual([
      "HIGH",
      "rule:fk_missing_index",
      "orders",
      "user_id, shop_id",
      "detail of orders",
      f1.fix_ddl,
      f1.fix_ddl_online,
      "Y",
      null,
    ]);
    expect(rows[1].slice(5)).toEqual([null, null, "", null]);
    // 容量が取れた指摘はバイト数をそのまま書き出す。
    expect(findingsToTable([{ ...f2, size_bytes: 2048 }], labels).rows[0][8]).toBe("2048");
  });
  it("CSV はカンマ・改行・ダブルクオートを含む DDL を 1 セルに収める", () => {
    const { header, rows } = findingsToTable([f1, f2], labels);
    const csv = tableToCsv(header, rows);
    expect(csv).toContain('"CREATE INDEX ""i"" ON ""orders"" (""user_id"");\nSELECT 1;"');
    expect(csv).toContain('"t,2"');
  });
  it("Markdown は DDL の改行を <br>、| をエスケープする", () => {
    const { header, rows } = findingsToTable([f1], labels);
    const md = tableToMarkdown(header, rows);
    expect(md.split("\n")[2]).toContain("SELECT 1;");
    expect(md.split("\n")).toHaveLength(4);
    expect(md).toContain("<br>");
  });
});

describe("容量・前回比 (#1621)", () => {
  const unused = (index: string, size: number | null) =>
    finding({ rule: "unused_index", table: "t", columns: ["a"], context: [index], size_bytes: size });

  it("容量列は初回クリックで大きい順、次に小さい順、その次で解除", () => {
    expect(nextAdvisorSort(DEFAULT_ADVISOR_SORT, "size")).toEqual({ key: "size", dir: "desc" });
    expect(nextAdvisorSort({ key: "size", dir: "desc" }, "size")).toEqual({ key: "size", dir: "asc" });
    expect(nextAdvisorSort({ key: "size", dir: "asc" }, "size")).toEqual(DEFAULT_ADVISOR_SORT);
  });

  it("容量でソートしても、容量不明の指摘は昇順・降順とも末尾に並ぶ", () => {
    const list = [unused("small", 10), finding({ rule: "missing_primary_key" }), unused("big", 9000)];
    const label = () => "";
    const desc = sortFindings(list, "size", "desc", label).map((f) => f.size_bytes);
    expect(desc).toEqual([9000, 10, null]);
    const asc = sortFindings(list, "size", "asc", label).map((f) => f.size_bytes);
    expect(asc).toEqual([10, 9000, null]);
  });

  it("再利用可能サイズは未使用インデックスだけを足し、不明な件数を返す", () => {
    expect(reclaimableSummary([unused("a", 1024), unused("b", 2048), unused("c", null)])).toEqual({
      bytes: 3072,
      unknown: 1,
    });
    // 他ルールの容量は数えない / 容量が 1 件も取れなければ合計を出さない。
    expect(reclaimableSummary([finding({ rule: "missing_primary_key", size_bytes: 5 })])).toBeNull();
    expect(reclaimableSummary([unused("a", null)])).toBeNull();
  });

  it("前回診断との差分の添字を、指摘の参照の集合にする", () => {
    const a = unused("a", null);
    const b = unused("b", null);
    const set = newFindingSet([a, b], { new_indexes: [1, 7] });
    expect(set.has(b)).toBe(true);
    expect(set.has(a)).toBe(false);
    expect(set.size).toBe(1);
    expect(newFindingSet([a], null).size).toBe(0);
  });
});
