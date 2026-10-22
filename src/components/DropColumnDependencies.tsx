import { Box, chakra } from "@chakra-ui/react";
import type { ColumnDependency, ColumnDependencyKind } from "../api/tauri";
import type { ColumnDependencyState } from "../useColumnDependencies";
import { useT } from "../i18n";
import { Callout } from "./Callout";

/** 一覧に出す依存の最大行数。超えた分は「ほか N 件」に畳む。 */
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
 * ビュー・生成列・インデックス・外部キー・トリガーを `列 ← 種別 名前` の形で並べる。依存が無ければ
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
  const shown = dependencies.slice(0, MAX_LINES);
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
          <Box as="ul" m={0} mt="1" pl="5" fontSize="sm">
            {shown.map((d) => (
              <DependencyLine key={`${d.column}\0${d.kind}\0${d.name}\0${d.detail}`} dep={d} />
            ))}
            {dependencies.length > shown.length && (
              <Box as="li" listStyleType="none" ml="-5">
                {t("dropReferencedByMore", { count: dependencies.length - shown.length })}
              </Box>
            )}
          </Box>
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

function DependencyLine({ dep }: { dep: ColumnDependency }) {
  const t = useT();
  return (
    <Box as="li" wordBreak="break-all">
      <chakra.span fontFamily="mono">{dep.column}</chakra.span>
      {" ← "}
      {t(KIND_KEY[dep.kind])} <chakra.span fontFamily="mono">{dep.name}</chakra.span>
      {dep.confidence === "possible" && ` (${t("dropColumnDepPossible")})`}
      {dep.detail && (
        <chakra.span fontFamily="mono" color="app.textMuted">
          {" "}
          {dep.detail}
        </chakra.span>
      )}
    </Box>
  );
}
