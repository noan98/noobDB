import { useId, useMemo, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";

import type { DiffStatus, DriverKind, ObjectComparison, ObjectDiff } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { statusColors } from "./diffStatusColors";
import { CodePreview } from "./modalForm";
import { TreeChevron } from "./tree";

/**
 * スキーマ比較の「非テーブルオブジェクト」セクション (#1879)。ビュー / マテビュー / ルーチン /
 * トリガー / シーケンスの差分を、テーブル差分と同じ語彙 (状態バッジ + 左スパイン + 開閉行) で
 * 並べる。ドライバに無い種別は「対象外」と理由付きで示し、取得に失敗したときは差分なしに
 * 見せず警告する。
 */

const DRIVER_NAMES: Record<DriverKind, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

const sectionCss: SystemStyleObject = {
  marginTop: "6",
  paddingTop: "4",
  borderTop: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  gap: "2",
};
const titleCss: SystemStyleObject = { margin: 0, fontSize: "var(--text-md)" };
const chipsCss: SystemStyleObject = { display: "flex", flexWrap: "wrap", gap: "2", alignItems: "center" };
const listCss: SystemStyleObject = { display: "flex", flexDirection: "column", gap: "1" };
const rowCss: SystemStyleObject = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-elevated)",
  overflow: "hidden",
  borderLeftWidth: "4px",
};
const rowHeadCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "2.5",
  width: "100%",
  py: "2",
  px: "3",
  background: "transparent",
  border: "none",
  textAlign: "left",
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  _focusVisible: { outline: "none", boxShadow: "var(--focus-ring)" },
};
const nameCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
};
const mutedCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-muted)",
};
const kindCss: SystemStyleObject = {
  textStyle: "overline",
  color: "var(--text-secondary)",
};
const bodyCss: SystemStyleObject = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
  gap: "3",
  padding: "0 var(--space-3) var(--space-3)",
};
const defLabelCss: SystemStyleObject = { textStyle: "overline", marginBottom: "1" };
const unsupportedCss: SystemStyleObject = {
  margin: 0,
  paddingLeft: "var(--space-4-5)",
  fontSize: "var(--text-sm)",
  color: "var(--text-muted)",
};

function badgeCss(status: DiffStatus): SystemStyleObject {
  return {
    textStyle: "overline",
    padding: "var(--space-0-25) var(--space-2)",
    borderRadius: "var(--radius-pill)",
    whiteSpace: "nowrap",
    border: "1px solid transparent",
    ...statusColors(status),
  };
}

function chipCss(status: DiffStatus): SystemStyleObject {
  return {
    textStyle: "overline",
    padding: "var(--space-0-75) var(--space-2-5)",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border)",
    background: "var(--bg-muted)",
    ...statusColors(status),
  };
}

// 状態は「更新先で起きる操作」(追加 / 変更 / 削除 / 同一) で呼ぶ。テーブルの差分一覧と揃える。
const STATUS_KEYS = {
  source_only: "schemaCompareOpAdd",
  target_only: "schemaCompareOpDrop",
  different: "schemaCompareOpChange",
  same: "schemaCompareOpSame",
} as const;

const KIND_KEYS = {
  view: "schemaCompareObjectKindView",
  materialized_view: "schemaCompareObjectKindMaterializedView",
  function: "schemaCompareObjectKindFunction",
  procedure: "schemaCompareObjectKindProcedure",
  trigger: "schemaCompareObjectKindTrigger",
  sequence: "schemaCompareObjectKindSequence",
} as const;

export function objectKindLabel(kind: string, t: ReturnType<typeof useT>): string {
  const key = KIND_KEYS[kind as keyof typeof KIND_KEYS];
  return key ? t(key) : kind;
}

/** 種別がドライバに無い理由。 */
function unsupportedReason(kind: string, driver: DriverKind, t: ReturnType<typeof useT>): string {
  const vars = { driver: DRIVER_NAMES[driver] };
  switch (kind) {
    case "sequence":
      return t("schemaCompareObjectUnsupportedSequence", vars);
    case "function":
    case "procedure":
      return t("schemaCompareObjectUnsupportedRoutine", vars);
    case "materialized_view":
      return t("schemaCompareObjectUnsupportedMaterializedView", vars);
    default:
      return t("schemaCompareObjectUnsupportedGeneric", vars);
  }
}

function ObjectRow({ item }: { item: ObjectDiff }) {
  const t = useT();
  const [open, setOpen] = useState(item.status === "different");
  const bodyId = `${useId()}-body`;
  const expandable = item.status !== "same";
  const header = (
    <>
      <TreeChevron
        aria-hidden
        visibility={expandable ? "visible" : "hidden"}
        transform={expandable && open ? "rotate(90deg)" : undefined}
      >
        ▸
      </TreeChevron>
      <chakra.span css={badgeCss(item.status)}>{t(STATUS_KEYS[item.status])}</chakra.span>
      <chakra.span css={kindCss}>{objectKindLabel(item.kind, t)}</chakra.span>
      <chakra.span css={nameCss}>{item.name}</chakra.span>
      {item.signature !== null && <chakra.span css={mutedCss}>({item.signature})</chakra.span>}
      {item.table && (
        <chakra.span css={mutedCss}>{t("schemaCompareObjectOnTable", { table: item.table })}</chakra.span>
      )}
    </>
  );
  return (
    <Box css={{ ...rowCss, borderLeftColor: statusColors(item.status).color }}>
      {expandable ? (
        <chakra.button
          type="button"
          css={rowHeadCss}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {header}
        </chakra.button>
      ) : (
        <chakra.div css={{ ...rowHeadCss, cursor: "default" }}>{header}</chakra.div>
      )}
      {expandable && open && (
        <Box id={bodyId} css={bodyCss}>
          {item.source_definition !== null && (
            <Box>
              <chakra.div css={defLabelCss}>{t("schemaCompareObjectSourceDefinition")}</chakra.div>
              <CodePreview wrap maxH="16rem">
                {item.source_definition}
              </CodePreview>
            </Box>
          )}
          {item.target_definition !== null && (
            <Box>
              <chakra.div css={defLabelCss}>{t("schemaCompareObjectTargetDefinition")}</chakra.div>
              <CodePreview wrap maxH="16rem">
                {item.target_definition}
              </CodePreview>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/** 差分のあるオブジェクトの件数 (同期の要否判定に使う)。 */
export function countObjectDifferences(objects: ObjectComparison | undefined): number {
  return objects ? objects.items.filter((o) => o.status !== "same").length : 0;
}

export function SchemaObjectDiff({
  objects,
  driver,
  hideSame,
}: {
  objects: ObjectComparison;
  driver: DriverKind;
  hideSame: boolean;
}) {
  const t = useT();
  const counts = useMemo(() => {
    const c: Record<DiffStatus, number> = { source_only: 0, target_only: 0, different: 0, same: 0 };
    for (const o of objects.items) c[o.status] += 1;
    return c;
  }, [objects.items]);
  const visible = useMemo(
    () => objects.items.filter((o) => !(hideSame && o.status === "same")),
    [objects.items, hideSame],
  );

  return (
    <Box css={sectionCss} role="region" aria-label={t("schemaCompareObjectsTitle")}>
      <chakra.h3 css={titleCss}>{t("schemaCompareObjectsTitle")}</chakra.h3>
      {!objects.compared ? (
        <Callout tone="warning" role="status">
          {t("schemaCompareObjectsNotCompared")}
        </Callout>
      ) : (
        <>
          <Box css={chipsCss}>
            {(["different", "source_only", "target_only", "same"] as const).map((s) => (
              <chakra.span key={s} css={chipCss(s)}>
                {t(STATUS_KEYS[s])}: {counts[s]}
              </chakra.span>
            ))}
          </Box>
          {visible.length === 0 ? (
            <chakra.p margin={0} fontSize="sm" color="app.textMuted">
              {counts.different + counts.source_only + counts.target_only === 0
                ? t("schemaCompareObjectsIdentical")
                : t("schemaCompareObjectsAllHidden")}
            </chakra.p>
          ) : (
            <Box css={listCss}>
              {visible.map((o) => (
                <ObjectRow key={`${o.kind}:${o.name}:${o.signature ?? ""}:${o.table ?? ""}`} item={o} />
              ))}
            </Box>
          )}
        </>
      )}
      {objects.unsupported_kinds.length > 0 && (
        <Box>
          <chakra.div textStyle="overline">{t("schemaCompareObjectUnsupportedTitle")}</chakra.div>
          <chakra.ul css={unsupportedCss}>
            {objects.unsupported_kinds.map((k) => (
              <li key={k}>
                <chakra.strong>{objectKindLabel(k, t)}</chakra.strong>: {unsupportedReason(k, driver, t)}
              </li>
            ))}
          </chakra.ul>
        </Box>
      )}
    </Box>
  );
}
