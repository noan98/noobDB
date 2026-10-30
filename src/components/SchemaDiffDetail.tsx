import { memo } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import type {
  CheckDiff,
  ColumnDiff,
  DiffForeignKey,
  DiffIndex,
  DiffStatus,
  ForeignKeyDiff,
  GeneratedColumnInfo,
  GeneratedDiff,
  IndexDiff,
  SyncStatement,
  TableColumnInfo,
  TableDiff,
} from "../api/tauri";
import { useLocale, useT } from "../i18n";
import { statusColors } from "./diffStatusColors";
import { CodePreview } from "./modalForm";
import { countTableItems, DIFF_ACTION_GLYPH, type TableGroup } from "./schemaCompareModel";

/**
 * スキーマ差分の表示部品 (一覧・詳細表・操作の記号)。スキーマ比較画面と、サンドボックスの
 * 書き戻し確認 (`SandboxReviewModal`) の両方で使う。
 *
 * `SchemaCompareView` から分けているのは、`App.tsx` が `SchemaCompareView` を遅延 import
 * しているため (`SandboxReviewModal` から直接 import すると初期バンドルへ引き込まれる)。
 */

function fieldLabel(field: string, t: ReturnType<typeof useT>): string {
  switch (field) {
    case "data_type":
      return t("schemaCompareFieldDataType");
    case "nullable":
      return t("schemaCompareFieldNullable");
    case "default":
      return t("schemaCompareFieldDefault");
    case "key":
      return t("schemaCompareFieldKey");
    case "extra":
      return t("schemaCompareFieldExtra");
    case "comment":
      return t("schemaCompareFieldComment");
    case "foreign_key":
      return t("schemaCompareFieldForeignKey");
    default:
      return field;
  }
}

function fieldValue(col: TableColumnInfo | null, field: string, t: ReturnType<typeof useT>): string {
  if (!col) return "—";
  switch (field) {
    case "data_type":
      return col.data_type;
    case "nullable":
      return col.nullable ? t("schemaCompareYes") : t("schemaCompareNo");
    case "default":
      return col.default ?? "NULL";
    case "key":
      return col.key || "—";
    case "extra":
      return col.extra || "—";
    case "comment":
      return col.comment || "—";
    case "foreign_key":
      return col.referenced_table ? `${col.referenced_table}(${col.referenced_column ?? "?"})` : "—";
    default:
      return "—";
  }
}

function idxFieldLabel(field: string, t: ReturnType<typeof useT>): string {
  switch (field) {
    case "columns":
      return t("schemaCompareIdxFieldColumns");
    case "unique":
      return t("schemaCompareIdxFieldUnique");
    case "method":
      return t("schemaCompareIdxFieldMethod");
    case "predicate":
      return t("schemaCompareIdxFieldPredicate");
    case "include":
      return t("schemaCompareIdxFieldInclude");
    case "order":
      return t("schemaCompareIdxFieldOrder");
    case "expression":
      return t("schemaCompareIdxFieldExpression");
    default:
      return field;
  }
}

function idxFieldValue(ix: DiffIndex | null, field: string, t: ReturnType<typeof useT>): string {
  if (!ix) return "—";
  switch (field) {
    case "columns":
      return `(${ix.columns.join(", ")})`;
    case "unique":
      return ix.unique ? t("schemaCompareYes") : t("schemaCompareNo");
    case "method":
      return ix.method ?? "btree";
    case "predicate":
      return ix.predicate ?? "—";
    case "include": {
      const k = ix.key_column_count;
      return k == null ? "—" : ix.columns.slice(k).join(", ") || "—";
    }
    case "order":
      return (ix.column_options ?? []).map((o) => o.trim() || "ASC").join(", ") || "—";
    default:
      return "—";
  }
}

function fkText(fk: DiffForeignKey | null, t: ReturnType<typeof useT>): string {
  if (!fk) return "—";
  const od = fk.on_delete ?? t("schemaCompareActionDefault");
  const ou = fk.on_update ?? t("schemaCompareActionDefault");
  return `(${fk.columns.join(", ")}) → ${fk.referenced_table}(${fk.referenced_columns.join(", ") || "?"}) ON DELETE ${od} ON UPDATE ${ou}`;
}

function fkFieldLabel(field: string, t: ReturnType<typeof useT>): string {
  switch (field) {
    case "on_delete":
      return t("schemaCompareFkFieldOnDelete");
    case "on_update":
      return t("schemaCompareFkFieldOnUpdate");
    case "referenced_columns":
      return t("schemaCompareFkFieldReferencedColumns");
    default:
      return field;
  }
}

function fkFieldValue(fk: DiffForeignKey | null, field: string, t: ReturnType<typeof useT>): string {
  if (!fk) return "—";
  switch (field) {
    case "on_delete":
      return fk.on_delete ?? t("schemaCompareActionDefault");
    case "on_update":
      return fk.on_update ?? t("schemaCompareActionDefault");
    case "referenced_columns":
      return fk.referenced_columns.join(", ") || "—";
    default:
      return "—";
  }
}

/**
 * 状態を「更新先で起きる操作」として呼ぶ短い名前 (追加 / 変更 / 削除 / 同一)。
 * 比較は常に「更新先を基準に合わせる」向きなので、`source_only` は更新先への追加、
 * `target_only` は更新先からの削除になる (`schemaCompareModel.ts`)。
 */
export function statusLabel(status: DiffStatus, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "source_only":
      return t("schemaCompareOpAdd");
    case "target_only":
      return t("schemaCompareOpDrop");
    case "different":
      return t("schemaCompareOpChange");
    case "same":
      return t("schemaCompareOpSame");
  }
}

const actionMarkCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  width: "1.4em",
  height: "1.4em",
  border: "1px solid",
  borderRadius: "var(--radius-sm)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 700,
  lineHeight: 1,
};

/** 操作の記号 (+ ~ − =)。色覚に頼らず記号でも区別できるよう、色と必ず併記する。 */
export function ActionMark({ status }: { status: DiffStatus }) {
  return (
    <chakra.span aria-hidden css={{ ...actionMarkCss, ...statusColors(status) }}>
      {DIFF_ACTION_GLYPH[status]}
    </chakra.span>
  );
}

/** 一覧の絞り込みチップ。押すとその操作のテーブルを出す / 隠す。 */
export function DiffFilterChip({
  status,
  count,
  active,
  onToggle,
  t,
}: {
  status: DiffStatus;
  count: number;
  active: boolean;
  onToggle: (status: DiffStatus) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <chakra.button
      type="button"
      onClick={() => onToggle(status)}
      aria-pressed={active}
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      px="2.5"
      py="0.75"
      fontSize="sm"
      borderRadius="pill"
      border="1px solid"
      borderColor={active ? "app.accent" : "app.border"}
      bg={active ? "app.hover" : "transparent"}
      color={active ? "app.text" : "app.textMuted"}
      cursor="pointer"
      whiteSpace="nowrap"
      _hover={{ bg: "app.hover", color: "app.text" }}
      _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
    >
      <ActionMark status={status} />
      {statusLabel(status, t)}
      <chakra.span fontWeight={600} textStyle="numeric">
        {count}
      </chakra.span>
    </chakra.button>
  );
}

/** 一覧のグループ見出し (「変更するテーブル (3)」など)。 */
function groupLabel(status: DiffStatus, count: number, t: ReturnType<typeof useT>): string {
  switch (status) {
    case "different":
      return t("schemaCompareGroupChange", { count });
    case "source_only":
      return t("schemaCompareGroupAdd", { count });
    case "target_only":
      return t("schemaCompareGroupDrop", { count });
    case "same":
      return t("schemaCompareGroupSame", { count });
  }
}

/** テーブル 1 つの中身の件数 (「2 カラム ・ 1 インデックス・制約」)。 */
function tableMeta(table: TableDiff, t: ReturnType<typeof useT>): string {
  const constraints =
    (table.indexes?.length ?? 0) +
    (table.fk_changes?.length ?? 0) +
    (table.check_changes?.length ?? 0) +
    (table.generated_changes?.length ?? 0);
  const parts: string[] = [];
  if (table.columns.length > 0) parts.push(t("schemaCompareColumnCount", { count: table.columns.length }));
  if (constraints > 0) parts.push(t("schemaCompareConstraintCount", { count: constraints }));
  return parts.join(" ・ ");
}

const listItemCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "2",
  width: "100%",
  py: "1.5",
  px: "2.5",
  background: "transparent",
  border: "none",
  borderLeft: "3px solid transparent",
  textAlign: "left",
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  _hover: { background: "var(--bg-hover)" },
  _focusVisible: { outline: "none", boxShadow: "inset var(--focus-ring)" },
  "&[aria-current='true']": {
    background: "var(--bg-active)",
    borderLeftColor: "var(--accent)",
  },
};

/**
 * 2 ペインの左側: 操作ごとのグループに分けたテーブル名の一覧。押したテーブルの
 * 中身が右の `TableDiffDetail` に出る。
 */
export function TableDiffList({
  groups,
  selected,
  onSelect,
  t,
}: {
  groups: TableGroup[];
  selected: string | null;
  onSelect: (name: string) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <chakra.nav aria-label={t("schemaCompareTableListLabel")}>
      {groups.map((g) => (
        <Box key={g.status}>
          <chakra.div
            textStyle="overline"
            color="app.textMuted"
            px="2.5"
            py="1.5"
            bg="app.surfaceMuted"
            borderBottom="1px solid"
            borderColor="app.borderSubtle"
          >
            {groupLabel(g.status, g.tables.length, t)}
          </chakra.div>
          <chakra.ul listStyle="none" m={0} p={0}>
            {g.tables.map((tbl) => {
              const meta = tableMeta(tbl, t);
              return (
                <chakra.li key={tbl.name} borderBottom="1px solid" borderColor="app.borderSubtle">
                  <chakra.button
                    type="button"
                    css={listItemCss}
                    aria-current={tbl.name === selected ? "true" : undefined}
                    onClick={() => onSelect(tbl.name)}
                  >
                    <ActionMark status={tbl.status} />
                    <chakra.span
                      fontFamily="mono"
                      fontSize="sm"
                      color="app.text"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      minW={0}
                      flex="1"
                    >
                      {tbl.name}
                    </chakra.span>
                    {meta && (
                      <chakra.span textStyle="caption" whiteSpace="nowrap" flex="none">
                        {meta}
                      </chakra.span>
                    )}
                  </chakra.button>
                </chakra.li>
              );
            })}
          </chakra.ul>
        </Box>
      ))}
    </chakra.nav>
  );
}

/** 変更された項目 1 つ (「型: text → longtext」の 1 行ぶん)。`current` は更新先の今の値、`next` は適用後の値。 */
interface ChangeLine {
  label: string;
  current: string;
  next: string;
}

/** 詳細の表の 1 行 (カラム・インデックス・制約・生成列を同じ形にそろえたもの)。 */
interface DiffItemRow {
  key: string;
  status: DiffStatus;
  name: string;
  /** 追加・削除・同一のときの定義 (追加は基準側、削除は更新先側)。 */
  definition: string;
  /** `different` のときの変わる項目。 */
  changes: ChangeLine[];
}

function columnItem(col: ColumnDiff, t: ReturnType<typeof useT>): DiffItemRow {
  const def = col.source ?? col.target;
  return {
    key: `col:${col.name}`,
    status: col.status,
    name: col.name,
    definition: def?.data_type ?? "",
    changes:
      col.status === "different"
        ? col.changed_fields.map((field) => ({
            label: fieldLabel(field, t),
            current: fieldValue(col.target, field, t),
            next: fieldValue(col.source, field, t),
          }))
        : [],
  };
}

function indexItem(ix: IndexDiff, t: ReturnType<typeof useT>): DiffItemRow {
  const def = ix.source ?? ix.target;
  return {
    key: `ix:${ix.name}`,
    status: ix.status,
    name: ix.name,
    definition: def ? `${def.unique ? "UNIQUE " : ""}(${def.columns.join(", ")})` : "",
    changes:
      ix.status === "different"
        ? (ix.changed_fields ?? []).map((field) => ({
            label: idxFieldLabel(field, t),
            current: idxFieldValue(ix.target, field, t),
            next: idxFieldValue(ix.source, field, t),
          }))
        : [],
  };
}

function fkItem(fk: ForeignKeyDiff, i: number, t: ReturnType<typeof useT>): DiffItemRow {
  const def = fk.source ?? fk.target;
  return {
    key: `fk:${i}`,
    status: fk.status,
    name: def?.name ?? def?.columns.join(", ") ?? "",
    definition: fkText(def ?? null, t),
    changes:
      fk.status === "different"
        ? (fk.changed_fields ?? []).map((field) => ({
            label: fkFieldLabel(field, t),
            current: fkFieldValue(fk.target, field, t),
            next: fkFieldValue(fk.source, field, t),
          }))
        : [],
  };
}

function checkItem(ck: CheckDiff, i: number, t: ReturnType<typeof useT>): DiffItemRow {
  const def = ck.source ?? ck.target;
  return {
    key: `ck:${i}`,
    status: ck.status,
    name: ck.name,
    definition: def?.definition ?? "",
    changes:
      ck.status === "different"
        ? [
            {
              label: t("schemaCompareGenFieldExpression"),
              current: ck.target?.definition ?? "—",
              next: ck.source?.definition ?? "—",
            },
          ]
        : [],
  };
}

/** 生成列の差分 1 項目 (`changed_fields` の 1 つ)。 */
function generatedChange(field: string, change: GeneratedDiff, t: ReturnType<typeof useT>): ChangeLine {
  const s = change.source;
  const g = change.target;
  const storage = (x: GeneratedColumnInfo | null) => (x ? (x.is_virtual ? "VIRTUAL" : "STORED") : "—");
  const nullable = (x: GeneratedColumnInfo | null) =>
    x ? (x.not_null ? t("schemaCompareNo") : t("schemaCompareYes")) : "—";
  switch (field) {
    case "storage":
      return { label: t("schemaCompareGenFieldStorage"), current: storage(g), next: storage(s) };
    case "data_type":
      return {
        label: t("schemaCompareFieldDataType"),
        current: g?.data_type ?? "—",
        next: s?.data_type ?? "—",
      };
    case "nullable":
      return { label: t("schemaCompareFieldNullable"), current: nullable(g), next: nullable(s) };
    default:
      return {
        label: t("schemaCompareGenFieldExpression"),
        current: g?.expression ?? "—",
        next: s?.expression ?? "—",
      };
  }
}

function generatedItem(change: GeneratedDiff, t: ReturnType<typeof useT>): DiffItemRow {
  const def = change.source ?? change.target;
  const storage = (g: GeneratedColumnInfo) => (g.is_virtual ? "VIRTUAL" : "STORED");
  return {
    key: `gen:${change.column}`,
    status: change.status,
    name: change.column,
    definition: def ? `${def.expression} (${storage(def)})` : "",
    changes:
      change.status === "different"
        ? (change.changed_fields ?? []).map((field) => generatedChange(field, change, t))
        : [],
  };
}

export const detailTableCss: SystemStyleObject = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-sm)",
  "& th": {
    textAlign: "left",
    fontWeight: 500,
    color: "var(--text-muted)",
    fontSize: "var(--text-xs)",
    padding: "var(--space-1) var(--space-2)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  },
  "& td": {
    padding: "var(--space-1-5) var(--space-2)",
    borderBottom: "1px solid var(--border-subtle)",
    verticalAlign: "top",
  },
};
export const monoCellCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text)",
  wordBreak: "break-word",
};
export const noneCss: SystemStyleObject = { color: "var(--text-muted)", fontSize: "var(--text-xs)" };

/** 基準側のセル。追加・変更では適用後の値、削除では「なし」。 */
function SourceCell({ row, t }: { row: DiffItemRow; t: ReturnType<typeof useT> }) {
  if (row.status === "target_only") return <chakra.span css={noneCss}>{t("schemaCompareNone")}</chakra.span>;
  if (row.status === "different") {
    return (
      <Flex direction="column" gap="0.5">
        {row.changes.map((c) => (
          <chakra.span key={c.label} css={monoCellCss}>
            {c.label}: {c.next}
          </chakra.span>
        ))}
      </Flex>
    );
  }
  return <chakra.span css={monoCellCss}>{row.definition}</chakra.span>;
}

/**
 * 更新先側のセル。変更は「今の値 (打ち消し線) → 適用後の値」、削除は消える定義に打ち消し線、
 * 追加は「なし」。矢印は常に「今 → 適用後」の向きで読めるようにそろえる。
 */
function TargetCell({ row, t }: { row: DiffItemRow; t: ReturnType<typeof useT> }) {
  if (row.status === "source_only") return <chakra.span css={noneCss}>{t("schemaCompareNone")}</chakra.span>;
  if (row.status === "different") {
    return (
      <Flex direction="column" gap="0.5">
        {row.changes.map((c) => (
          <chakra.span key={c.label} css={monoCellCss} data-testid="schema-compare-change">
            {c.label}:{" "}
            <chakra.s color="app.textMuted" aria-label={t("schemaCompareCurrentValue", { value: c.current })}>
              {c.current}
            </chakra.s>{" "}
            → {c.next}
          </chakra.span>
        ))}
      </Flex>
    );
  }
  if (row.status === "target_only") {
    return (
      <chakra.s css={monoCellCss} color="app.textMuted">
        {row.definition}
      </chakra.s>
    );
  }
  return <chakra.span css={monoCellCss}>{row.definition}</chakra.span>;
}

/** 詳細の 1 セクション (カラム / インデックス / 外部キー / CHECK / 生成列)。 */
function DiffItemSection({
  title,
  rows,
  sourceName,
  targetName,
  targetTitle,
  t,
}: {
  title: string;
  rows: DiffItemRow[];
  sourceName: string;
  targetName: string;
  targetTitle?: string;
  t: ReturnType<typeof useT>;
}) {
  if (rows.length === 0) return null;
  return (
    <chakra.section display="flex" flexDirection="column" gap="1">
      <chakra.h4 textStyle="overline" color="app.textSecondary" m={0}>
        {title}
      </chakra.h4>
      <chakra.table css={detailTableCss}>
        <thead>
          <tr>
            <th>{t("schemaCompareColOp")}</th>
            <th>{t("schemaCompareColName")}</th>
            <th>{t("schemaCompareColSource", { name: sourceName })}</th>
            <th>{targetTitle ?? t("schemaCompareColTarget", { name: targetName })}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <chakra.td whiteSpace="nowrap">
                <Flex align="center" gap="1.5" css={{ color: statusColors(row.status).color }}>
                  <ActionMark status={row.status} />
                  {statusLabel(row.status, t)}
                </Flex>
              </chakra.td>
              <chakra.td css={{ ...monoCellCss, fontSize: "var(--text-sm)" }}>{row.name}</chakra.td>
              <td>
                <SourceCell row={row} t={t} />
              </td>
              <td>
                <TargetCell row={row} t={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </chakra.table>
    </chakra.section>
  );
}

/** テーブル単位の要約文 (詳細ペインの見出しの下)。 */
function tableSummary(table: TableDiff, t: ReturnType<typeof useT>): string {
  switch (table.status) {
    case "source_only":
      return t("schemaCompareDetailAddTable");
    case "target_only":
      return t("schemaCompareDetailDropTable");
    case "same":
      return t("schemaCompareDetailSame");
    case "different": {
      const c = countTableItems(table);
      return t("schemaCompareDetailCounts", {
        add: c.source_only,
        change: c.different,
        drop: c.target_only,
      });
    }
  }
}

/**
 * 2 ペインの右側: 選んだテーブルの差分。カラム・インデックス・外部キー・CHECK・
 * 生成列を小見出しで分け、それぞれ「操作 / 名前 / 基準 / 更新先」の表で見せる。
 * 反映 SQL を生成済みなら、このテーブルに対して実行される文も下に出す。
 *
 * サンドボックスの書き戻し確認でも同じ表を使う (`showSql={false}`)。
 */
export const TableDiffDetail = memo(function TableDiffDetail({
  table,
  sourceName,
  targetName,
  statements,
  planReady,
  showSql = true,
  targetTitle,
  t,
}: {
  table: TableDiff;
  sourceName: string;
  targetName: string;
  /** このテーブルに対する同期 SQL (生成済みのときだけ意味を持つ)。 */
  statements: SyncStatement[];
  /** スキーマ同期 SQL を生成済みか。 */
  planReady: boolean;
  /** 「このテーブルで実行される SQL」欄を出すか。SQL を別の場所でまとめて見せる画面は false。 */
  showSql?: boolean;
  /** 右列の見出しを差し替える (既定は「更新先の現在 → 適用後 (名前)」)。比べている相手が
   *  更新先の今の値ではない画面 (サンドボックスはスナップショットと比べる) で使う。 */
  targetTitle?: string;
  t: ReturnType<typeof useT>;
}) {
  // memo で親の再レンダーを遮断しても、言語切替では描き直す (t は参照が変わらない)。
  useLocale();
  const columns = table.columns.map((c) => columnItem(c, t));
  const indexes = (table.indexes ?? []).map((ix) => indexItem(ix, t));
  const fks = (table.fk_changes ?? []).map((fk, i) => fkItem(fk, i, t));
  const checks = (table.check_changes ?? []).map((ck, i) => checkItem(ck, i, t));
  const generated = (table.generated_changes ?? []).map((g) => generatedItem(g, t));
  const destructive = statements.filter((s) => s.destructive).length;
  const sectionProps = { sourceName, targetName, targetTitle, t };

  return (
    <Flex direction="column" gap="3.5">
      <Box>
        <Flex align="center" gap="2">
          <ActionMark status={table.status} />
          <chakra.h3 m={0} fontFamily="mono" fontSize="md" color="app.text">
            {table.name}
          </chakra.h3>
        </Flex>
        <chakra.p m={0} mt="1" textStyle="body" color="app.textSecondary">
          {tableSummary(table, t)}
        </chakra.p>
      </Box>
      <DiffItemSection title={t("schemaCompareSectionColumns")} rows={columns} {...sectionProps} />
      <DiffItemSection title={t("schemaCompareSectionIndexes")} rows={indexes} {...sectionProps} />
      <DiffItemSection title={t("schemaCompareSectionForeignKeys")} rows={fks} {...sectionProps} />
      <DiffItemSection title={t("schemaCompareSectionChecks")} rows={checks} {...sectionProps} />
      <DiffItemSection title={t("schemaCompareSectionGenerated")} rows={generated} {...sectionProps} />
      {showSql && table.status !== "same" && (
        <chakra.section display="flex" flexDirection="column" gap="1">
          <chakra.h4 textStyle="overline" color="app.textSecondary" m={0}>
            {planReady
              ? t("schemaCompareTableSql", { count: statements.length })
              : t("schemaCompareTableSqlTitle")}
          </chakra.h4>
          {!planReady ? (
            <chakra.p m={0} textStyle="caption">
              {t("schemaCompareTableSqlHint")}
            </chakra.p>
          ) : statements.length === 0 ? (
            <chakra.p m={0} textStyle="caption">
              {t("schemaCompareTableSqlNone")}
            </chakra.p>
          ) : (
            <>
              {destructive > 0 && (
                <chakra.p m={0} fontSize="xs" color="app.textError">
                  {t("schemaCompareTableSqlDestructive", { count: destructive })}
                </chakra.p>
              )}
              <CodePreview wrap fontSize="xs" maxH="240px">
                {statements.map((s) => s.sql).join("\n")}
              </CodePreview>
            </>
          )}
        </chakra.section>
      )}
    </Flex>
  );
});
