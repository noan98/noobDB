// 機能ガイドの「習熟マップ」(#2216) の純ロジック。
//
// どの機能を「試した」か (フラグ) の判定・グループ別の進捗・「次のおすすめ」の選択を、
// 副作用なしの純関数として持つ。フラグ自体は設定ストア (`settings.ts` の
// `masteryTried`) に置き、外部へは送らない。文言は i18n 側 (`HelpView.tsx`) が持つ。

/** 習熟マップの対象 30 項目。機能ガイドの項目タイトルの i18n キーをそのまま ID にする。 */
export const MASTERY_GROUPS = [
  {
    id: "helpGroupQuery",
    features: [
      "helpRunTitle",
      "helpDryRunTitle",
      "helpExplainTitle",
      "helpFormatTitle",
      "helpSqlLintTitle",
      "helpQueryBuilderTitle",
      "helpSnippetTitle",
      "helpHistoryTitle",
    ],
  },
  {
    id: "helpGroupResults",
    features: [
      "helpPaginationTitle",
      "helpCellEditTitle",
      "helpDiscardTitle",
      "helpApplyTitle",
      "helpExportTitle",
      "helpImportTitle",
    ],
  },
  {
    id: "helpGroupCompare",
    features: ["helpSchemaCompareTitle", "helpSandboxTitle", "helpFlightRecorderTitle"],
  },
  { id: "helpGroupAutomation", features: ["helpTaskSchedulerTitle", "helpProfileBackupTitle"] },
  {
    id: "helpSectionGuards",
    features: [
      "helpReadOnlyTitle",
      "helpProductionTitle",
      "helpConfirmWritesTitle",
      "helpTypeToConfirmTitle",
      "helpEmergencyModeTitle",
    ],
  },
  {
    id: "helpSectionConnection",
    features: ["helpAwsIamTitle", "helpSsmTitle", "helpSsmTroubleTitle"],
  },
  { id: "helpSectionAi", features: ["helpAiPolicyTitle", "helpAiImpactTitle", "helpAiPricingTitle"] },
] as const;

export type MasteryGroupId = (typeof MASTERY_GROUPS)[number]["id"];
export type MasteryFeatureId = (typeof MASTERY_GROUPS)[number]["features"][number];

/** 全項目の ID (目次順)。 */
export const MASTERY_FEATURE_IDS: readonly MasteryFeatureId[] = MASTERY_GROUPS.flatMap(
  (g) => g.features as readonly MasteryFeatureId[],
);

const KNOWN = new Set<string>(MASTERY_FEATURE_IDS);

/** 関連の強い項目。「次のおすすめ」で、いま見ている項目に続けて試すとよいものを優先する。 */
const RELATED: Partial<Record<MasteryFeatureId, readonly MasteryFeatureId[]>> = {
  helpRunTitle: ["helpDryRunTitle", "helpExplainTitle"],
  helpDryRunTitle: ["helpSandboxTitle", "helpApplyTitle"],
  helpExplainTitle: ["helpSqlLintTitle", "helpQueryBuilderTitle"],
  helpFormatTitle: ["helpSnippetTitle", "helpSqlLintTitle"],
  helpSqlLintTitle: ["helpFormatTitle", "helpExplainTitle"],
  helpQueryBuilderTitle: ["helpRunTitle", "helpSnippetTitle"],
  helpSnippetTitle: ["helpHistoryTitle", "helpFormatTitle"],
  helpHistoryTitle: ["helpSnippetTitle", "helpFlightRecorderTitle"],
  helpPaginationTitle: ["helpExportTitle", "helpCellEditTitle"],
  helpCellEditTitle: ["helpDiscardTitle", "helpApplyTitle"],
  helpDiscardTitle: ["helpApplyTitle", "helpFlightRecorderTitle"],
  helpApplyTitle: ["helpDryRunTitle", "helpFlightRecorderTitle", "helpConfirmWritesTitle"],
  helpExportTitle: ["helpImportTitle", "helpPaginationTitle"],
  helpImportTitle: ["helpSandboxTitle", "helpExportTitle"],
  helpSchemaCompareTitle: ["helpSandboxTitle", "helpTaskSchedulerTitle"],
  helpSandboxTitle: ["helpDryRunTitle", "helpSchemaCompareTitle"],
  helpFlightRecorderTitle: ["helpDiscardTitle", "helpHistoryTitle"],
  helpTaskSchedulerTitle: ["helpProfileBackupTitle", "helpSchemaCompareTitle"],
  helpProfileBackupTitle: ["helpTaskSchedulerTitle", "helpReadOnlyTitle"],
  helpReadOnlyTitle: ["helpProductionTitle", "helpConfirmWritesTitle"],
  helpProductionTitle: ["helpConfirmWritesTitle", "helpTypeToConfirmTitle"],
  helpConfirmWritesTitle: ["helpTypeToConfirmTitle", "helpProductionTitle"],
  helpTypeToConfirmTitle: ["helpEmergencyModeTitle", "helpProductionTitle"],
  helpEmergencyModeTitle: ["helpReadOnlyTitle", "helpTypeToConfirmTitle"],
  helpAwsIamTitle: ["helpSsmTitle", "helpReadOnlyTitle"],
  helpSsmTitle: ["helpSsmTroubleTitle", "helpAwsIamTitle"],
  helpSsmTroubleTitle: ["helpSsmTitle", "helpAwsIamTitle"],
  helpAiPolicyTitle: ["helpAiImpactTitle", "helpAiPricingTitle"],
  helpAiImpactTitle: ["helpAiPolicyTitle", "helpAiPricingTitle"],
  helpAiPricingTitle: ["helpAiPolicyTitle", "helpAiImpactTitle"],
};

/** 「次のおすすめ」の既定件数。 */
export const MASTERY_RECOMMEND_LIMIT = 2;

export function isMasteryFeatureId(id: unknown): id is MasteryFeatureId {
  return typeof id === "string" && KNOWN.has(id);
}

/** 保存値を安全な「試した ID の列」へ直す。未知の ID・重複・非文字列は捨てる。 */
export function sanitizeTried(raw: unknown): MasteryFeatureId[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<MasteryFeatureId>();
  for (const v of raw) if (isMasteryFeatureId(v)) seen.add(v);
  return MASTERY_FEATURE_IDS.filter((id) => seen.has(id));
}

/** 試した項目を 1 つ加えた新しい列。未知の ID・既に試した項目は同じ参照を返す。 */
export function withTried(tried: readonly string[], id: string): readonly string[] {
  if (!isMasteryFeatureId(id) || tried.includes(id)) return tried;
  return [...tried, id];
}

export interface GroupProgress {
  group: MasteryGroupId;
  done: number;
  total: number;
}

/** グループ別の「試した数 / 総数」(目次の進捗リング用)。 */
export function groupProgress(tried: readonly string[]): GroupProgress[] {
  const set = new Set(tried);
  return MASTERY_GROUPS.map((g) => ({
    group: g.id,
    done: g.features.filter((f) => set.has(f)).length,
    total: g.features.length,
  }));
}

/** 全体の「試した数 / 総数」。 */
export function overallProgress(tried: readonly string[]): { done: number; total: number } {
  const set = new Set(tried);
  return { done: MASTERY_FEATURE_IDS.filter((f) => set.has(f)).length, total: MASTERY_FEATURE_IDS.length };
}

/**
 * 「次に試すとよい機能」を選ぶ。`current` と関連の強い未体験の項目を優先し、足りなければ
 * 同じグループの未体験の項目を目次順で補う。体験済み・`current` 自身・未知 ID は出さない。
 */
export function recommendNext(
  current: string,
  tried: readonly string[],
  limit: number = MASTERY_RECOMMEND_LIMIT,
): MasteryFeatureId[] {
  if (!isMasteryFeatureId(current) || limit <= 0) return [];
  const done = new Set(tried);
  const group = MASTERY_GROUPS.find((g) => (g.features as readonly string[]).includes(current));
  const ordered: MasteryFeatureId[] = [
    ...(RELATED[current] ?? []),
    ...((group?.features ?? []) as readonly MasteryFeatureId[]),
  ];
  const out: MasteryFeatureId[] = [];
  for (const id of ordered) {
    if (id === current || done.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}
