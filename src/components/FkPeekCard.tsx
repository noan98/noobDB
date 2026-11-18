import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { CellValue, QueryResult, TableColumnInfo } from "../api/tauri";
import {
  breadcrumbItems,
  buildFkPeekOpenSql,
  buildFkPeekSql,
  peekBack,
  peekCanBack,
  peekCanForward,
  peekCurrent,
  peekFollow,
  peekFollowTarget,
  peekForward,
  peekGoTo,
  peekSlideDirection,
  peekStart,
  peekMetaKey,
  planPeekColumns,
  splitPeekRows,
  type FkPeekCache,
  type PeekStep,
  type PeekTrail,
} from "../fkPeek";
import { useT } from "../i18n";
import { directionalSlide, transitions } from "../motion";
import { formatRelatedCell } from "../relatedRows";
import { useSettings } from "../settings";
import { classifyTypeName } from "./cellTypeMeta";
import { MASK_PLACEHOLDER, resolveMaskedColumns } from "./columnMask";
import { Icon, ICON_SIZES } from "./Icon";
import { Callout } from "./Callout";
import { ErrorNote } from "./modalForm";
import { Button } from "./ui";
import { computeTooltipPosition, type TooltipRect } from "./tooltipPosition";

/**
 * 結果グリッドの FK セルから参照先の 1 行を覗くポップオーバーカード (#2405)。
 *
 * 置き場はセルに付く一時的なポップオーバー (Modal / Bottom Panel / 全画面サーフェスではない)。
 * 取得は `runQuery` (App が `run_query` に結ぶ内部クエリ。履歴に残らず、読み取り専用ガードも通る) で、
 * SQL は `fkPeek.ts` の `LIMIT 1` 付き。カード内の FK 値からさらにたどれ、パンくず・戻る / 進むで往復できる
 * (向きは `directionalSlide`。reduced-motion は x 移動なしのフェード)。
 * 値は機微カラムのマスク設定 (#1069) に従って伏せ字にする。
 */

interface Props {
  anchor: TooltipRect;
  /** パンくずの起点 (グリッドのテーブル名)。不明なら null。 */
  origin: string | null;
  initial: PeekStep;
  driver: string;
  database: string | null;
  runQuery: (sql: string) => Promise<QueryResult>;
  /**
   * 参照先テーブルの列メタ (PK・FK の判定用)。カードの SELECT と同じデータベースで引く。
   * 無ければ列の選定は先頭から、さらにたどることはできない。
   */
  describeTable?: (database: string | null, table: string) => Promise<TableColumnInfo[]>;
  /** 取得結果のキャッシュ (グリッドが結果の世代ごとに持つ)。 */
  cache: FkPeekCache;
  /** ピン留め中 (Alt+クリックで開いた / カードを操作した)。ピン留め中だけ Esc と外側のクリックで閉じる。 */
  pinned: boolean;
  /** pointerdown の対象が元のセルか (元のセルのクリックでは閉じない)。 */
  isOriginTarget: (target: EventTarget | null) => boolean;
  onOpenInGrid?: (sql: string) => void;
  onOpenInInspector?: (row: {
    columns: QueryResult["columns"];
    values: CellValue[];
    masked: boolean[] | undefined;
  }) => void;
  /** ポインタがカードの中にあるか (ホバーで開いたカードの自動クローズ判定に使う)。 */
  onHoverChange: (inside: boolean) => void;
  /** カード内を操作した (クリック・フォーカス)。以後は自動で閉じない。 */
  onPin: () => void;
  /** 閉じる。`restoreFocus` が true なら元のセルへフォーカスを戻す (Esc・閉じるボタン)。 */
  onClose: (restoreFocus: boolean) => void;
}

const MotionBody = chakra(
  motion.div,
  {},
  { forwardProps: ["variants", "initial", "animate", "exit", "transition", "custom"] },
);

const MARGIN = 8;

type Fetched =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: QueryResult; meta: TableColumnInfo[] | null };

export function FkPeekCard({
  anchor,
  origin,
  initial,
  driver,
  database,
  runQuery,
  describeTable,
  cache,
  pinned,
  isOriginTarget,
  onOpenInGrid,
  onOpenInInspector,
  onHoverChange,
  onPin,
  onClose,
}: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const { columnMaskEnabled, columnMaskPatterns } = useSettings();
  const [trail, setTrail] = useState<PeekTrail>(() => peekStart(initial));
  const [dir, setDir] = useState<-1 | 0 | 1>(0);
  const step = peekCurrent(trail);
  const sql = buildFkPeekSql({ driver, database, step });

  // runQuery / describeTable は描画ごとに作り直されうるので ref で最新を参照する。
  const runRef = useRef(runQuery);
  const describeRef = useRef(describeTable);
  useEffect(() => {
    runRef.current = runQuery;
    describeRef.current = describeTable;
  }, [runQuery, describeTable]);
  const [fetched, setFetched] = useState<{ sql: string; state: Fetched }>({
    sql: "",
    state: { kind: "loading" },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: step の中身は sql に畳み込んである。cache はグリッドの世代ごとに固定
  useEffect(() => {
    const table = step.table;
    const metaKey = peekMetaKey(database, table);
    const hit = cache.results.get(sql);
    if (hit && cache.meta.has(metaKey)) {
      setFetched({ sql, state: { kind: "done", result: hit, meta: cache.meta.get(metaKey) ?? null } });
      return;
    }
    setFetched({ sql, state: { kind: "loading" } });
    let cancelled = false;
    void (async () => {
      let state: Fetched;
      try {
        const [result, meta] = await Promise.all([
          hit ?? runRef.current(sql),
          cache.meta.has(metaKey)
            ? Promise.resolve(cache.meta.get(metaKey) ?? null)
            : (describeRef.current?.(database, table) ?? Promise.resolve(null)).catch(() => null),
        ]);
        cache.results.set(sql, result);
        cache.meta.set(metaKey, meta);
        state = { kind: "done", result, meta };
      } catch (e) {
        state = { kind: "error", message: String(e) };
      }
      if (!cancelled) setFetched({ sql, state });
    })();
    return () => {
      cancelled = true;
    };
  }, [sql]);
  const state: Fetched = fetched.sql === sql ? fetched.state : { kind: "loading" };

  const go = (next: PeekTrail) => {
    if (next === trail) return;
    setDir(reduced ? 0 : peekSlideDirection(trail.index, next.index));
    setTrail(next);
    onPin();
  };

  // 位置決め。測定してから表示する (測定前は不可視)。
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 中身 (行・取得状態) が変わるたびに大きさを測り直す
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = computeTooltipPosition(
      anchor,
      { width: r.width, height: r.height },
      "bottom",
      MARGIN,
      { width: window.innerWidth, height: window.innerHeight },
      "start",
    );
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [anchor, state, trail.index]);

  // ピン留め中だけ、Esc で閉じる (グリッドの Esc 処理に渡さず、元のセルへフォーカスを戻す) と、
  // カードと元のセル以外での pointerdown で閉じる (フォーカスは奪わない)。
  // ホバーで開いただけのカードは Esc を横取りしない (SQL エディタの補完・モーダル・メニューの Esc を壊さない)。
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      if (isOriginTarget(target)) return;
      onClose(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [pinned, onClose, isOriginTarget]);

  // ピン留めで開いたら、カード先頭の操作できるボタンへフォーカスを移す (キーボードで辿れるように)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いた時点の 1 回だけ
  useEffect(() => {
    if (pinned) ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, []);

  const columns = state.kind === "done" ? state.result.columns : null;
  const { row, multiple } = splitPeekRows(state.kind === "done" ? state.result.rows : []);
  // 既知の制限: 判定は設定のマスクパターンだけで、グリッドの列単位の上書き (maskOverrides) や
  // 「一時的に表示 (reveal)」は参照先の行には及ばない (参照先は別テーブルの列名で判定するため)。
  const masked = useMemo(
    () =>
      columns
        ? resolveMaskedColumns(
            columns.map((c) => c.name),
            { enabled: columnMaskEnabled, patterns: columnMaskPatterns },
          )
        : null,
    [columns, columnMaskEnabled, columnMaskPatterns],
  );
  const plan = useMemo(
    () => (columns && state.kind === "done" ? planPeekColumns(columns, state.meta) : null),
    [columns, state],
  );

  const crumbs = breadcrumbItems(origin, trail);
  const openSql = buildFkPeekOpenSql({ driver, database, step });

  return createPortal(
    <Box
      ref={ref}
      role="dialog"
      aria-label={t("fkPeekTitle", { table: step.table })}
      data-testid="fk-peek-card"
      tabIndex={-1}
      position="fixed"
      zIndex="popover"
      w="22rem"
      maxW="calc(100vw - 1rem)"
      maxH="70vh"
      display="flex"
      flexDirection="column"
      bg="app.surface"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      boxShadow="md"
      color="app.text"
      fontSize="sm"
      overflow="hidden"
      style={{
        left: `${pos ? pos.left : anchor.left}px`,
        top: `${pos ? pos.top : anchor.bottom}px`,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onMouseDown={onPin}
      onFocus={onPin}
    >
      <Box
        display="flex"
        alignItems="center"
        gap="1"
        px="2"
        py="1"
        borderBottom="1px solid"
        borderColor="app.border"
      >
        <NavButton
          label={t("fkPeekBack")}
          icon="chevron-left"
          disabled={!peekCanBack(trail)}
          onClick={() => go(peekBack(trail))}
        />
        <NavButton
          label={t("fkPeekForward")}
          icon="chevron-right"
          disabled={!peekCanForward(trail)}
          onClick={() => go(peekForward(trail))}
        />
        <chakra.nav
          aria-label={t("fkPeekBreadcrumbAria")}
          flex="1"
          minW={0}
          display="flex"
          alignItems="center"
          gap="1"
          overflow="hidden"
          fontFamily="mono"
          fontSize="xs"
        >
          {crumbs.map((c, i) => (
            <chakra.span key={i} display="inline-flex" alignItems="center" gap="1" minW={0}>
              {i > 0 && <chakra.span color="app.textMuted">→</chakra.span>}
              {c.stepIndex === null ? (
                <chakra.span
                  color="app.textMuted"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                >
                  {c.label}
                </chakra.span>
              ) : (
                <chakra.button
                  type="button"
                  border="none"
                  bg="transparent"
                  p="0"
                  cursor={c.current ? "default" : "pointer"}
                  color={c.current ? "app.text" : c.ahead ? "app.textMuted" : "app.accent"}
                  fontWeight={c.current ? "semibold" : "normal"}
                  fontFamily="inherit"
                  fontSize="inherit"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                  aria-current={c.current ? "step" : undefined}
                  onClick={() => c.stepIndex !== null && go(peekGoTo(trail, c.stepIndex))}
                >
                  {c.label}
                </chakra.button>
              )}
            </chakra.span>
          ))}
        </chakra.nav>
        <NavButton label={t("fkPeekClose")} icon="close" disabled={false} onClick={() => onClose(true)} />
      </Box>

      <Box overflow="auto" css={{ scrollbarWidth: "thin" }} px="2" py="1.5">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <MotionBody
            key={`${trail.index}:${sql}`}
            custom={dir}
            variants={directionalSlide}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={transitions.crossfade}
          >
            {state.kind === "loading" && (
              <chakra.div textStyle="caption" aria-live="polite">
                {t("fkPeekLoading")}
              </chakra.div>
            )}
            {state.kind === "error" && (
              <ErrorNote role="alert" wordBreak="break-word">
                {t("fkPeekError", { error: state.message })}
              </ErrorNote>
            )}
            {state.kind === "done" && !row && (
              <chakra.div textStyle="caption">{t("fkPeekNotFound")}</chakra.div>
            )}
            {state.kind === "done" && row && columns && plan && (
              <>
                {multiple && (
                  <Callout tone="warning" mb="1.5" data-testid="fk-peek-multiple">
                    {t("fkPeekMultiple")}
                  </Callout>
                )}
                <chakra.div
                  fontFamily="mono"
                  fontWeight="semibold"
                  mb="1"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                >
                  {step.table}
                </chakra.div>
                <chakra.dl
                  m="0"
                  display="grid"
                  gridTemplateColumns="auto minmax(0, 1fr)"
                  columnGap="2"
                  rowGap="0.5"
                >
                  {plan.shown.map((ci) => {
                    const col = columns[ci];
                    const isMasked = masked?.[ci] ?? false;
                    const cell = formatRelatedCell(row[ci], classifyTypeName(col.type_name), isMasked);
                    const target = peekFollowTarget(state.meta, col.name);
                    const followable =
                      target !== null && cell.tone === "value" && row[ci] !== null && row[ci] !== undefined;
                    return (
                      <FieldRow key={col.name} label={col.name}>
                        {cell.tone === "masked" ? (
                          <chakra.span color="app.textMuted">{MASK_PLACEHOLDER}</chakra.span>
                        ) : cell.tone === "null" ? (
                          <chakra.span color="app.textMuted" fontStyle="italic">
                            {t("resultNull")}
                          </chakra.span>
                        ) : followable && target ? (
                          <chakra.button
                            type="button"
                            border="none"
                            bg="transparent"
                            p="0"
                            cursor="pointer"
                            color="app.accent"
                            fontFamily="inherit"
                            fontSize="inherit"
                            textAlign="left"
                            textDecoration="underline"
                            wordBreak="break-all"
                            aria-label={t("fkPeekFollow", { table: target.table, column: target.column })}
                            onClick={() =>
                              go(
                                peekFollow(trail, {
                                  table: target.table,
                                  column: target.column,
                                  value: row[ci] ?? null,
                                  valueType: col.type_name,
                                }),
                              )
                            }
                          >
                            {cell.text}
                          </chakra.button>
                        ) : (
                          <chakra.span wordBreak="break-all">{cell.text}</chakra.span>
                        )}
                      </FieldRow>
                    );
                  })}
                </chakra.dl>
                {plan.hidden > 0 && (
                  <chakra.div textStyle="caption" mt="1">
                    {t("fkPeekMore", { count: plan.hidden })}
                  </chakra.div>
                )}
              </>
            )}
          </MotionBody>
        </AnimatePresence>
      </Box>

      <Box display="flex" gap="1.5" px="2" py="1.5" borderTop="1px solid" borderColor="app.border">
        {onOpenInGrid && (
          <Button size="sm" variant="ghost" onClick={() => onOpenInGrid(openSql)}>
            {t("fkPeekOpenInGrid")}
          </Button>
        )}
        {onOpenInInspector && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!row || !columns}
            onClick={() => {
              if (row && columns) {
                onOpenInInspector({
                  columns,
                  values: row,
                  masked: masked ?? undefined,
                });
              }
            }}
          >
            {t("fkPeekOpenInInspector")}
          </Button>
        )}
      </Box>
    </Box>,
    document.body,
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <chakra.dt textStyle="caption" fontFamily="mono" lineHeight="1.6">
        {label}
      </chakra.dt>
      <chakra.dd m="0" fontFamily="mono" fontSize="xs" lineHeight="1.6" minW={0}>
        {children}
      </chakra.dd>
    </>
  );
}

function NavButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: "chevron-left" | "chevron-right" | "close";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <chakra.button
      type="button"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      boxSize="6"
      border="none"
      bg="transparent"
      color="app.textMuted"
      borderRadius="sm"
      cursor="pointer"
      _hover={{ bg: "app.hover", color: "app.text" }}
      _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <Icon name={icon} size={ICON_SIZES.md} />
    </chakra.button>
  );
}
