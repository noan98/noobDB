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
import { ErrorNote } from "./modalForm";

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
      <chakra.div textStyle="caption">
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
        <chakra.div px="2" py="1" textStyle="caption">
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
  // prev: 「さらに読み込む」が失敗したとき、直前に表示していた結果 (行を消さない)
  | { kind: "error"; message: string; prev?: ShownResult }
  | { kind: "done"; result: QueryResult; limit: number };

/** 表示中の結果と、それを取得したときの上限 (取得中に新しい上限と混ぜない)。 */
type ShownResult = { result: QueryResult; limit: number };

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
  // 同じ上限での再試行用 (失敗後に同一上限を要求しても取り直せるようにする)。
  const [retryKey, setRetryKey] = useState(0);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey は同一 SQL の再取得トリガー
  useEffect(() => {
    if (!sql) return;
    let cancelled = false;
    const fetchLimit = limit;
    runRef.current(sql).then(
      (result) => {
        if (!cancelled) setState({ kind: "done", result, limit: fetchLimit });
      },
      (e: unknown) => {
        if (!cancelled) {
          setState((prev) => ({
            kind: "error",
            message: String(e),
            prev:
              prev.kind === "done"
                ? { result: prev.result, limit: prev.limit }
                : prev.kind === "error"
                  ? prev.prev
                  : undefined,
          }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sql, limit, retryKey]);

  // 取得中・失敗中も直前の結果を (取得時の上限で) 出し続ける。
  const shown: ShownResult | null =
    state.kind === "done" ? state : state.kind === "error" ? (state.prev ?? null) : null;
  const result = shown?.result ?? null;
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
  const split = shown ? splitRelatedRows(shown.result.rows, shown.limit) : null;
  // 失敗後は表示中の上限を基準にすると同じ上限を再要求できる (再試行)。
  const next = nextRelatedLimit(state.kind === "error" && shown ? shown.limit : limit);

  return (
    <Box px="2" py="1.5" display="flex" flexDirection="column" gap="1.5">
      {state.kind === "loading" && (
        <chakra.div textStyle="caption" aria-live="polite">
          {t("relatedRowsLoading")}
        </chakra.div>
      )}
      {state.kind === "error" && (
        <ErrorNote role="alert" wordBreak="break-word">
          {t("relatedRowsError", { error: state.message })}
        </ErrorNote>
      )}
      {split && split.rows.length === 0 && (
        <chakra.div textStyle="caption">
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
            <Button
              size="sm"
              variant="secondary"
              disabled={state.kind === "loading" || (state.kind === "done" && state.limit !== limit)}
              onClick={() => {
                setLimit(next);
                setRetryKey((k) => k + 1);
              }}
            >
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
        <chakra.div textStyle="caption">
          {t("relatedRowsCapReached", { count: RELATED_ROWS_MAX })}
        </chakra.div>
      )}
    </Box>
  );
}
