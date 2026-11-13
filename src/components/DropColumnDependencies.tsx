import { chakra } from "@chakra-ui/react";
import type { ColumnDependency, ColumnDependencyKind } from "../api/tauri";
import type { ColumnDependencyState } from "../useColumnDependencies";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { ImpactTree, type ImpactGroup, type ImpactKind, type ImpactOutcome } from "./ImpactTree";

/** 一覧に出す依存の最大行数。超えた分は「ほか N 件」に畳み、押すと展開する。 */
const MAX_LINES = 12;

const KIND_KEY = {
  view: "dropColumnDepView",
  materialized_view: "dropColumnDepMatView",
  trigger: "dropColumnDepTrigger",
  generated_column: "dropColumnDepGenerated",
  index: "dropColumnDepIndex",
  foreign_key: "dropColumnDepForeignKey",
  referenced_by: "dropColumnDepReferencedBy",
} as const satisfies Record<ColumnDependencyKind, string>;

/** 依存の種別 → 影響ツリーのグリフ。 */
const KIND_GLYPH: Record<ColumnDependencyKind, ImpactKind> = {
  view: "view",
  materialized_view: "matview",
  trigger: "trigger",
  generated_column: "column",
  index: "index",
  foreign_key: "foreign_key",
  referenced_by: "table",
};

/** 依存の種別 → 巻き込まれ方。ビュー / トリガーは壊れ、生成列 / 外部キーは DROP を止め、インデックスは変わる。 */
const KIND_OUTCOME: Record<ColumnDependencyKind, ImpactOutcome> = {
  view: "break",
  materialized_view: "break",
  trigger: "break",
  generated_column: "block",
  index: "change",
  foreign_key: "block",
  referenced_by: "block",
};

/** `warnings` の内部キー → 表示名。 */
const WARNING_KEY: Record<
  string,
  | "dropColumnWarnDefinitions"
  | "dropColumnWarnIndexes"
  | "dropColumnWarnForeignKeys"
  | "dropColumnWarnGenerated"
> = {
  definitions: "dropColumnWarnDefinitions",
  indexes: "dropColumnWarnIndexes",
  foreign_keys: "dropColumnWarnForeignKeys",
  generated_columns: "dropColumnWarnGenerated",
};

/**
 * DROP COLUMN の確認に添える「この列を参照している依存オブジェクト」の警告 (#1758)。
 * ビュー・生成列・インデックス・外部キー・トリガーを、起点の列チップから影響ツリー (#2295) で並べる。依存が無ければ
 * 何も描かない (取得中・取得失敗は控えめな一行だけ。実行は止めない)。
 */
export function DropColumnDependencies({ state }: { state: ColumnDependencyState }) {
  const t = useT();
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <chakra.p m={0} fontSize="sm" color="app.textMuted" data-testid="drop-column-deps-loading">
        {t("dropColumnDepsLoading")}
      </chakra.p>
    );
  }
  if (state.status === "error") {
    return (
      <Callout tone="warning" role="status" data-testid="drop-column-deps-error">
        {t("dropColumnDepsError", { error: state.error })}
      </Callout>
    );
  }
  const { dependencies, warnings } = state.report;
  if (dependencies.length === 0 && warnings.length === 0) return null;
  const groups = groupByColumn(dependencies, t);
  return (
    <Callout
      tone="warning"
      role="status"
      title={
        dependencies.length > 0
          ? t("dropColumnDepsTitle", { count: dependencies.length })
          : t("dropColumnDepsIncompleteTitle")
      }
      data-testid="drop-column-deps"
    >
      {dependencies.length > 0 && (
        <>
          <chakra.p m={0}>{t("dropColumnDepsBody")}</chakra.p>
          <ImpactTree groups={groups} maxVisible={MAX_LINES} />
        </>
      )}
      {warnings.length > 0 && (
        <chakra.p m={0} mt="1" data-testid="drop-column-deps-warnings">
          {t("dropColumnDepsIncomplete", {
            kinds: warnings.map((w) => t(WARNING_KEY[w] ?? "dropColumnWarnOther")).join(", "),
          })}
        </chakra.p>
      )}
    </Callout>
  );
}

/** 依存を列ごとの塊にする (起点チップ = 削除する列)。列の並びは初出順。 */
function groupByColumn(deps: ColumnDependency[], t: ReturnType<typeof useT>): ImpactGroup[] {
  const groups = new Map<string, ImpactGroup>();
  for (const d of deps) {
    let g = groups.get(d.column);
    if (!g) {
      g = { key: d.column, origin: { kind: "column", name: d.column }, nodes: [] };
      groups.set(d.column, g);
    }
    const meta = [d.confidence === "possible" ? t("dropColumnDepPossible") : null, d.detail]
      .filter((p): p is string => !!p)
      .join(" · ");
    g.nodes.push({
      key: `${d.kind}\0${d.name}\0${d.detail}`,
      kind: KIND_GLYPH[d.kind],
      kindLabel: t(KIND_KEY[d.kind]),
      name: d.name,
      outcome: KIND_OUTCOME[d.kind],
      meta: meta || undefined,
    });
  }
  return [...groups.values()];
}
