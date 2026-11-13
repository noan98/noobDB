import { useMemo } from "react";
import { chakra } from "@chakra-ui/react";
import type { ExtensionDependent } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Callout } from "./Callout";
import {
  formatExtensionDependent,
  groupExtensionDependents,
  type ExtensionDependentKind,
} from "./extensionSql";
import { ImpactTree, type ImpactKind } from "./ImpactTree";
import { ErrorNote } from "./modalForm";
import { Spinner } from "./Spinner";

/**
 * 拡張機能の削除確認で出す「依存するオブジェクト」の一覧 (#2177)。`DROP EXTENSION ... CASCADE` で一緒に
 * 消えるもの (その拡張の型を使う列・関数・ビューなど) を、実行前に起点 (拡張機能) のチップから影響ツリー
 * (#2295) で見せる。種別ごとにまとめ、列は消すとデータが失われるので先頭に置く。CASCADE なしで依存があるときは「このままでは失敗する」
 * ことを事前に示す。取得に失敗しても削除自体は妨げない (呼び出し側はボタンを止めない)。
 */
interface Props {
  /** 取得結果。`null` は取得中。 */
  dependents: ExtensionDependent[] | null;
  /** 取得に失敗したときのメッセージ。 */
  error: string | null;
  cascade: boolean;
  /** 起点チップに出す拡張機能名。 */
  extension?: string;
}

const KIND_LABEL: Record<ExtensionDependentKind, I18nKey> = {
  column: "extensionsDepsKind_column",
  table: "extensionsDepsKind_table",
  view: "extensionsDepsKind_view",
  materialized_view: "extensionsDepsKind_materialized_view",
  function: "extensionsDepsKind_function",
  procedure: "extensionsDepsKind_procedure",
  index: "extensionsDepsKind_index",
  constraint: "extensionsDepsKind_constraint",
  trigger: "extensionsDepsKind_trigger",
  default: "extensionsDepsKind_default",
  policy: "extensionsDepsKind_policy",
  statistic: "extensionsDepsKind_statistic",
  sequence: "extensionsDepsKind_sequence",
  type: "extensionsDepsKind_type",
  rule: "extensionsDepsKind_rule",
  extension: "extensionsDepsKind_extension",
  other: "extensionsDepsKind_other",
};

/** この件数を超える一覧は表示を打ち切る (数千件で DOM を膨らませない)。 */
const LIST_MAX = 200;

/** 一覧に出す依存の最大行数。超えた分は「ほか N 件」に畳み、押すと展開する。 */
const MAX_LINES = 12;

/** 依存の種別 → 影響ツリーのグリフ。 */
const KIND_GLYPH: Record<ExtensionDependentKind, ImpactKind> = {
  column: "column",
  table: "table",
  view: "view",
  materialized_view: "matview",
  function: "function",
  procedure: "function",
  index: "index",
  constraint: "foreign_key",
  trigger: "trigger",
  default: "column",
  policy: "other",
  statistic: "other",
  sequence: "other",
  type: "other",
  rule: "other",
  extension: "other",
  other: "other",
};

export function ExtensionDependents({ dependents, error, cascade, extension }: Props) {
  const t = useT();
  const nodes = useMemo(
    () =>
      groupExtensionDependents(dependents ?? [])
        .flatMap(({ kind, items }) => items.map((d) => ({ kind, label: formatExtensionDependent(d) })))
        .slice(0, LIST_MAX)
        .map(({ kind, label }, i) => ({
          key: `${kind}\u0000${label}\u0000${i}`,
          kind: KIND_GLYPH[kind],
          kindLabel: t(KIND_LABEL[kind]),
          name: label,
          // CASCADE なら一緒に消える。なしなら依存が DROP を止める。列は消えるとデータも失われる。
          outcome: cascade ? ("cascade" as const) : ("block" as const),
          meta: kind === "column" && cascade ? t("extensionsDepsDataLoss") : undefined,
        })),
    [dependents, cascade, t],
  );

  if (error) return <ErrorNote>{t("extensionsDepsError", { error })}</ErrorNote>;
  if (dependents === null) {
    return (
      <chakra.div display="flex" alignItems="center" gap="2" textStyle="caption" color="app.textMuted">
        <Spinner size={12} decorative />
        {t("extensionsDepsLoading")}
      </chakra.div>
    );
  }
  if (dependents.length === 0) {
    return (
      <chakra.p margin={0} textStyle="caption" color="app.textSuccess" role="status">
        {t("extensionsDepsNone")}
      </chakra.p>
    );
  }

  return (
    <chakra.div display="flex" flexDirection="column" gap="2">
      {cascade ? (
        <chakra.p margin={0} textStyle="body" fontWeight={600} color="app.text">
          {t("extensionsDepsCascadeTitle", { count: dependents.length })}
        </chakra.p>
      ) : (
        <Callout tone="danger" role="alert">
          {t("extensionsDepsWillFail", { count: dependents.length })}
        </Callout>
      )}
      <ImpactTree
        groups={[
          {
            key: "dependents",
            origin: extension ? { kind: "other", name: extension } : undefined,
            nodes,
          },
        ]}
        maxVisible={MAX_LINES}
        testId="extension-dependents"
      />
      {dependents.length > LIST_MAX && (
        <chakra.p margin={0} textStyle="caption" color="app.textMuted">
          … +{dependents.length - LIST_MAX}
        </chakra.p>
      )}
    </chakra.div>
  );
}
