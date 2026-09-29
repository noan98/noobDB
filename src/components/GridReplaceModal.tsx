import { useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import type { CellValue, Column } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import type { BulkEditTarget } from "./bulkEdit";
import {
  buildColumnReplaceSql,
  columnReplaceUnsupported,
  isTextColumnType,
  planGridReplace,
} from "./columnReplace";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { buildServerFilterClause, type ServerFilter } from "./serverBrowse";
import { Button, Checkbox, Input, Radio } from "./ui";

/**
 * 結果グリッド列の「検索して置換」ダイアログ (#1242)。
 *
 * 2 つの範囲を選べる。判定・SQL 生成は `columnReplace.ts` の純ロジックに任せ、ここは
 * 入力・プレビュー・スキップ件数の提示だけを持つ。
 *
 * - **取得済みの行**: ヒットしたセルを保留編集へ積む (`onApplyInGrid`)。確定は通常の
 *   Apply (`run_query_transaction` の all-or-nothing) で行う。
 * - **列全体**: `UPDATE ... SET c = REPLACE(...)` を 1 文で組み、`onApplyColumn` へ渡す。
 *   確認ダイアログと実行は呼び出し側 (App) が担う。
 */
interface Props {
  columns: Column[];
  rows: CellValue[][];
  pkIndices: number[];
  /** 置換対象の列添字。 */
  colIdx: number;
  driver: string;
  database: string | null;
  /** 対象テーブル (テーブルタブのみ)。無ければ列全体モードは選べない。 */
  table: string | null;
  editableColumns?: boolean[];
  validateEdit?: (colIdx: number, value: string) => I18nKey | null;
  /** テーブルブラウズのサーバ側フィルタ。列全体モードの WHERE に限定できる。 */
  serverFilter?: ServerFilter | null;
  /** 列全体モードの実行ハンドラ。未指定なら列全体モードを出さない。 */
  onApplyColumn?: (sql: string) => void;
  onApplyInGrid: (targets: BulkEditTarget[]) => void;
  onClose: () => void;
}

type Mode = "grid" | "column";

export function GridReplaceModal({
  columns,
  rows,
  pkIndices,
  colIdx,
  driver,
  database,
  table,
  editableColumns,
  validateEdit,
  serverFilter,
  onApplyColumn,
  onApplyInGrid,
  onClose,
}: Props) {
  const t = useT();
  const col = columns[colIdx];
  const columnEditable = editableColumns?.[colIdx] ?? false;
  const columnModeAvailable = !!onApplyColumn && !!table && database !== null;
  const gridModeAvailable = pkIndices.length > 0 && columnEditable;
  const [mode, setMode] = useState<Mode>(
    gridModeAvailable || !columnModeAvailable ? "grid" : "column",
  );
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [limitToFilter, setLimitToFilter] = useState(true);
  const findRef = useRef<HTMLInputElement>(null);
  const options = useMemo(() => ({ caseSensitive, regex }), [caseSensitive, regex]);

  const gridPlan = useMemo(
    () =>
      planGridReplace({
        rows,
        columns,
        pkIndices,
        colIdx,
        find,
        replace,
        options,
        isColEditable: () => columnEditable,
        validate: (c, v) => validateEdit?.(c, v) ?? null,
      }),
    [rows, columns, pkIndices, colIdx, find, replace, options, columnEditable, validateEdit],
  );

  const unsupported = columnReplaceUnsupported(driver, options);
  const textColumn = isTextColumnType(col?.type_name ?? "");
  const filterActive = !!serverFilter && limitToFilter;
  const columnSql = useMemo(() => {
    if (!columnModeAvailable || !col || !table || database === null) return null;
    return buildColumnReplaceSql({
      driver,
      database,
      table,
      column: col.name,
      find,
      replace,
      options,
      extraWhere: filterActive && serverFilter ? buildServerFilterClause(driver, serverFilter) : null,
    });
  }, [columnModeAvailable, col, table, database, driver, find, replace, options, filterActive, serverFilter]);

  const canApply =
    mode === "grid"
      ? gridModeAvailable && gridPlan.applied.length > 0
      : !!columnSql && columnSql.ok && textColumn;

  const submit = () => {
    if (!canApply) return;
    if (mode === "grid") {
      onApplyInGrid(gridPlan.applied);
    } else if (columnSql?.ok && onApplyColumn) {
      onApplyColumn(columnSql.sql);
    }
    onClose();
  };

  const skippedParts: string[] = [];
  if (gridPlan.skippedInvalid > 0) skippedParts.push(t("gridReplaceSkipInvalid", { count: gridPlan.skippedInvalid }));
  if (gridPlan.unchanged > 0) skippedParts.push(t("gridReplaceSkipUnchanged", { count: gridPlan.unchanged }));

  return (
    <Modal onSubmit={submit} submitDisabled={!canApply} width="600px" onClose={onClose} initialFocusEl={() => findRef.current}>
      <ModalHeader onClose={onClose} closeLabel={t("gridReplaceClose")}>
        {t("gridReplaceTitle", { column: col?.name ?? "" })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel htmlFor="grid-replace-find">{t("gridReplaceFind")}</FieldLabel>
          <Input
            id="grid-replace-find"
            ref={findRef}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            fontFamily="mono"
          />
        </FormSection>
        <FormSection>
          <FieldLabel htmlFor="grid-replace-with">{t("gridReplaceWith")}</FieldLabel>
          <Input
            id="grid-replace-with"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            fontFamily="mono"
          />
          {regex && <chakra.span fontSize="xs" color="app.textMuted">{t("gridReplaceRegexHint")}</chakra.span>}
        </FormSection>
        <chakra.div display="flex" gap="4" flexWrap="wrap">
          <chakra.label display="inline-flex" alignItems="center" gap="2" cursor="pointer" userSelect="none">
            <Checkbox checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            <span>{t("gridReplaceCaseSensitive")}</span>
          </chakra.label>
          <chakra.label display="inline-flex" alignItems="center" gap="2" cursor="pointer" userSelect="none">
            <Checkbox checked={regex} onChange={(e) => setRegex(e.target.checked)} />
            <span>{t("gridReplaceRegex")}</span>
          </chakra.label>
        </chakra.div>
        {gridPlan.invalidRegex && <FieldError>{t("gridReplaceInvalidRegex")}</FieldError>}

        <FormSection>
          <FieldLabel as="div">{t("gridReplaceScope")}</FieldLabel>
          <chakra.label display="inline-flex" alignItems="flex-start" gap="2" cursor={gridModeAvailable ? "pointer" : "default"} userSelect="none">
            <Radio
              name="grid-replace-scope"
              checked={mode === "grid"}
              onChange={() => setMode("grid")}
              disabled={!gridModeAvailable}
              mt="0.75"
            />
            <chakra.span display="flex" flexDirection="column">
              <chakra.span fontSize="md">{t("gridReplaceScopeGrid")}</chakra.span>
              <chakra.span fontSize="xs" color="app.textMuted">
                {t(
                  !columnEditable
                    ? "gridReplaceGridReadonly"
                    : pkIndices.length === 0
                      ? "gridReplaceGridNoPk"
                      : "gridReplaceScopeGridHint",
                  { rows: rows.length },
                )}
              </chakra.span>
            </chakra.span>
          </chakra.label>
          {onApplyColumn && (
            <chakra.label display="inline-flex" alignItems="flex-start" gap="2" cursor={columnModeAvailable ? "pointer" : "default"} userSelect="none">
              <Radio
                name="grid-replace-scope"
                checked={mode === "column"}
                onChange={() => setMode("column")}
                disabled={!columnModeAvailable}
                mt="0.75"
              />
              <chakra.span display="flex" flexDirection="column">
                <chakra.span fontSize="md">{t("gridReplaceScopeColumn")}</chakra.span>
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t(columnModeAvailable ? "gridReplaceScopeColumnHint" : "gridReplaceNoTable")}
                </chakra.span>
              </chakra.span>
            </chakra.label>
          )}
        </FormSection>

        {mode === "grid" && find !== "" && !gridPlan.invalidRegex && (
          <Callout tone={gridPlan.applied.length > 0 ? "info" : "warning"} role="status">
            {t("gridReplaceGridSummary", {
              hits: gridPlan.hitCount,
              cells: gridPlan.applied.length,
              rows: gridPlan.rowCount,
            })}
            {skippedParts.length > 0 && ` ${skippedParts.join(" / ")}`}
          </Callout>
        )}

        {mode === "column" && columnModeAvailable && (
          <>
            {serverFilter && (
              <chakra.label display="inline-flex" alignItems="center" gap="2" cursor="pointer" userSelect="none">
                <Checkbox checked={limitToFilter} onChange={(e) => setLimitToFilter(e.target.checked)} />
                <span>{t("gridReplaceLimitFilter", { column: serverFilter.column })}</span>
              </chakra.label>
            )}
            {!textColumn && <FieldError>{t("gridReplaceNotText", { type: col?.type_name ?? "" })}</FieldError>}
            {unsupported && (
              <FieldError>
                {t(unsupported === "sqliteRegex" ? "gridReplaceSqliteRegex" : "gridReplaceSqliteCase")}
              </FieldError>
            )}
            <FormSection>
              <FieldLabel as="div">{t("gridReplacePreview")}</FieldLabel>
              <CodePreview minH="60px" maxH="160px" wrap>
                {columnSql?.ok ? columnSql.sql : t("gridReplacePreviewEmpty")}
              </CodePreview>
            </FormSection>
            <Callout tone="warning" role="status">
              {t("gridReplaceColumnWarning")}
            </Callout>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("gridReplaceClose")}
        </Button>
        <Button type="button" variant="primary" disabled={!canApply} onClick={submit}>
          {mode === "grid" ? t("gridReplaceApplyGrid") : t("gridReplaceApplyColumn")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
