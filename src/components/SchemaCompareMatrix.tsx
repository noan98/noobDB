import { useId, useMemo, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";

import type { useT } from "../i18n";
import { transitions } from "../motion";
import { prefersStaticMotion } from "./revealOrigin";
import { semanticColorVar } from "../semanticColors";
import type { DiffStatus } from "../api/tauri";
import { Button, Checkbox, Input } from "./ui";
import { statusColors } from "./diffStatusColors";
import { ActionMark, statusLabel } from "./SchemaDiffDetail";
import {
  buildCompareMatrix,
  type ColumnBreakdown,
  columnBreakdown,
  filterMatrixRows,
  type MatrixCell,
  type MatrixColumnInput,
  type MatrixRow,
  sortMatrixRows,
} from "./schemaCompareMatrixModel";

/** 一度に描く行数 (テーブルが数千あっても表を重くしない)。 */
const MATRIX_PAGE = 200;

export interface MatrixColumn extends MatrixColumnInput {
  /** 列見出し (「接続名 / DB 名」)。 */
  label: string;
}

// motion 用 props の `transition` は Chakra のスタイルプロップ名と衝突するため明示的に転送する。
const MotionActiveCol = chakra(motion.span, {}, { forwardProps: ["transition"] });

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
  // 見出し行は上、1 列目 (テーブル名) は左に固定する。交点は両方の上に載せる。
  "& thead th": {
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: "var(--bg-elevated)",
    verticalAlign: "bottom",
  },
  "& tbody th:first-of-type": {
    position: "sticky",
    left: 0,
    zIndex: 1,
    background: "var(--bg-elevated)",
    fontWeight: 400,
  },
  "& thead th:first-of-type": { left: 0, zIndex: 2 },
};
const STRIP_ORDER = ["source_only", "different", "target_only"] as const;
const stripCss: SystemStyleObject = {
  display: "flex",
  width: "100%",
  minWidth: "var(--space-12)",
  height: "var(--space-1-5)",
  borderRadius: "var(--radius-pill)",
  background: "var(--bg-muted)",
  overflow: "hidden",
};
const chipCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-0-5)",
  padding: "0 var(--space-1)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid transparent",
  background: "transparent",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  _hover: { background: "var(--bg-hover)" },
  _focusVisible: { outline: "none", boxShadow: "var(--focus-ring)" },
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
 * 列見出しの内訳ストリップ。追加 / 削除 / 変更のテーブル数の比を細い積み上げ帯で示し、
 * 帯かその下の件数を押すと、その比較先をその状態だけで絞り込む (`DiffFilterChip` と同じ語彙)。
 * 帯の幅は `transitions.progress` で補間する (reduced-motion は即時)。帯は視覚補助で、
 * キーボード・支援技術は件数のボタンを使う。
 */
function BreakdownStrip({
  breakdown,
  target,
  onPick,
  t,
}: {
  breakdown: ColumnBreakdown;
  target: string;
  onPick: (status: DiffStatus) => void;
  t: ReturnType<typeof useT>;
}) {
  const reduced = useReducedMotion() ?? false;
  const total = breakdown.source_only + breakdown.different + breakdown.target_only;
  return (
    <chakra.span display="flex" flexDirection="column" alignItems="stretch" gap="0.5" w="100%">
      <chakra.span css={stripCss} aria-hidden>
        {STRIP_ORDER.map((status) => (
          <motion.span
            key={status}
            data-testid={`matrix-strip-${status}`}
            onClick={() => onPick(status)}
            style={{ height: "100%", background: statusColors(status).color, cursor: "pointer" }}
            initial={false}
            animate={{ width: total === 0 ? "0%" : `${(breakdown[status] / total) * 100}%` }}
            transition={reduced ? { duration: 0 } : transitions.progress}
          />
        ))}
      </chakra.span>
      <chakra.span display="flex" justifyContent="center" gap="1">
        {STRIP_ORDER.map((status) => (
          <chakra.button
            key={status}
            type="button"
            css={{ ...chipCss, ...(breakdown[status] === 0 ? { opacity: 0.5 } : null) }}
            aria-label={t("schemaCompareMatrixStripLabel", {
              target,
              status: statusLabel(status, t),
              count: breakdown[status],
            })}
            onClick={() => onPick(status)}
          >
            <ActionMark status={status} />
            <chakra.span textStyle="numeric">{breakdown[status]}</chakra.span>
          </chakra.button>
        ))}
      </chakra.span>
    </chakra.span>
  );
}

/** 行見出しの右のドリフト度 (「2/4」と、ずれの割合を示す小メーター)。 */
function DriftMeter({ row, t }: { row: MatrixRow; t: ReturnType<typeof useT> }) {
  const ratio = row.compared === 0 ? 0 : row.drift / row.compared;
  return (
    <chakra.span
      data-testid="matrix-drift"
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      ml="2.5"
      role="img"
      aria-label={t("schemaCompareMatrixDrift", { drift: row.drift, total: row.compared })}
      title={t("schemaCompareMatrixDrift", { drift: row.drift, total: row.compared })}
    >
      <chakra.span
        aria-hidden
        w="var(--space-8)"
        h="var(--space-1)"
        borderRadius="pill"
        bg="app.surfaceMuted"
        overflow="hidden"
        display="inline-block"
      >
        <chakra.span
          display="block"
          h="100%"
          style={{
            width: `${ratio * 100}%`,
            background: row.drift === 0 ? "transparent" : semanticColorVar("warning", "solid"),
          }}
        />
      </chakra.span>
      <chakra.span fontSize="xs" textStyle="numeric" color={row.drift === 0 ? "app.textMuted" : "app.text"}>
        {row.drift}/{row.compared}
      </chakra.span>
    </chakra.span>
  );
}

/**
 * 基準 1 つ vs 比較先 複数の結果を「テーブル × 比較先」の表で一覧する。マスか列見出しを
 * 押すと、その比較先が下の詳細 (2 ペイン) と反映 SQL の対象になる。
 */
export function SchemaCompareMatrix({
  columns,
  active,
  onSelect,
  onFilterStatus,
  t,
}: {
  columns: MatrixColumn[];
  /** 下の詳細に出している比較先の列番号。 */
  active: number;
  /** 列 (と、マスを押したときはそのテーブル) を選ぶ。 */
  onSelect: (column: number, table: string | null) => void;
  /** 列の内訳ストリップ (か件数) を押したとき。その比較先を、その状態だけで絞り込む。 */
  onFilterStatus: (column: number, status: DiffStatus) => void;
  t: ReturnType<typeof useT>;
}) {
  const [onlyDiffering, setOnlyDiffering] = useState(true);
  const [query, setQuery] = useState("");
  const [driftFirst, setDriftFirst] = useState(false);
  const [limit, setLimit] = useState(MATRIX_PAGE);
  // アクティブ列の滑るハイライト。画面に複数あっても衝突しないよう名前空間を分ける。
  const activeColId = `schema-compare-active-col-${useId()}`;
  // reduced-motion (アプリ設定 / OS) は MotionConfig が layout を即時化する。ハイコントラストは明示的に 0 秒。
  const activeColTransition = prefersStaticMotion() ? { duration: 0 } : transitions.emphasized;
  const matrix = useMemo(() => buildCompareMatrix(columns), [columns]);
  const breakdowns = useMemo(() => columns.map((c) => columnBreakdown(c.diff)), [columns]);
  const rows = useMemo(
    () => sortMatrixRows(filterMatrixRows(matrix.rows, onlyDiffering, query), driftFirst ? "drift" : "name"),
    [matrix.rows, onlyDiffering, query, driftFirst],
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
        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" cursor="pointer">
          <Checkbox
            checked={driftFirst}
            onChange={(e) => {
              setDriftFirst(e.target.checked);
              setLimit(MATRIX_PAGE);
            }}
          />
          {t("schemaCompareMatrixSortDrift")}
        </chakra.label>
        <Input
          type="search"
          flex="0 1 var(--matrix-search-w)"
          minW="var(--matrix-search-min)"
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
                      borderColor="app.border"
                      position="relative"
                      bg="transparent"
                      color="app.text"
                      cursor={col.diff === null ? "default" : "pointer"}
                      _hover={{ bg: "app.hover" }}
                      _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
                    >
                      {isActive && (
                        // 同じ layoutId の要素が列間を移ると、Motion が前の列から滑らせる。
                        <MotionActiveCol
                          layoutId={activeColId}
                          transition={activeColTransition}
                          data-testid="matrix-active-col"
                          position="absolute"
                          inset="0"
                          borderRadius="inherit"
                          border="1px solid"
                          bg="app.hover"
                          pointerEvents="none"
                          aria-hidden
                          css={{ borderColor: semanticColorVar("warning", "text") }}
                        />
                      )}
                      <chakra.span
                        position="relative"
                        fontWeight={600}
                        maxW="var(--matrix-label-max)"
                        overflow="hidden"
                        textOverflow="ellipsis"
                      >
                        {col.label}
                      </chakra.span>
                      {col.diff === null ? (
                        <chakra.span position="relative" fontSize="xs" color="app.textError">
                          {t("schemaCompareMatrixError")}
                        </chakra.span>
                      ) : (
                        <chakra.span position="relative" textStyle="caption">
                          {count === 0
                            ? t("schemaCompareMatrixNoDiff")
                            : t("schemaCompareMatrixDiffCount", { count: count ?? 0 })}
                        </chakra.span>
                      )}
                      {isActive && (
                        <chakra.span
                          position="relative"
                          fontSize="2xs"
                          css={{ color: semanticColorVar("warning", "text") }}
                        >
                          {t("schemaCompareMatrixActive")}
                        </chakra.span>
                      )}
                    </chakra.button>
                    {breakdowns[i] && (
                      <chakra.div mt="1">
                        <BreakdownStrip
                          breakdown={breakdowns[i]}
                          target={col.label}
                          onPick={(status) => onFilterStatus(i, status)}
                          t={t}
                        />
                      </chakra.div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.name}>
                <th scope="row">
                  <Flex align="center" justify="space-between" gap="2">
                    <chakra.span fontFamily="var(--font-mono)" fontWeight={400}>
                      {row.name}
                    </chakra.span>
                    <DriftMeter row={row} t={t} />
                  </Flex>
                </th>
                {row.cells.map((cell, i) => (
                  <td key={i} className="compare-matrix-cell" data-status={cell} data-active={i === active}>
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
