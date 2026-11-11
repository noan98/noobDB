import { describe, expect, it } from "vitest";

import type { AdvisorRuleId, HealthFinding } from "../api/tauri";
import {
  effectiveRuleFilter,
  filterFindingsByRule,
  findingDescription,
  findingsToTable,
  findingTarget,
  DEFAULT_ADVISOR_SORT,
  nextAdvisorSort,
  newFindingSet,
  previousSeverityCounts,
  reasonTextKey,
  ruleCounts,
  ruleWhyKey,
  sequenceMeterTone,
  sequenceUsage,
  severityCounts,
  severityDeltas,
  toggleRuleFilter,
  reclaimableSummary,
  sequenceFixAlterRisks,
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
      "nullable_foreign_key",
      "oversized_varchar",
      "float_for_money",
      "sequence_exhaustion",
    ] as const;
    for (const r of rules) {
      expect(ruleTitleKey(r)).toMatch(/^advisorRule/);
    }
  });
});

describe("findingDescription", () => {
  it("新ルール (NULL 許容 FK / 過大 VARCHAR / 金額に浮動小数) のパラメータを差し込む", () => {
    expect(
      findingDescription(
        finding({ rule: "nullable_foreign_key", table: "orders", columns: ["user_id"], context: ["users"] }),
      ),
    ).toEqual({
      key: "advisorRuleNullableForeignKeyDesc",
      params: { table: "orders", columns: "user_id", ref: "users" },
    });
    expect(
      findingDescription(
        finding({
          rule: "oversized_varchar",
          table: "t",
          columns: ["c"],
          context: ["varchar(4000)", "4000"],
        }),
      ),
    ).toEqual({
      key: "advisorRuleOversizedVarcharDesc",
      params: { table: "t", column: "c", type: "varchar(4000)", length: "4000" },
    });
    expect(
      findingDescription(
        finding({ rule: "float_for_money", table: "t", columns: ["price"], context: ["float"] }),
      ),
    ).toEqual({
      key: "advisorRuleFloatForMoneyDesc",
      params: { table: "t", column: "price", type: "float" },
    });
    expect(
      findingDescription(
        finding({ rule: "float_for_money", table: "t", columns: ["price"], context: ["REAL", "sqlite"] }),
      ),
    ).toEqual({
      key: "advisorRuleFloatForMoneySqliteDesc",
      params: { table: "t", column: "price", type: "REAL" },
    });
  });

  it("採番枯渇は使用率などを差し込み、MAXVALUE 起因なら専用の文言へ切り替える (#2210)", () => {
    const base = {
      rule: "sequence_exhaustion" as const,
      table: "orders",
      columns: ["id"],
    };
    expect(
      findingDescription(
        finding({
          ...base,
          context: ["int unsigned", "3500000000", "4294967295", "81.4", "type"],
          fix_ddl: "ALTER TABLE orders MODIFY COLUMN id BIGINT;",
        }),
      ),
    ).toEqual({
      key: "advisorRuleSequenceExhaustionDesc",
      params: {
        table: "orders",
        column: "id",
        type: "int unsigned",
        used: "3500000000",
        max: "4294967295",
        percent: "81.4",
      },
    });
    expect(
      findingDescription(finding({ ...base, context: ["bigint", "900", "1000", "90.0", "sequence"] })).key,
    ).toBe("advisorRuleSequenceCapDesc");
    // 修正 DDL が無い (最大幅など) ときは「BIGINT に広げる」を言わない文言。
    expect(
      findingDescription(
        finding({ ...base, context: ["bigint", "900", "1000", "90.0", "type"], fix_ddl: null }),
      ).key,
    ).toBe("advisorRuleSequenceNoFixDesc");
  });

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
      ruleTitleKey("nullable_foreign_key"),
      ruleTitleKey("oversized_varchar"),
      ruleTitleKey("float_for_money"),
      ruleTitleKey("sequence_exhaustion"),
      reasonTextKey("sequences_unreadable"),
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

describe("sequenceFixAlterRisks (#2210)", () => {
  const seq = (fix: string | null) =>
    finding({ rule: "sequence_exhaustion", table: "t", columns: ["id"], fix_ddl: fix });
  it("型変更を伴う修正は alterCost のリスク (MySQL は COPY、PostgreSQL は書き換え) になる", () => {
    const my = sequenceFixAlterRisks(
      seq("ALTER TABLE `t` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;"),
      "mysql",
    );
    expect(my.map((r) => r.reason)).toEqual(["mysqlCopyType"]);
    const pg = sequenceFixAlterRisks(seq('ALTER TABLE "t" ALTER COLUMN "id" TYPE bigint;'), "postgres");
    expect(pg.map((r) => r.reason)).toEqual(["pgRewriteType"]);
    expect(pg[0]?.subject).toBe("id");
  });
  it("MAXVALUE だけの修正・修正なし・他ルールは空", () => {
    expect(
      sequenceFixAlterRisks(seq('ALTER SEQUENCE "t_id_seq" AS bigint NO MAXVALUE;'), "postgres"),
    ).toEqual([]);
    expect(sequenceFixAlterRisks(seq(null), "mysql")).toEqual([]);
    expect(
      sequenceFixAlterRisks(
        finding({ rule: "missing_primary_key", fix_ddl: "ALTER TABLE x MODIFY COLUMN y INT" }),
        "mysql",
      ),
    ).toEqual([]);
  });
});

describe("要約タイル・ルール別の分布 (#2239)", () => {
  const fs = [
    finding({ rule: "missing_primary_key", severity: "medium", table: "a" }),
    finding({ rule: "fk_missing_index", severity: "high", table: "b" }),
    finding({ rule: "missing_primary_key", severity: "medium", table: "c" }),
    finding({ rule: "unused_index", severity: "low", table: "d" }),
    finding({ rule: "missing_primary_key", severity: "high", table: "e" }),
  ];

  it("severityCounts は重要度別に数える", () => {
    expect(severityCounts(fs)).toEqual({ high: 2, medium: 2, low: 1 });
    expect(severityCounts([])).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("previousSeverityCounts は新規を除き解消を足して前回の件数を求め、初回は null", () => {
    expect(previousSeverityCounts(fs, new Set(), null)).toBeNull();
    const diff = {
      previous_at: "2026-01-01T00:00:00Z",
      new_indexes: [1, 3],
      resolved: [
        finding({ rule: "duplicate_index", severity: "medium" }),
        finding({ rule: "unused_index", severity: "low" }),
      ],
      unchanged: 3,
    };
    // 今回 {2,2,1} - 新規 (high 1, low 1) + 解消 (medium 1, low 1) = {1,3,1}
    expect(previousSeverityCounts(fs, new Set([fs[1], fs[3]]), diff)).toEqual({ high: 1, medium: 3, low: 1 });
  });

  it("「対応しない」で続く指摘が本表から消えても、今回・前回が同じだけ動き delta は変わらない", () => {
    const diff = { previous_at: "x", new_indexes: [], resolved: [], unchanged: 5 };
    const before = severityDeltas(severityCounts(fs), previousSeverityCounts(fs, new Set(), diff));
    const rest = fs.filter((f) => f.table !== "b");
    const after = severityDeltas(severityCounts(rest), previousSeverityCounts(rest, new Set(), diff));
    expect(after).toEqual(before);
  });

  it("限界: 続く指摘の重要度が上がっても delta には出ない", () => {
    const cur = [finding({ rule: "sequence_exhaustion", severity: "high", table: "x" })];
    const diff = { previous_at: "x", new_indexes: [], resolved: [], unchanged: 1 };
    const d = severityDeltas(severityCounts(cur), previousSeverityCounts(cur, new Set(), diff));
    expect(d).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("severityDeltas は前回が無ければ null、あれば今回 − 前回", () => {
    const cur = { high: 2, medium: 2, low: 1 };
    expect(severityDeltas(cur, null)).toEqual({ high: null, medium: null, low: null });
    expect(severityDeltas(cur, { high: 3, medium: 2, low: 0 })).toEqual({ high: -1, medium: 0, low: 1 });
  });

  it("ruleCounts は 0 件を出さず、重い順 → 件数順 → 初出順に並べ、最も重い重要度を持つ", () => {
    expect(ruleCounts([])).toEqual([]);
    expect(ruleCounts(fs)).toEqual([
      { rule: "missing_primary_key", count: 3, severity: "high" },
      { rule: "fk_missing_index", count: 1, severity: "high" },
      { rule: "unused_index", count: 1, severity: "low" },
    ]);
    // 同重要度・同件数は入力順を保つ
    const tie = [
      finding({ rule: "duplicate_index", severity: "low" }),
      finding({ rule: "unused_index", severity: "low" }),
    ];
    expect(ruleCounts(tie).map((c) => c.rule)).toEqual(["duplicate_index", "unused_index"]);
  });

  it("filterFindingsByRule / toggleRuleFilter / effectiveRuleFilter", () => {
    expect(filterFindingsByRule(fs, null)).toBe(fs);
    expect(filterFindingsByRule(fs, "missing_primary_key").map((f) => f.table)).toEqual(["a", "c", "e"]);
    expect(filterFindingsByRule(fs, "float_for_money")).toEqual([]);
    expect(toggleRuleFilter(null, "unused_index")).toBe("unused_index");
    expect(toggleRuleFilter("unused_index", "unused_index")).toBeNull();
    expect(toggleRuleFilter("unused_index", "fk_missing_index")).toBe("fk_missing_index");
    const counts = ruleCounts(fs);
    expect(effectiveRuleFilter("unused_index", counts)).toBe("unused_index");
    expect(effectiveRuleFilter("float_for_money", counts)).toBeNull();
    expect(effectiveRuleFilter(null, counts)).toBeNull();
  });

  it("ruleWhyKey は全ルールで実在する日英の文言を返し、未知ルールは汎用へ倒す", () => {
    const rules: AdvisorRuleId[] = [
      "fk_missing_index",
      "duplicate_index",
      "redundant_index",
      "missing_primary_key",
      "unused_index",
      "fk_type_mismatch",
      "sqlite_integer_pk_hint",
      "nullable_foreign_key",
      "oversized_varchar",
      "float_for_money",
      "sequence_exhaustion",
    ];
    const keys = new Set(rules.map((r) => ruleWhyKey(r)));
    expect(keys.size).toBe(rules.length);
    for (const r of rules) {
      const key = ruleWhyKey(r);
      expect(dictionaries.en[key]).toBeTruthy();
      expect(dictionaries.ja[key]).toBeTruthy();
    }
    expect(ruleWhyKey("something_new" as AdvisorRuleId)).toBe("advisorRuleUnknownWhy");
  });

  it("sequenceMeterTone は重要度から決める (バッジと食い違わない)", () => {
    expect(sequenceMeterTone("high")).toBe("danger");
    expect(sequenceMeterTone("medium")).toBe("warning");
    expect(sequenceMeterTone("low")).toBe("accent");
  });

  it("sequenceUsage は採番枯渇の context から使用量を読み、それ以外は null", () => {
    const seq = finding({
      rule: "sequence_exhaustion",
      context: ["int unsigned", "3500000000", "4294967295", "81.4", "type"],
    });
    expect(sequenceUsage(seq)).toEqual({ percent: 81.4, used: "3500000000", max: "4294967295" });
    expect(sequenceUsage(finding({ rule: "unused_index", context: ["x", "1", "2", "50"] }))).toBeNull();
    expect(sequenceUsage(finding({ rule: "sequence_exhaustion", context: [] }))).toBeNull();
    expect(
      sequenceUsage(finding({ rule: "sequence_exhaustion", context: ["t", "1", "2", "abc"] })),
    ).toBeNull();
    expect(sequenceUsage(finding({ rule: "sequence_exhaustion", context: ["t", "1", "2", ""] }))).toBeNull();
  });
});
