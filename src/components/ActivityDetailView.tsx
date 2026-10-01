import { chakra, type SystemStyleObject } from "@chakra-ui/react";

import type { SchemaDriftTableChange } from "../api/tauri";
import type { ActivityDetail } from "../activityLog";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";

/**
 * アクティビティの行を展開したときに出す詳細 (#912 の拡張)。
 *
 * トーストは 1 行の要約 (`+orders, users(+1,~1), …`) しか出せないので、後から
 * 「どのテーブルにどの列が増えたか」を確かめられるよう表で見せる。
 */
export function ActivityDetailView({ detail }: { detail: ActivityDetail }) {
  switch (detail.kind) {
    case "schemaDrift":
      return <SchemaDriftDetailTable tables={detail.summary.tables} />;
  }
}

const thCss: SystemStyleObject = {
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  padding: "var(--space-1) var(--space-2)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  padding: "var(--space-1) var(--space-2)",
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  fontSize: "var(--text-sm)",
  verticalAlign: "top",
};

/** 名前のリスト 1 種類 (追加 / 削除 / 変更) を記号つきで並べる。 */
function NameList({
  sign,
  role,
  names,
  count,
  label,
}: {
  sign: string;
  role: "success" | "danger" | "warning";
  names: readonly string[] | undefined;
  count: number;
  label: string;
}) {
  if (count === 0) return null;
  return (
    <chakra.div display="flex" gap="1.5" alignItems="baseline" flexWrap="wrap">
      <chakra.span color={semanticColorToken(role, "text")} fontWeight={600} textStyle="numeric">
        {sign}
      </chakra.span>
      <chakra.span color="app.textMuted">{label}</chakra.span>
      {/* 古いバックエンドは名前を返さないので、その場合は件数だけを出す。 */}
      {names && names.length > 0 ? (
        <chakra.span fontFamily="var(--font-mono)" wordBreak="break-all">
          {names.join(", ")}
        </chakra.span>
      ) : (
        <chakra.span textStyle="numeric">{count}</chakra.span>
      )}
    </chakra.div>
  );
}

function SchemaDriftDetailTable({ tables }: { tables: readonly SchemaDriftTableChange[] }) {
  const t = useT();
  return (
    <chakra.table width="100%" mt="1" style={{ borderCollapse: "collapse" }}>
      <chakra.thead>
        <chakra.tr>
          <chakra.th css={thCss}>{t("activityDriftColTable")}</chakra.th>
          <chakra.th css={thCss}>{t("activityDriftColColumns")}</chakra.th>
          <chakra.th css={thCss}>{t("activityDriftColIndexes")}</chakra.th>
        </chakra.tr>
      </chakra.thead>
      <chakra.tbody>
        {tables.map((c) => (
          <chakra.tr key={c.table}>
            <chakra.td css={tdCss} fontFamily="var(--font-mono)" whiteSpace="nowrap">
              {c.table}
            </chakra.td>
            {c.tableStatus === "changed" ? (
              <>
                <chakra.td css={tdCss}>
                  <NameList sign="+" role="success" label={t("activityDriftAdded")} names={c.addedColumns} count={c.columnsAdded} />
                  <NameList sign="−" role="danger" label={t("activityDriftRemoved")} names={c.removedColumns} count={c.columnsRemoved} />
                  <NameList sign="~" role="warning" label={t("activityDriftChanged")} names={c.changedColumns} count={c.columnsChanged} />
                </chakra.td>
                <chakra.td css={tdCss}>
                  <NameList sign="+" role="success" label={t("activityDriftAdded")} names={c.addedIndexes} count={c.indexesAdded} />
                  <NameList sign="−" role="danger" label={t("activityDriftRemoved")} names={c.removedIndexes} count={c.indexesRemoved} />
                  <NameList sign="~" role="warning" label={t("activityDriftChanged")} names={c.changedIndexes} count={c.indexesChanged} />
                </chakra.td>
              </>
            ) : (
              <chakra.td
                css={tdCss}
                colSpan={2}
                color={semanticColorToken(c.tableStatus === "added" ? "success" : "danger", "text")}
              >
                {c.tableStatus === "added" ? t("schemaDriftTableAddedLabel") : t("schemaDriftTableRemovedLabel")}
              </chakra.td>
            )}
          </chakra.tr>
        ))}
      </chakra.tbody>
    </chakra.table>
  );
}
