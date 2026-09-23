import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { CellValue, QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import {
  RELATED_ROWS_MAX,
  RELATED_ROWS_PAGE,
  buildRelatedOpenSql,
  buildRelatedRowsSql,
  formatRelatedCell,
  nextRelatedLimit,
  splitRelatedRows,
  type RelatedEntry,
} from "../relatedRows";
import { useSettings } from "../settings";
import { classifyTypeName } from "./cellTypeMeta";
import { MASK_PLACEHOLDER, resolveMaskedColumns } from "./columnMask";
import { TreeChevron } from "./tree";
import { Button } from "./ui";

/**
 * 行インスペクタの「関連」タブ (master-detail、#1028)。
 *
 * 選択中の親行を参照している子テーブル (被参照 FK) ごとにアコーディオンを並べ、
 * 開いたものだけ子行を取得して小さな表で表示する。FK ジャンプの「参照元を表示」
 * (#621) がグリッドを新クエリで置換するのに対し、こちらは現在の結果を離れずに
 * その場で 1 対多を覗く。
 *
 * - 取得は `runQuery` (App が `run_query` に結ぶ内部クエリ。クエリ履歴に残らず、
 *   バックエンドの読み取り専用ガードも通る) で、SQL は `relatedRows.ts` の純関数。
 * - 件数は `RELATED_ROWS_PAGE` 件ずつ「さらに読み込む」で増やし、`RELATED_ROWS_MAX`
 *   で頭打ち。全件は「グリッドで開く」(= 既存の FK ジャンプ) に委ねる。
 * - 子行の機微カラム (#1069) は設定のパターンで伏せ字にし、値を描画しない。
 *   親の結果に付けた列単位の上書きは結果シェイプ単位なので子行には持ち込まない。
 * - 開閉は `variants.collapse`。`height` / `opacity` は `MotionConfig reducedMotion`
 *   で止まらないため、`useReducedMotion()` で transition を即時化する (`LiveRows` と同じ)。
 * - 開閉状態はエントリキー単位で保持し、インスペクタの ↑/↓ で親行を移っても
 *   開いたまま新しい親の子行を取り直す (親行を順に眺める探索のため)。
 */

interface Props {
  entries: RelatedEntry[];
  driver: string;
  database: string | null;
  runQuery: (sql: string) => Promise<QueryResult>;
  /** 「グリッドで開く」(FK ジャンプと同じ画面置換)。未指定なら出さない。 */
  onOpenInGrid?: (sql: string) => void;
}

const MotionCollapse = chakra(motion.div, {}, {
  forwardProps: ["variants", "initial", "animate", "exit", "transition"],
});

const INSTANT = { duration: 0 } as const;

export function RelatedRowsPanel({ entries, driver, database, runQuery, onOpenInGrid }: Props) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const reduced = useReducedMotion() ?? false;
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Box display="flex" flexDirection="column" gap="1.5">
      <chakra.div fontSize="xs" color="app.textMuted">
        {t("relatedRowsHint")}
      </chakra.div>
      {entries.map((entry) => (
        <RelatedSection
          key={entry.key}
          entry={entry}
          open={open.has(entry.key)}
          onToggle={() => toggle(entry.key)}
          driver={driver}
          database={database}
          runQuery={runQuery}
          onOpenInGrid={onOpenInGrid}
          transition={reduced ? INSTANT : transitions.layout}
        />
      ))}
    </Box>
  );
}

function blockedText(entry: RelatedEntry, t: ReturnType<typeof useT>): string | null {
  switch (entry.blocked) {
    case "masked":
      return t("relatedRowsBlockedMasked");
    case "missingKey":
      return t("relatedRowsBlockedMissing", { column: entry.fk.referencedColumn });
    case "nullKey":
      return t("relatedRowsBlockedNull");
    default:
      return null;
  }
}

function RelatedSection({
  entry,
  open,
  onToggle,
  driver,
  database,
  runQuery,
  onOpenInGrid,
  transition,
}: {
  entry: RelatedEntry;
  open: boolean;
  onToggle: () => void;
  driver: string;
  database: string | null;
  runQuery: (sql: string) => Promise<QueryResult>;
  onOpenInGrid?: (sql: string) => void;
  transition: object;
}) {
  const t = useT();
  const bodyId = `${useId()}-related`;
  const blocked = blockedText(entry, t);
  const expandable = blocked === null;

  return (
    <Box border="1px solid" borderColor="app.border" borderRadius="md" overflow="hidden">
      <chakra.button
        type="button"
        display="flex"
        alignItems="center"
        gap="1.5"
        w="100%"
        px="2"
        py="1.5"
        border="none"
        bg="app.surfaceMuted"
        color="app.text"
        textAlign="left"
        cursor={expandable ? "pointer" : "default"}
        _hover={expandable ? { bg: "app.hover" } : undefined}
        disabled={!expandable}
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? bodyId : undefined}
      >
        <TreeChevron
          aria-hidden
          visibility={expandable ? "visible" : "hidden"}
          transform={expandable && open ? "rotate(90deg)" : undefined}
        >
          ▸
        </TreeChevron>
        <chakra.span
          flex="1"
          minW={0}
          fontFamily="mono"
          fontSize="sm"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {entry.fk.table}.{entry.fk.column}
        </chakra.span>
      </chakra.button>
      {blocked && (
        <chakra.div px="2" py="1" fontSize="xs" color="app.textMuted">
          {blocked}
        </chakra.div>
      )}
      <AnimatePresence initial={false}>
        {expandable && open && (
          <MotionCollapse
            id={bodyId}
            variants={variants.collapse}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={transition}
          >
            <RelatedRowsBody
              entry={entry}
              driver={driver}
              database={database}
              runQuery={runQuery}
              onOpenInGrid={onOpenInGrid}
            />
          </MotionCollapse>
        )}
      </AnimatePresence>
    </Box>
  );
}

type FetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: QueryResult };

function RelatedRowsBody({
  entry,
  driver,
  database,
  runQuery,
  onOpenInGrid,
}: {
  entry: RelatedEntry;
  driver: string;
  database: string | null;
  runQuery: (sql: string) => Promise<QueryResult>;
  onOpenInGrid?: (sql: string) => void;
}) {
  const t = useT();
  const { columnMaskEnabled, columnMaskPatterns } = useSettings();
  const [limit, setLimit] = useState(RELATED_ROWS_PAGE);
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const value: CellValue = entry.value;

  // 親行が変わったら件数上限を初期値へ戻し、前の親の子行を出したままにしない。
  // (「さらに読み込む」では既存の行を残したまま取り直す。)
  const [prevValue, setPrevValue] = useState<CellValue>(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setLimit(RELATED_ROWS_PAGE);
    setState({ kind: "loading" });
  }

  const params = { driver, database, childTable: entry.fk.table, childColumn: entry.fk.column, value };
  const sql = buildRelatedRowsSql({ ...params, limit });
  const openSql = buildRelatedOpenSql(params);

  // App から渡る runQuery は描画ごとに作り直されるため、依存に入れると無限に
  // 取り直す。最新の関数だけを ref で参照し、SQL が変わったときだけ取得する。
  const runRef = useRef(runQuery);
  useEffect(() => {
    runRef.current = runQuery;
  }, [runQuery]);

  useEffect(() => {
    if (!sql) return;
    let cancelled = false;
    runRef.current(sql).then(
      (result) => {
        if (!cancelled) setState({ kind: "done", result });
      },
      (e: unknown) => {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sql]);

  const result = state.kind === "done" ? state.result : null;
  const columns = useMemo(() => result?.columns ?? [], [result]);
  const kinds = useMemo(() => columns.map((c) => classifyTypeName(c.type_name)), [columns]);
  const masked = useMemo(
    () =>
      resolveMaskedColumns(
        columns.map((c) => c.name),
        { enabled: columnMaskEnabled, patterns: columnMaskPatterns },
      ),
    [columns, columnMaskEnabled, columnMaskPatterns],
  );
  const split = result ? splitRelatedRows(result.rows, limit) : null;
  const next = nextRelatedLimit(limit);

  return (
    <Box px="2" py="1.5" display="flex" flexDirection="column" gap="1.5">
      {state.kind === "loading" && (
        <chakra.div fontSize="xs" color="app.textMuted" aria-live="polite">
          {t("relatedRowsLoading")}
        </chakra.div>
      )}
      {state.kind === "error" && (
        <chakra.div fontSize="xs" color="app.textError" role="alert" wordBreak="break-word">
          {t("relatedRowsError", { error: state.message })}
        </chakra.div>
      )}
      {split && split.rows.length === 0 && (
        <chakra.div fontSize="xs" color="app.textMuted">
          {t("relatedRowsEmpty")}
        </chakra.div>
      )}
      {split && split.rows.length > 0 && (
        <Box overflow="auto" maxH="260px" css={{ scrollbarWidth: "thin" }}>
          <chakra.table
            fontSize="xs"
            fontFamily="mono"
            borderCollapse="collapse"
            aria-label={t("relatedRowsTableAria", { table: entry.fk.table })}
          >
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <chakra.th
                    key={`${c.name}-${i}`}
                    position="sticky"
                    top={0}
                    bg="app.surface"
                    color="app.textMuted"
                    fontWeight="600"
                    textAlign="left"
                    px="1.5"
                    py="0.75"
                    borderBottom="1px solid"
                    borderColor="app.border"
                    whiteSpace="nowrap"
                  >
                    {c.name}
                  </chakra.th>
                ))}
              </tr>
            </thead>
            <tbody>
              {split.rows.map((row, ri) => (
                <tr key={ri}>
                  {columns.map((_, ci) => {
                    const cell = formatRelatedCell(row[ci], kinds[ci], !!masked?.[ci]);
                    return (
                      <chakra.td
                        key={ci}
                        px="1.5"
                        py="0.75"
                        borderBottom="1px solid"
                        borderColor="app.borderSubtle"
                        whiteSpace="nowrap"
                        color={cell.tone === "value" ? "app.text" : "app.textMuted"}
                        fontStyle={cell.tone === "null" ? "italic" : undefined}
                        letterSpacing={cell.tone === "masked" ? "wider" : undefined}
                        aria-label={cell.tone === "masked" ? t("gridMaskedCellAria") : undefined}
                      >
                        {cell.tone === "masked"
                          ? MASK_PLACEHOLDER
                          : cell.tone === "null"
                            ? t("resultNull")
                            : cell.text}
                      </chakra.td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </chakra.table>
        </Box>
      )}
      {split && (
        <Box display="flex" alignItems="center" gap="1.5" flexWrap="wrap">
          <chakra.span flex="1" fontSize="xs" color="app.textMuted">
            {split.hasMore
              ? t("relatedRowsCountMore", { count: split.rows.length })
              : t("relatedRowsCount", { count: split.rows.length })}
          </chakra.span>
          {split.hasMore && next !== null && (
            <Button size="sm" variant="secondary" onClick={() => setLimit(next)}>
              {t("relatedRowsLoadMore")}
            </Button>
          )}
          {onOpenInGrid && openSql && (
            <Button size="sm" variant="ghost" onClick={() => onOpenInGrid(openSql)}>
              {t("relatedRowsOpen")}
            </Button>
          )}
        </Box>
      )}
      {split?.hasMore && next === null && (
        <chakra.div fontSize="xs" color="app.textMuted">
          {t("relatedRowsCapReached", { count: RELATED_ROWS_MAX })}
        </chakra.div>
      )}
    </Box>
  );
}
