// スキーマ健全性アドバイザ (#741) の表示ロジック (純粋)。
//
// バックエンド (`db::advisor`) は散文を出さず、安定した `rule` と構造化フィールド
// (`table` / `columns` / `context`) を返す。ここではそれを i18n テンプレートの
// キー + パラメータへ変換する (`QueryStatsSupport` の理由コードと同じ発想)。UI 依存を
// 持たない純関数として切り出し、`advisor.test.ts` が対応を固定する。

import type { AdvisorRuleId, AdvisorSeverity, HealthFinding } from "../api/tauri";
import type { I18nKey } from "../i18n";
import type { SemanticRole } from "../semanticColors";

/** 重要度 → semantic 役割 (#664)。high=danger / medium=warning / low=info。 */
export function severityRole(severity: AdvisorSeverity): SemanticRole {
  switch (severity) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
  }
}

/** 重要度ラベルの i18n キー。 */
export function severityLabelKey(severity: AdvisorSeverity): I18nKey {
  switch (severity) {
    case "high":
      return "advisorSeverityHigh";
    case "medium":
      return "advisorSeverityMedium";
    case "low":
      return "advisorSeverityLow";
  }
}

/** ルール → 見出しの i18n キー。 */
export function ruleTitleKey(rule: AdvisorRuleId): I18nKey {
  switch (rule) {
    case "fk_missing_index":
      return "advisorRuleFkMissingIndexTitle";
    case "duplicate_index":
      return "advisorRuleDuplicateIndexTitle";
    case "redundant_index":
      return "advisorRuleRedundantIndexTitle";
    case "missing_primary_key":
      return "advisorRuleMissingPrimaryKeyTitle";
    case "unused_index":
      return "advisorRuleUnusedIndexTitle";
    case "fk_type_mismatch":
      return "advisorRuleFkTypeMismatchTitle";
    case "sqlite_integer_pk_hint":
      return "advisorRuleSqliteIntegerPkHintTitle";
  }
}

/** 説明テンプレートの i18n キーと、そこへ差し込むパラメータを組み立てる。
 *  `context` の要素の意味はルールごとに異なる (バック `RuleId` のドキュメント参照)。 */
export function findingDescription(finding: HealthFinding): {
  key: I18nKey;
  params: Record<string, string>;
} {
  const cols = finding.columns.join(", ");
  const ctx = finding.context;
  switch (finding.rule) {
    case "fk_missing_index":
      return {
        key: "advisorRuleFkMissingIndexDesc",
        params: { table: finding.table, columns: cols, ref: ctx[0] ?? "" },
      };
    case "duplicate_index":
      return {
        key: "advisorRuleDuplicateIndexDesc",
        params: {
          table: finding.table,
          index: ctx[0] ?? "",
          other: ctx[1] ?? "",
          columns: cols,
        },
      };
    case "redundant_index":
      return {
        key: "advisorRuleRedundantIndexDesc",
        params: {
          table: finding.table,
          index: ctx[0] ?? "",
          covering: ctx[1] ?? "",
          columns: cols,
        },
      };
    case "missing_primary_key":
      return {
        key: "advisorRuleMissingPrimaryKeyDesc",
        params: { table: finding.table },
      };
    case "unused_index":
      return {
        key: "advisorRuleUnusedIndexDesc",
        params: { table: finding.table, index: ctx[0] ?? "", columns: cols },
      };
    case "fk_type_mismatch":
      return {
        key: "advisorRuleFkTypeMismatchDesc",
        params: {
          table: finding.table,
          column: finding.columns[0] ?? "",
          srcType: ctx[0] ?? "",
          ref: ctx[1] ?? "",
          refType: ctx[2] ?? "",
        },
      };
    case "sqlite_integer_pk_hint":
      return {
        key: "advisorRuleSqliteIntegerPkHintDesc",
        params: {
          table: finding.table,
          column: finding.columns[0] ?? "",
          type: ctx[0] ?? "",
        },
      };
  }
}

/** 未使用インデックスルールのスキップ理由コード → i18n キー。未知コードは
 *  汎用フォールバックへ倒す (黙って落とさない)。 */
export function reasonTextKey(reason: string): I18nKey {
  switch (reason) {
    case "unsupported_driver":
      return "advisorReasonUnsupportedDriver";
    case "performance_schema_off":
      return "advisorReasonPerformanceSchemaOff";
    case "stats_unreadable":
      return "advisorReasonStatsUnreadable";
    default:
      return "advisorReasonUnknown";
  }
}

/** 指摘の対象を「table (col1, col2)」形式で表す。列が無いルール (PK 欠落) は
 *  テーブル名のみ。 */
export function findingTarget(finding: HealthFinding): string {
  if (finding.columns.length === 0) return finding.table;
  return `${finding.table} (${finding.columns.join(", ")})`;
}
