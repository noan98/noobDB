import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { resultViewKey } from "./resultViewKey";
import { useSettings } from "../settings";
import { resolveMaskedColumns, MASK_PLACEHOLDER } from "./columnMask";
import { EmptyState } from "./EmptyState";
import { NoResultsIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { classifyTypeName } from "./cellTypeMeta";
import { gridViewStateKeyFrom, readStoredGridView, resultShapeSizingKey } from "./gridViewState";
import {
  HIERARCHY_INDENT_MAX_LEVELS,
  HIERARCHY_RENDER_PAGE,
  HIERARCHY_SUBTREE_DEFAULT_DEPTH,
  HIERARCHY_SUBTREE_DEFAULT_LIMIT,
  HIERARCHY_SUBTREE_MAX_DEPTH,
  ancestorsOf,
  buildHierarchy,
  buildSubtreeSql,
  clampSubtreeDepth,
  defaultLabelColumn,
  detectSelfReference,
  expandableRows,
  flattenVisible,
  guessHierarchyColumns,
  readStoredHierarchyConfig,
  supportsRecursiveCte,
  writeStoredHierarchyConfig,
  type HierarchyConfig,
  type HierarchyGroup,
  type HierarchyVisibleRow,
} from "./hierarchyTree";
import { ListboxSelect } from "./ListboxSelect";
import { RowInspector } from "./RowInspector";
import { ResultViewSwitch, type ResultViewKind } from "./ResultViewSwitch";
import { parseServerVersion, serverVersionSql, type ServerVersion } from "./statsAdvisor";
import { Tooltip } from "./Tooltip";
import { TreeBadge, TreeChevron, TreeRow } from "./tree";
import { Button, Input } from "./ui";
import { useJsonTreeReveal } from "./useJsonTreeReveal";

interface Props {
  result: QueryResult;
  /** 結果の元の SQL。階層設定の永続化キー (`resultViewKey`) に使う。 */
  sourceSql?: string;
  driver: string;
  database?: string | null;
  /** 結果の元テーブル (テーブルタブ)。自己参照 FK の判定と部分木取得の対象になる。 */
  table?: string | null;
  /** 元テーブルの列メタデータ (論理リレーションをマージ済み)。 */
  columnMeta?: TableColumnInfo[] | null;
  onChangeView: (view: ResultViewKind) => void;
  /** 部分木取得 SQL を新しいタブで実行する。セッションが無ければ渡さない。 */
  onOpenQuery?: (sql: string) => void;
  /** サーバ版の確認 (MySQL 5.7 で部分木取得を無効にするため)。 */
  onRunLookup?: (sql: string) => Promise<QueryResult>;
}

/** 列の選択途中を持てる設定 (未選択の列は空文字)。 */
type Draft = HierarchyConfig;

type Entry =
  | { kind: "header"; group: HierarchyGroup; count: number }
  | ({ kind: "row" } & HierarchyVisibleRow);

const cellText = (v: unknown): string => (v === null || v === undefined ? "NULL" : String(v));

/**
 * 結果パネルの「階層」ビュー (#2410)。ID 列 / 親 ID 列から取得済みの行だけで木を組み立て、折りたたみツリーで見せる。
 * 組み立て・孤児・循環の判定は `hierarchyTree.ts` の純関数。行は展開した分だけを `HIERARCHY_RENDER_PAGE` 件ずつ描くので、
 * 数万行でも固まらない。読み取り専用で、部分木の取得は新しいタブの SELECT (`WITH RECURSIVE`) として実行する。
 */
export function HierarchyView({
  result,
  sourceSql,
  driver,
  database,
  table,
  columnMeta,
  onChangeView,
  onOpenQuery,
  onRunLookup,
}: Props) {
  const t = useT();
  const { columnMaskEnabled, columnMaskPatterns, autoLimitEnabled, autoLimitCount } = useSettings();
  const persistKey = resultViewKey("hierarchy", sourceSql);
  const cols = result.columns;

  const detected = useMemo(
    () => detectSelfReference(cols, columnMeta, table, database) ?? guessHierarchyColumns(cols, table),
    [cols, columnMeta, table, database],
  );
  const toDraft = (d: { idCol: string; parentCol: string } | null): Draft | null =>
    d ? { ...d, labelCol: defaultLabelColumn(cols, d.idCol) } : null;
  // 保存済みの設定があるか、利用者が列を選んだら、以後は自動判定の変化に追従しない。
  const userSet = useRef(false);
  const [config, setConfig] = useState<Draft | null>(() => {
    const stored = readStoredHierarchyConfig(persistKey, cols);
    if (stored) userSet.current = true;
    return stored ?? toDraft(detected);
  });
  // メタデータ (論理リレーション等) が後から届いたときに、未操作なら自動判定へ追従する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: detected の変化だけをトリガにする
  useEffect(() => {
    if (userSet.current) return;
    const next = toDraft(detected);
    setConfig((cur) =>
      cur?.idCol === next?.idCol && cur?.parentCol === next?.parentCol && cur?.labelCol === next?.labelCol
        ? cur
        : next,
    );
  }, [detected]);
  const updateConfig = (patch: Partial<Draft>) => {
    const base: Draft = config ?? { idCol: "", parentCol: "", labelCol: "" };
    const next = { ...base, ...patch };
    // 同じ列を ID と親 ID の両方には選べない。もう一方の欄と入れ替えて、無反応にしない。
    if (patch.idCol !== undefined && patch.idCol === base.parentCol) next.parentCol = base.idCol;
    if (patch.parentCol !== undefined && patch.parentCol === base.idCol) next.idCol = base.parentCol;
    if (patch.idCol !== undefined && !next.labelCol) next.labelCol = patch.idCol;
    userSet.current = true;
    setConfig(next);
    // 両方そろうまでは木を作らず、保存もしない。
    if (next.idCol && next.parentCol) writeStoredHierarchyConfig(persistKey, next);
    setExpanded(new Set());
    setSelected(null);
  };

  const idIdx = config ? cols.findIndex((c) => c.name === config.idCol) : -1;
  const parentIdx = config ? cols.findIndex((c) => c.name === config.parentCol) : -1;
  const labelIdx = config ? cols.findIndex((c) => c.name === config.labelCol) : -1;

  const model = useMemo(
    () => (idIdx >= 0 && parentIdx >= 0 ? buildHierarchy(result.rows, idIdx, parentIdx) : null),
    [result.rows, idIdx, parentIdx],
  );

  const maskedCols = useMemo(() => {
    const key = gridViewStateKeyFrom(resultShapeSizingKey(cols, database, table));
    const overrides = readStoredGridView(key).masks ?? {};
    return resolveMaskedColumns(
      cols.map((c) => c.name),
      { enabled: columnMaskEnabled, patterns: columnMaskPatterns, overrides },
    );
  }, [cols, database, table, columnMaskEnabled, columnMaskPatterns]);

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [renderLimit, setRenderLimit] = useState(HIERARCHY_RENDER_PAGE);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [depthText, setDepthText] = useState(String(HIERARCHY_SUBTREE_DEFAULT_DEPTH));
  const treeRef = useRef<HTMLDivElement | null>(null);
  const { mark } = useJsonTreeReveal(treeRef, [expanded]);

  // サーバ版。MySQL 5.7 は再帰 CTE が無いので部分木取得を無効にする。
  const [version, setVersion] = useState<ServerVersion | null>(null);
  // 呼び出し側は描画ごとに新しい関数を渡すので、ref 経由で呼び、版の確認は driver が決まったときの 1 回だけにする。
  const lookupRef = useRef(onRunLookup);
  lookupRef.current = onRunLookup;
  const hasLookup = !!onRunLookup;
  useEffect(() => {
    const sql = serverVersionSql(driver);
    const lookup = lookupRef.current;
    if (driver !== "mysql" || !sql || !hasLookup || !lookup) return;
    let alive = true;
    lookup(sql)
      .then((r) => {
        if (alive) setVersion(parseServerVersion(driver, String(r.rows[0]?.[0] ?? "")));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [driver, hasLookup]);

  const entries = useMemo(() => {
    if (!model) return { list: [] as Entry[], truncated: false };
    const groups: { group: HierarchyGroup; tops: number[] }[] = [
      { group: "root", tops: model.roots },
      { group: "orphan", tops: model.orphans },
      { group: "cycle", tops: model.cycles },
    ];
    const present = groups.filter((g) => g.tops.length > 0);
    const list: Entry[] = [];
    let truncated = false;
    for (const g of present) {
      const remaining = renderLimit - list.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (g.group !== "root" || present.length > 1) {
        list.push({
          kind: "header",
          group: g.group,
          count: model.groupRows[g.group],
        });
      }
      const flat = flattenVisible(model, g.tops, expanded, remaining);
      for (const r of flat.rows) list.push({ kind: "row", ...r });
      if (flat.truncated) truncated = true;
    }
    return { list, truncated };
  }, [model, expanded, renderLimit]);

  const visibleRows = useMemo(
    () => entries.list.filter((e): e is Extract<Entry, { kind: "row" }> => e.kind === "row"),
    [entries],
  );

  // 選択行が全折りたたみなどで隠れたら、先頭の行を Tab / 矢印キーの入口にする。
  const selectedVisible = selected !== null && visibleRows.some((r) => r.row === selected);

  const toggle = useCallback(
    (row: number) => {
      mark();
      setExpanded((cur) => {
        const next = new Set(cur);
        if (next.has(row)) next.delete(row);
        else next.add(row);
        return next;
      });
    },
    [mark],
  );

  const expandAll = () => {
    if (!model) return;
    mark();
    setExpanded(expandableRows(model));
  };
  const collapseAll = () => {
    mark();
    setExpanded(new Set());
  };

  const focusRow = (row: number) => {
    setSelected(row);
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-hrow="${row}"]`)?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!model || selected === null) return;
    const at = visibleRows.findIndex((r) => r.row === selected);
    const node = model.nodes[selected];
    if (at < 0 || !node) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (visibleRows[at + 1]) focusRow(visibleRows[at + 1].row);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (visibleRows[at - 1]) focusRow(visibleRows[at - 1].row);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (node.children.length > 0) {
        if (!expanded.has(selected)) toggle(selected);
        else focusRow(node.children[0]);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (expanded.has(selected)) toggle(selected);
      else if (node.parent !== null) focusRow(node.parent);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (node.children.length > 0) toggle(selected);
    }
  };

  const idMasked = idIdx >= 0 && !!maskedCols?.[idIdx];
  const subtreeBlockedReason: string | null = !table
    ? t("hierarchySubtreeNoTable")
    : !onOpenQuery
      ? t("hierarchySubtreeNoSession")
      : !supportsRecursiveCte(driver, version)
        ? t("hierarchySubtreeUnsupported")
        : idMasked
          ? t("hierarchySubtreeMasked")
          : selected === null
            ? t("hierarchySubtreeSelect")
            : result.rows[selected]?.[idIdx] === null || result.rows[selected]?.[idIdx] === undefined
              ? t("hierarchySubtreeNullId")
              : null;

  const fetchSubtree = () => {
    if (subtreeBlockedReason || !config || !table || !onOpenQuery || selected === null) return;
    const idCol: Column | undefined = cols[idIdx];
    const sql = buildSubtreeSql({
      driver,
      database,
      table,
      idCol: config.idCol,
      parentCol: config.parentCol,
      rootValue: result.rows[selected][idIdx],
      idType: idCol?.type_name,
      maxDepth: clampSubtreeDepth(Number(depthText)),
      tableColumns: [...cols.map((c) => c.name), ...(columnMeta ?? []).map((m) => m.name)],
      limit: autoLimitEnabled ? autoLimitCount : HIERARCHY_SUBTREE_DEFAULT_LIMIT,
    });
    onOpenQuery(sql);
  };

  const colOptions = cols.map((c) => ({ value: c.name, label: c.name }));

  const cellDisplay = (row: number, idx: number): string =>
    maskedCols?.[idx] ? MASK_PLACEHOLDER : cellText(result.rows[row]?.[idx]);

  const inspectorAt = selected === null ? -1 : visibleRows.findIndex((r) => r.row === selected);

  return (
    <Flex direction="column" h="100%" minH={0} minW={0}>
      <Flex
        align="center"
        gap="2.5"
        px="3"
        py="2"
        flex="none"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        flexWrap="wrap"
        fontSize="sm"
      >
        <ResultViewSwitch value="hierarchy" onChange={onChangeView} />
        <ColField label={t("hierarchyIdCol")}>
          <ListboxSelect
            value={config?.idCol ?? ""}
            ariaLabel={t("hierarchyIdCol")}
            placeholder={t("hierarchyPick")}
            options={colOptions}
            onChange={(v) => updateConfig({ idCol: v })}
          />
        </ColField>
        <ColField label={t("hierarchyParentCol")}>
          <ListboxSelect
            value={config?.parentCol ?? ""}
            ariaLabel={t("hierarchyParentCol")}
            placeholder={t("hierarchyPick")}
            options={colOptions}
            onChange={(v) => updateConfig({ parentCol: v })}
          />
        </ColField>
        <ColField label={t("hierarchyLabelCol")}>
          <ListboxSelect
            value={config?.labelCol ?? ""}
            ariaLabel={t("hierarchyLabelCol")}
            placeholder={t("hierarchyPick")}
            options={colOptions}
            onChange={(v) => updateConfig({ labelCol: v })}
          />
        </ColField>
        <chakra.span flex="1" />
        <Button type="button" variant="secondary" size="sm" onClick={expandAll} disabled={!model}>
          {t("hierarchyExpandAll")}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={collapseAll} disabled={!model}>
          {t("hierarchyCollapseAll")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={selected === null}
          onClick={() => setInspectorOpen((o) => !o)}
        >
          {t("hierarchyInspector")}
        </Button>
      </Flex>
      {model && (
        <Flex
          align="center"
          gap="3"
          px="3"
          py="1.5"
          flex="none"
          borderBottomWidth="1px"
          borderBottomColor="app.borderSubtle"
          textStyle="caption"
          flexWrap="wrap"
        >
          <chakra.span textStyle="numeric">
            {t("hierarchySummary", {
              rows: result.rows.length,
              roots: model.roots.length,
            })}
          </chakra.span>
          {model.orphans.length > 0 && (
            <chakra.span textStyle="numeric">
              {t("hierarchyOrphanCount", { n: model.orphans.length })}
            </chakra.span>
          )}
          {model.cycleRowCount > 0 && (
            <chakra.span color="app.textWarning" textStyle="numeric">
              {t("hierarchyCycleCount", { n: model.cycleRowCount })}
            </chakra.span>
          )}
          <chakra.span flex="1" />
          <chakra.span>{t("hierarchySubtreeDepth")}</chakra.span>
          <Input
            type="number"
            aria-label={t("hierarchySubtreeDepth")}
            min={1}
            max={HIERARCHY_SUBTREE_MAX_DEPTH}
            value={depthText}
            onChange={(e) => setDepthText(e.target.value)}
            w="16"
          />
          <Tooltip label={subtreeBlockedReason ?? t("hierarchySubtreeTitle")}>
            <span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={subtreeBlockedReason !== null}
                onClick={fetchSubtree}
              >
                <Icon name="query" size={ICON_SIZES.sm} />
                {t("hierarchySubtree")}
              </Button>
            </span>
          </Tooltip>
        </Flex>
      )}
      {!model || result.rows.length === 0 ? (
        <Flex flex="1" minH={0} align="center" justify="center">
          <EmptyState
            illustration={<NoResultsIllustration />}
            brandHalo
            icon="hierarchy"
            title={!model ? t("hierarchyPickTitle") : t("hierarchyEmpty")}
            description={!model ? t("hierarchyPickHint") : undefined}
          />
        </Flex>
      ) : (
        <Box
          ref={treeRef}
          role="tree"
          aria-label={t("hierarchyTreeAria")}
          flex="1"
          minH={0}
          overflow="auto"
          py="1"
          onKeyDown={onKeyDown}
        >
          {entries.list.map((e, i) =>
            e.kind === "header" ? (
              <Flex
                key={`h-${e.group}`}
                px="3"
                pt={i === 0 ? "1" : "3"}
                pb="1"
                gap="1.5"
                align="center"
                role="presentation"
                textStyle="overline"
                color={e.group === "cycle" ? "app.textWarning" : "app.textMuted"}
              >
                {e.group === "cycle" && <Icon name="warning" size={ICON_SIZES.sm} />}
                {e.group === "orphan"
                  ? t("hierarchyGroupOrphan", { n: e.count })
                  : e.group === "cycle"
                    ? t("hierarchyGroupCycle", { n: e.count })
                    : t("hierarchyGroupRoot", { n: e.count })}
              </Flex>
            ) : (
              <HierarchyRow
                key={e.row}
                row={e.row}
                depth={e.depth}
                label={cellDisplay(e.row, labelIdx >= 0 ? labelIdx : idIdx)}
                idText={cellDisplay(e.row, idIdx)}
                showId={labelIdx !== idIdx}
                childCount={model.nodes[e.row].children.length}
                descendants={model.nodes[e.row].descendants}
                inCycle={model.nodes[e.row].inCycle}
                open={expanded.has(e.row)}
                selected={selected === e.row}
                focusable={selected === e.row || (!selectedVisible && i === firstRowIndex(entries.list))}
                onSelect={() => setSelected(e.row)}
                onFocusRow={() => setSelected(e.row)}
                onToggle={() => toggle(e.row)}
              />
            ),
          )}
          {entries.truncated && (
            <Flex px="3" py="2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRenderLimit((n) => n + HIERARCHY_RENDER_PAGE)}
              >
                {t("hierarchyShowMore", { n: HIERARCHY_RENDER_PAGE })}
              </Button>
            </Flex>
          )}
        </Box>
      )}
      {inspectorOpen && selected !== null && result.rows[selected] && (
        <RowInspector
          columns={cols}
          values={result.rows[selected]}
          maskedColumns={maskedCols ? cols.map((_, i) => !!maskedCols[i]) : undefined}
          columnKinds={cols.map((c) => classifyTypeName(c.type_name))}
          rowNumber={selected + 1}
          title={table ?? undefined}
          onClose={() => setInspectorOpen(false)}
          hasPrev={inspectorAt > 0}
          hasNext={inspectorAt >= 0 && inspectorAt < visibleRows.length - 1}
          onPrev={() => inspectorAt > 0 && focusInspectorRow(visibleRows[inspectorAt - 1].row)}
          onNext={() =>
            inspectorAt >= 0 &&
            inspectorAt < visibleRows.length - 1 &&
            focusInspectorRow(visibleRows[inspectorAt + 1].row)
          }
        />
      )}
    </Flex>
  );

  function focusInspectorRow(row: number) {
    // 行インスペクタの前後移動は、木の表示順に沿って選択を動かす (祖先は開いておく)。
    if (model) {
      const need = ancestorsOf(model, row).filter((a) => !expanded.has(a));
      if (need.length > 0) setExpanded((cur) => new Set([...cur, ...need]));
    }
    setSelected(row);
  }
}

function firstRowIndex(list: readonly Entry[]): number {
  return list.findIndex((e) => e.kind === "row");
}

function ColField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="1.5">
      <chakra.span textStyle="caption">{label}</chakra.span>
      {children}
    </Flex>
  );
}

interface RowProps {
  row: number;
  depth: number;
  label: string;
  idText: string;
  showId: boolean;
  childCount: number;
  descendants: number;
  inCycle: boolean;
  open: boolean;
  selected: boolean;
  focusable: boolean;
  onSelect: () => void;
  onFocusRow: () => void;
  onToggle: () => void;
}

function HierarchyRow(p: RowProps) {
  const t = useT();
  const level = Math.min(p.depth, HIERARCHY_INDENT_MAX_LEVELS);
  const expandable = p.childCount > 0;
  return (
    <TreeRow
      role="treeitem"
      aria-level={p.depth + 1}
      aria-expanded={expandable ? p.open : undefined}
      aria-selected={p.selected}
      data-hrow={p.row}
      tabIndex={p.focusable ? 0 : -1}
      bg={p.selected ? "app.active" : undefined}
      style={{ paddingLeft: `calc(var(--space-1-5) + ${level} * var(--space-4))` }}
      onClick={p.onSelect}
      onFocus={p.onFocusRow}
      onDoubleClick={expandable ? p.onToggle : undefined}
    >
      {expandable ? (
        <TreeChevron
          transform={p.open ? "rotate(90deg)" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            p.onSelect();
            p.onToggle();
          }}
        />
      ) : (
        <chakra.span display="inline-block" w="4" flexShrink={0} />
      )}
      <chakra.span flex="0 1 auto" overflow="hidden" textOverflow="ellipsis" fontWeight={500}>
        {p.label}
      </chakra.span>
      {p.showId && (
        <chakra.span color="app.textSecondary" fontSize="xs" textStyle="numeric" flexShrink={0}>
          #{p.idText}
        </chakra.span>
      )}
      <chakra.span flex="1" />
      {p.inCycle && (
        <TreeBadge color="app.textWarning" display="inline-flex" alignItems="center" gap="1">
          <Icon name="warning" size={ICON_SIZES.sm} />
          {t("hierarchyCycleBadge")}
        </TreeBadge>
      )}
      {expandable && (
        <TreeBadge textTransform="none" letterSpacing="0" textStyle="numeric">
          {t("hierarchyChildren", { n: p.childCount })}
          {p.descendants > p.childCount ? ` / ${t("hierarchyDescendants", { n: p.descendants })}` : ""}
        </TreeBadge>
      )}
      <chakra.span color="app.textSecondary" fontSize="xs" textStyle="numeric" flexShrink={0}>
        {t("hierarchyDepth", { n: p.depth })}
      </chakra.span>
    </TreeRow>
  );
}
