import { useMemo, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import type { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import { Button, Checkbox, Input } from "./ui";
import { ActionMark, statusLabel } from "./SchemaDiffDetail";
import {
  buildCompareMatrix,
  filterMatrixRows,
  type MatrixCell,
  type MatrixColumnInput,
} from "./schemaCompareMatrixModel";

/** 一度に描く行数 (テーブルが数千あっても表を重くしない)。 */
const MATRIX_PAGE = 200;

export interface MatrixColumn extends MatrixColumnInput {
  /** 列見出し (「接続名 / DB 名」)。 */
  label: string;
}

const wrapCss: SystemStyleObject = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  background: "var(--bg-elevated)",
  overflow: "auto",
  maxHeight: "45vh",
};
const tableCss: SystemStyleObject = {
  borderCollapse: "separate",
  borderSpacing: 0,
  width: "100%",
  fontSize: "var(--text-sm)",
  "& th, & td": {
    borderBottom: "1px solid var(--border)",
    padding: "var(--space-1) var(--space-2-5)",
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  "& th:first-of-type, & td:first-of-type": { textAlign: "left" },
  "& thead th": {
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: "var(--bg-elevated)",
    verticalAlign: "bottom",
  },
};
const cellButtonCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "2em",
  padding: "var(--space-0-5)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid transparent",
  background: "transparent",
  cursor: "pointer",
  _hover: { background: "var(--bg-hover)" },
  _focusVisible: { outline: "none", boxShadow: "var(--focus-ring)" },
};

function cellLabel(cell: MatrixCell, t: ReturnType<typeof useT>): string {
  if (cell === "absent") return t("schemaCompareMatrixAbsent");
  if (cell === "error") return t("schemaCompareMatrixError");
  return statusLabel(cell, t);
}

/**
 * 基準 1 つ vs 比較先 複数の結果を「テーブル × 比較先」の表で一覧する。マスか列見出しを
 * 押すと、その比較先が下の詳細 (2 ペイン) と反映 SQL の対象になる。
 */
export function SchemaCompareMatrix({
  columns,
  active,
  onSelect,
  t,
}: {
  columns: MatrixColumn[];
  /** 下の詳細に出している比較先の列番号。 */
  active: number;
  /** 列 (と、マスを押したときはそのテーブル) を選ぶ。 */
  onSelect: (column: number, table: string | null) => void;
  t: ReturnType<typeof useT>;
}) {
  const [onlyDiffering, setOnlyDiffering] = useState(true);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(MATRIX_PAGE);
  const matrix = useMemo(() => buildCompareMatrix(columns), [columns]);
  const rows = useMemo(
    () => filterMatrixRows(matrix.rows, onlyDiffering, query),
    [matrix.rows, onlyDiffering, query],
  );
  const shown = rows.slice(0, limit);

  return (
    <Box data-testid="schema-compare-matrix" mt="4">
      <chakra.h3 margin={0} fontSize="md">
        {t("schemaCompareMatrixTitle", { count: columns.length })}
      </chakra.h3>
      <chakra.p margin="var(--space-1) 0 var(--space-2-5)" textStyle="caption">
        {t("schemaCompareMatrixDesc")}
      </chakra.p>
      <Flex align="center" gap="3" flexWrap="wrap" mb="2.5">
        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" cursor="pointer">
          <Checkbox
            checked={onlyDiffering}
            onChange={(e) => {
              setOnlyDiffering(e.target.checked);
              setLimit(MATRIX_PAGE);
            }}
          />
          {t("schemaCompareMatrixOnlyDiffering")}
        </chakra.label>
        <Input
          type="search"
          flex="0 1 220px"
          minW="120px"
          value={query}
          placeholder={t("schemaCompareSearchTables")}
          aria-label={t("schemaCompareSearchTables")}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(MATRIX_PAGE);
          }}
        />
      </Flex>
      <Box css={wrapCss}>
        <chakra.table css={tableCss}>
          <thead>
            <tr>
              <th scope="col">{t("schemaCompareColName")}</th>
              {columns.map((col, i) => {
                const count = matrix.differingTables[i];
                const isActive = i === active;
                return (
                  <th key={`${i}:${col.label}`} scope="col">
                    <chakra.button
                      type="button"
                      onClick={() => onSelect(i, null)}
                      disabled={col.diff === null}
                      aria-pressed={isActive}
                      display="inline-flex"
                      flexDirection="column"
                      alignItems="center"
                      gap="0.5"
                      px="2"
                      py="1"
                      borderRadius="md"
                      border="1px solid"
                      borderColor={isActive ? semanticColorVar("warning", "text") : "app.border"}
                      bg={isActive ? "app.hover" : "transparent"}
                      color="app.text"
                      cursor={col.diff === null ? "default" : "pointer"}
                      _hover={{ bg: "app.hover" }}
                      _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
                    >
                      <chakra.span fontWeight={600} maxW="220px" overflow="hidden" textOverflow="ellipsis">
                        {col.label}
                      </chakra.span>
                      {col.diff === null ? (
                        <chakra.span fontSize="xs" color="app.textError">
                          {t("schemaCompareMatrixError")}
                        </chakra.span>
                      ) : (
                        <chakra.span textStyle="caption">
                          {count === 0
                            ? t("schemaCompareMatrixNoDiff")
                            : t("schemaCompareMatrixDiffCount", { count: count ?? 0 })}
                        </chakra.span>
                      )}
                      {isActive && (
                        <chakra.span fontSize="2xs" css={{ color: semanticColorVar("warning", "text") }}>
                          {t("schemaCompareMatrixActive")}
                        </chakra.span>
                      )}
                    </chakra.button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.name}>
                <th scope="row">
                  <chakra.span fontFamily="var(--font-mono)" fontWeight={400}>
                    {row.name}
                  </chakra.span>
                </th>
                {row.cells.map((cell, i) => (
                  <td key={i} style={i === active ? { background: "var(--bg-hover)" } : undefined}>
                    {cell === "error" ? (
                      <chakra.span color="app.textMuted" aria-label={cellLabel(cell, t)}>
                        ?
                      </chakra.span>
                    ) : cell === "absent" ? (
                      <chakra.span color="app.textMuted" aria-label={cellLabel(cell, t)}>
                        —
                      </chakra.span>
                    ) : (
                      <chakra.button
                        type="button"
                        css={cellButtonCss}
                        aria-label={`${row.name} / ${columns[i]?.label ?? ""}: ${cellLabel(cell, t)}`}
                        onClick={() => onSelect(i, row.name)}
                      >
                        <ActionMark status={cell} />
                      </chakra.button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </chakra.table>
        {rows.length === 0 && matrix.differingTables.some((n) => n !== null) && (
          <chakra.p margin={0} p="3" textStyle="caption">
            {!onlyDiffering || query.trim() !== ""
              ? t("schemaCompareNoMatch")
              : matrix.differingTables.every((n) => n !== null)
                ? t("schemaCompareMatrixAllSame")
                : t("schemaCompareMatrixComparedSame")}
          </chakra.p>
        )}
        {rows.length > limit && (
          <Flex direction="column" gap="1.5" p="2.5" align="flex-start">
            <chakra.span textStyle="caption">
              {t("schemaCompareTablesShown", { shown: limit, total: rows.length })}
            </chakra.span>
            <Button type="button" onClick={() => setLimit((n) => n + MATRIX_PAGE)}>
              {t("schemaCompareStatementsMore", { count: Math.min(MATRIX_PAGE, rows.length - limit) })}
            </Button>
          </Flex>
        )}
      </Box>
    </Box>
  );
}
