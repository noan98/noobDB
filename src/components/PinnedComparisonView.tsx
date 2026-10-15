import { useEffect, useMemo, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";

import type { QueryResult, TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import {
  alignResultsByName,
  defaultKeyColumn,
  keyUniqueness,
  mapColumnsByName,
  resultsComparableByName,
  type PinnedResult,
} from "../pinnedCompare";
import { diffResultRows } from "../resultDiff";
import { Callout } from "./Callout";
import { semanticColorToken } from "../semanticColors";
import { Tooltip } from "./Tooltip";
import { Button, Heading, Select } from "./ui";
import { Switch } from "./Switch";
import { Splitter } from "./Splitter";
import { Icon, ICON_SIZES } from "./Icon";
import { ResultGrid } from "./ResultGrid";

/**
 * ピン留めした結果セットを 2 つ並べて比較するフルスクリーンビュー (#622)。
 * スキーマ比較 (`SchemaCompareView`) と同じ Splitter による左右分割の作法を踏襲。
 * 同一カラム構成の 2 結果は、選んだキー列で行差分をハイライトできる — 右グリッドに
 * 左の行スナップショットを `diffPrevRows` として渡し、`ResultGrid` 既存の差分描画
 * 経路 (#597) をそのまま再利用する (色・ペアリングを二重実装しない)。
 */

function toQueryResult(p: PinnedResult): QueryResult {
  return {
    columns: p.columns,
    rows: p.rows,
    rows_affected: p.rowsAffected,
    elapsed_ms: p.elapsedMs,
  };
}

/**
 * 右グリッドの差分用に、選んだキー列だけ PK (`key: "PRI"`) とした合成カラム
 * メタを作る。`ResultGrid` は `tableColumns` から PK 位置を解決して差分を取るため、
 * 自由クエリ結果でもキー列を指定すれば行ペアリングが効く。
 */
function syntheticKeyColumns(p: PinnedResult, keyColumns: string[]): TableColumnInfo[] {
  return p.columns.map((c) => ({
    name: c.name,
    data_type: c.type_name,
    nullable: true,
    key: keyColumns.includes(c.name) ? "PRI" : "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  }));
}

interface Props {
  pinned: PinnedResult[];
  driver: string;
  onUnpin: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export function PinnedComparisonView({ pinned, driver, onUnpin, onClear, onClose }: Props) {
  const t = useT();
  // 既定は新しい 2 件 (末尾が最新)。1 件しかなければ両側同じになる。
  const [leftId, setLeftId] = useState<string>(() => pinned[pinned.length - 2]?.id ?? pinned[0]?.id ?? "");
  const [rightId, setRightId] = useState<string>(() => pinned[pinned.length - 1]?.id ?? "");
  const [diffOn, setDiffOn] = useState(true);
  const [keyColumn, setKeyColumn] = useState<string | null>(null);
  // 複合キーの 2 列目 (任意, #1625)。
  const [keyColumn2, setKeyColumn2] = useState<string | null>(null);

  const left = useMemo(() => pinned.find((p) => p.id === leftId) ?? null, [pinned, leftId]);
  const right = useMemo(() => pinned.find((p) => p.id === rightId) ?? null, [pinned, rightId]);

  // ピン解除などで一覧が変わったとき、存在しない ID を選んだままにしない。
  // 失われた側は既定 (左=末尾から 2 番目、右=末尾) に戻す。
  useEffect(() => {
    const ids = new Set(pinned.map((p) => p.id));
    if (!ids.has(leftId)) setLeftId(pinned[pinned.length - 2]?.id ?? pinned[0]?.id ?? "");
    if (!ids.has(rightId)) setRightId(pinned[pinned.length - 1]?.id ?? "");
  }, [pinned, leftId, rightId]);

  // 列順や列の集合が違う結果も、列名で対応づけて共通の列だけ比べる (#1625)。
  // 完全一致のときは射影せず元のまま使う。
  const mapping = useMemo(() => (left && right ? mapColumnsByName(left, right) : null), [left, right]);
  const comparable = left && right ? resultsComparableByName(left, right) : false;
  const aligned = useMemo(
    () => (left && right && mapping && comparable ? alignResultsByName(left, right, mapping) : null),
    [left, right, mapping, comparable],
  );
  const viewLeft = aligned?.left ?? left;
  const viewRight = aligned?.right ?? right;

  // 選択中のキー列が比較する列に無くなったら未選択へ戻す (先頭列に既定化)。
  useEffect(() => {
    const names = new Set((viewLeft?.columns ?? []).map((c) => c.name));
    if (keyColumn && !names.has(keyColumn)) setKeyColumn(null);
    if (keyColumn2 && !names.has(keyColumn2)) setKeyColumn2(null);
  }, [viewLeft, keyColumn, keyColumn2]);

  // 既定のキー列は両結果で一意な最初の列 (無ければ先頭列)。比較不能なら差分は出さない。
  const effectiveKey = useMemo(
    () =>
      keyColumn ??
      (viewLeft && viewRight ? defaultKeyColumn(viewLeft, viewRight) : (viewLeft?.columns[0]?.name ?? null)),
    [keyColumn, viewLeft, viewRight],
  );
  // 1 列目と同じ列を 2 列目に選んでも無視する。
  const keyColumns = useMemo(
    () =>
      [effectiveKey, keyColumn2 && keyColumn2 !== effectiveKey ? keyColumn2 : null].filter(
        (k): k is string => !!k,
      ),
    [effectiveKey, keyColumn2],
  );

  const rightTableColumns = useMemo(
    () => (viewRight && comparable ? syntheticKeyColumns(viewRight, keyColumns) : undefined),
    [viewRight, comparable, keyColumns],
  );

  // 差分の件数サマリとキーの一意性 (#1625)。グリッドが描く差分と同じ突き合わせを使う。
  const analysis = useMemo(() => {
    if (!viewLeft || !viewRight || !comparable) return null;
    const idx = (cols: { name: string }[]) =>
      keyColumns.map((k) => cols.findIndex((c) => c.name === k)).filter((i) => i >= 0);
    const leftKey = idx(viewLeft.columns);
    const rightKey = idx(viewRight.columns);
    if (rightKey.length === 0 || rightKey.length !== keyColumns.length) return null;
    const diff = diffResultRows(viewLeft.rows, viewRight.rows, rightKey, viewRight.columns.length);
    let changedRows = 0;
    for (const flags of diff.changedCells) if (flags.some(Boolean)) changedRows++;
    return {
      changedRows,
      added: diff.addedRows.size,
      removed: diff.removedCount,
      hasChanges: diff.hasChanges,
      left: keyUniqueness(viewLeft.rows, leftKey),
      right: keyUniqueness(viewRight.rows, rightKey),
    };
  }, [viewLeft, viewRight, comparable, keyColumns]);

  if (pinned.length === 0) {
    return (
      <Box flex="1" display="flex" flexDirection="column" minHeight={0}>
        <Header t={t} onClose={onClose} onClear={onClear} clearDisabled />
        <Box py="6" px="6" color="app.textMuted" fontSize="sm">
          {t("pinCompareEmpty")}
        </Box>
      </Box>
    );
  }

  const picker = (value: string, onChange: (v: string) => void, label: string) => (
    <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} minWidth="200px">
        {pinned.map((p, i) => (
          <option key={p.id} value={p.id}>
            {`#${i + 1} · ${p.title} (${p.rows.length})`}
          </option>
        ))}
      </Select>
    </chakra.label>
  );

  const pane = (p: PinnedResult | null, tableColumns?: TableColumnInfo[], diffPrev?: PinnedResult | null) => (
    <Box flex="1" display="flex" flexDirection="column" minHeight={0} minWidth={0}>
      {p ? (
        <ResultGrid
          result={toQueryResult(p)}
          driver={driver}
          tableColumns={tableColumns}
          diffPrevRows={diffPrev ? diffPrev.rows : null}
          diffComparable={!!diffPrev && comparable}
          diffHighlightEnabled={!!diffPrev && comparable && diffOn}
        />
      ) : (
        <Box py="6" px="6" color="app.textMuted" fontSize="sm">
          {t("pinCompareSelect")}
        </Box>
      )}
    </Box>
  );

  return (
    <Box flex="1" display="flex" flexDirection="column" minHeight={0}>
      <Header t={t} onClose={onClose} onClear={onClear} />
      <Flex
        align="center"
        gap="3"
        flexWrap="wrap"
        py="2.5"
        px="6"
        borderBottom="1px solid"
        borderColor="app.border"
      >
        {picker(leftId, setLeftId, t("pinCompareLeft"))}
        {picker(rightId, setRightId, t("pinCompareRight"))}
        <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
          {t("pinCompareKeyColumn")}
          <Select
            value={effectiveKey ?? ""}
            onChange={(e) => setKeyColumn(e.target.value || null)}
            minWidth="160px"
            disabled={!comparable}
          >
            {(viewLeft?.columns ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </chakra.label>
        <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
          {t("pinCompareKeyColumn2")}
          <Select
            value={keyColumn2 ?? ""}
            onChange={(e) => setKeyColumn2(e.target.value || null)}
            minWidth="160px"
            disabled={!comparable}
          >
            <option value="">{t("pinCompareKeyColumn2None")}</option>
            {(viewLeft?.columns ?? [])
              .filter((c) => c.name !== effectiveKey)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </Select>
        </chakra.label>
        <Switch checked={diffOn} onChange={setDiffOn} disabled={!comparable} label={t("pinCompareDiff")} />
        {left && right && !comparable && (
          <chakra.span fontSize="sm" color={semanticColorToken("warning", "text")}>
            {t("pinCompareNotComparable")}
          </chakra.span>
        )}
        <chakra.span flex="1" />
        {right && (
          // ラベルはボタン内に可視テキストとして出ているため、native `title=` は
          // 同じ文字列の重複だった (#884)。
          <Button size="sm" variant="secondary" onClick={() => onUnpin(right.id)}>
            {t("pinCompareUnpin")}
          </Button>
        )}
      </Flex>
      {mapping && comparable && !mapping.exact && (
        <Box px="6" pt="2">
          <Callout tone="info" role="status">
            {t("pinCompareMappedByName", {
              shared: mapping.shared.length,
              excluded: [...mapping.leftOnly, ...mapping.rightOnly, ...mapping.ambiguous].join(", ") || "-",
            })}
          </Callout>
        </Box>
      )}
      {analysis && diffOn && (
        <Flex px="6" pt="2" gap="2" direction="column">
          <chakra.span fontSize="sm" color="app.text" role="status">
            {analysis.hasChanges
              ? t("pinCompareSummary", {
                  changed: analysis.changedRows,
                  added: analysis.added,
                  removed: analysis.removed,
                })
              : t("pinCompareSummaryNone")}
          </chakra.span>
          {(analysis.left.duplicateRows > 0 || analysis.right.duplicateRows > 0) && (
            <Callout tone="warning" role="alert">
              {t("pinCompareKeyDuplicate", {
                left: analysis.left.duplicateRows,
                right: analysis.right.duplicateRows,
              })}
            </Callout>
          )}
          {(analysis.left.nullKeyRows > 0 || analysis.right.nullKeyRows > 0) && (
            <Callout tone="warning" role="status">
              {t("pinCompareKeyNull", {
                left: analysis.left.nullKeyRows,
                right: analysis.right.nullKeyRows,
              })}
            </Callout>
          )}
        </Flex>
      )}
      {/* Splitter のルートは flex 子として高さを受け取るので、器も flex 列にする。
          ブロック要素のままだとグリッドが内容の高さまで伸び、縦スクロールが効かない。 */}
      <Box flex="1" minHeight={0} display="flex" flexDirection="column" overflow="hidden">
        <Splitter
          direction="row"
          storageKey="noobdb.split.pinCompare"
          first={pane(viewLeft)}
          second={pane(viewRight, rightTableColumns, viewLeft)}
        />
      </Box>
    </Box>
  );
}

function Header({
  t,
  onClose,
  onClear,
  clearDisabled,
}: {
  t: ReturnType<typeof useT>;
  onClose: () => void;
  onClear: () => void;
  clearDisabled?: boolean;
}) {
  return (
    <chakra.header
      display="flex"
      alignItems="center"
      gap="3"
      flexWrap="wrap"
      py="3.5"
      px="6"
      borderBottom="1px solid"
      borderColor="app.border"
    >
      <Heading>{t("pinCompareTitle")}</Heading>
      <chakra.span flex="1" />
      {/* 同上 — 可視テキストと同じ文字列の native `title=` は削除する (#884)。 */}
      <Button size="sm" variant="dangerOutline" onClick={onClear} disabled={clearDisabled}>
        {t("pinCompareClearAll")}
      </Button>
      <Tooltip label={t("pinCompareClose")}>
        <Button
          minWidth="28px"
          px="2"
          py="1"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("pinCompareClose")}
        >
          <Icon name="close" size={ICON_SIZES.sm} />
        </Button>
      </Tooltip>
    </chakra.header>
  );
}
