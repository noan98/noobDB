import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { materializedViews } from "../viewRebuild";
import type { ViewRebuildState } from "../useViewRebuildPlan";
import { Callout } from "./Callout";
import { ImpactTree, type ImpactGroup } from "./ImpactTree";
import { ErrorNote } from "./modalForm";
import { formatBytes, formatRowCount } from "./tableSize";
import { Switch } from "./ui";

/** 一覧に出す依存ビューの最大行数。超えた分は「ほか N 件」に畳み、押すと展開する。 */
const MAX_LINES = 12;

interface Props {
  state: ViewRebuildState;
  /** 「依存ビューを作り直して適用」を選んでいるか。 */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** マテリアライズドビューを作り直し後に `REFRESH` して再計算する (偽なら空のまま)。 */
  withData: boolean;
  onWithDataChange: (next: boolean) => void;
  /** 作り直すビューが参照する列で、同じ ALTER でリネーム / 削除されるもの (作り直しの SQL は旧い列名を参照するので止める)。 */
  conflictColumns: string[];
  /** 型を変える列 (起点チップに出す)。省略すると起点なしの木になる。 */
  changedColumns?: string[];
}

/**
 * PostgreSQL の列の型変更が、ビュー / マテリアライズドビューに依存されているときの案内 (#2268)。
 * 依存が無ければ何も描かない (従来どおり)。作り直せない依存 (RLS ポリシーなど) があるときは理由を出して
 * 適用を止め、作り直せるときは「依存ビュー N 件を作り直して適用」を明示的に選ばせる。
 * 実際の SQL は呼び出し側のプレビューに DROP / CREATE / 復元として現れる。
 * 依存ビューは起点の列チップから影響ツリー (#2295) で並べる。バックエンドは依存の親子関係を返さない
 * (作り直す順の平坦な一覧) ので、字下げは使わず平坦に表示する。
 */
export function ViewRebuildNotice({
  state,
  enabled,
  onEnabledChange,
  withData,
  onWithDataChange,
  conflictColumns,
  changedColumns,
}: Props) {
  const t = useT();
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <chakra.p m={0} fontSize="sm" color="app.textMuted" data-testid="view-rebuild-loading">
        {t("viewRebuildLoading")}
      </chakra.p>
    );
  }
  if (state.status === "error") {
    return (
      <Callout tone="warning" role="status" data-testid="view-rebuild-error">
        {t("viewRebuildError", { error: state.error })}
      </Callout>
    );
  }
  const { plan } = state;
  if (plan.views.length === 0) return null;
  if (plan.views.length > 0 && plan.blockers.length > 0) {
    return (
      <ErrorNote role="alert" title={t("viewRebuildBlockedTitle")} data-testid="view-rebuild-blocked">
        <chakra.p m={0}>{t("viewRebuildBlockedBody")}</chakra.p>
        <ImpactTree
          groups={[
            {
              key: "blockers",
              nodes: plan.blockers.map((b) => ({
                key: `${b.kind}\0${b.description}`,
                kind: "other",
                name: b.description,
                outcome: "block",
              })),
            },
          ]}
          maxVisible={MAX_LINES}
        />
      </ErrorNote>
    );
  }
  const groups: ImpactGroup[] = [
    {
      key: "views",
      origin:
        changedColumns && changedColumns.length > 0
          ? { kind: "column", name: changedColumns.join(", ") }
          : undefined,
      nodes: plan.views.map((v) => ({
        key: `${v.schema}.${v.name}`,
        kind: v.kind === "view" ? "view" : "matview",
        kindLabel: t(v.kind === "view" ? "dropColumnDepView" : "dropColumnDepMatView"),
        name: `${v.schema}.${v.name}`,
        outcome: "rebuild",
      })),
    },
  ];
  const matviews = materializedViews(plan);
  const totalBytes = matviews.reduce((n, v) => n + (v.size_bytes ?? 0), 0);
  const totalRows = matviews.reduce((n, v) => n + Math.max(v.est_rows ?? 0, 0), 0);
  return (
    <Callout
      tone="warning"
      role="status"
      title={t("viewRebuildTitle", { count: plan.views.length })}
      data-testid="view-rebuild"
    >
      <chakra.p m={0}>{t("viewRebuildBody")}</chakra.p>
      <ImpactTree groups={groups} maxVisible={MAX_LINES} />
      {conflictColumns.length > 0 && (
        <chakra.p m={0} mt="1" data-testid="view-rebuild-rename">
          {t("viewRebuildRenameConflict", { columns: conflictColumns.join(", ") })}
        </chakra.p>
      )}
      <chakra.div display="flex" flexDirection="column" gap="1" mt="2">
        <Switch
          checked={enabled}
          onChange={() => onEnabledChange(!enabled)}
          label={t("viewRebuildToggle", { count: plan.views.length })}
        />
        {!enabled && (
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("viewRebuildOffHint")}
          </chakra.span>
        )}
        {enabled && matviews.length > 0 && (
          <>
            <chakra.span fontSize="sm" data-testid="view-rebuild-matview-warning">
              {t("viewRebuildMatviewWarning", {
                count: matviews.length,
                size: formatBytes(totalBytes),
                rows: formatRowCount(totalRows),
              })}
            </chakra.span>
            <Switch
              checked={!withData}
              onChange={() => onWithDataChange(!withData)}
              label={t("viewRebuildNoData")}
            />
          </>
        )}
        {enabled && (
          <chakra.span textStyle="caption" color="app.textMuted">
            {t("viewRebuildOnHint")}
          </chakra.span>
        )}
      </chakra.div>
    </Callout>
  );
}
