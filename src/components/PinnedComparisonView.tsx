import { useEffect, useMemo, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";

import type { QueryResult, TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { resultsComparable, type PinnedResult } from "../pinnedCompare";
import { Button, Select } from "./ui";
import { Switch } from "./Switch";
import { Splitter } from "./Splitter";
import { Icon } from "./Icon";
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
function syntheticKeyColumns(p: PinnedResult, keyColumn: string | null): TableColumnInfo[] {
  return p.columns.map((c) => ({
    name: c.name,
    data_type: c.type_name,
    nullable: true,
    key: c.name === keyColumn ? "PRI" : "",
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

  const left = useMemo(() => pinned.find((p) => p.id === leftId) ?? null, [pinned, leftId]);
  const right = useMemo(() => pinned.find((p) => p.id === rightId) ?? null, [pinned, rightId]);

  // ピン解除などで一覧が変わったとき、存在しない ID を選んだままにしない。
  // 失われた側は既定 (左=末尾から 2 番目、右=末尾) に戻す。
  useEffect(() => {
    const ids = new Set(pinned.map((p) => p.id));
    if (!ids.has(leftId)) setLeftId(pinned[pinned.length - 2]?.id ?? pinned[0]?.id ?? "");
    if (!ids.has(rightId)) setRightId(pinned[pinned.length - 1]?.id ?? "");
  }, [pinned, leftId, rightId]);

  // 選択中のキー列が左結果のカラムに無くなったら未選択へ戻す (先頭列に既定化)。
  useEffect(() => {
    if (keyColumn && !(left?.columns.some((c) => c.name === keyColumn) ?? false)) {
      setKeyColumn(null);
    }
  }, [left, keyColumn]);

  const comparable = left && right ? resultsComparable(left, right) : false;
  // 既定のキー列は左の先頭列。比較不能なら差分は出さない。
  const effectiveKey = keyColumn ?? left?.columns[0]?.name ?? null;

  const rightTableColumns = useMemo(
    () => (right && comparable ? syntheticKeyColumns(right, effectiveKey) : undefined),
    [right, comparable, effectiveKey],
  );

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

  const picker = (
    value: string,
    onChange: (v: string) => void,
    label: string,
  ) => (
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
      <Flex align="center" gap="3" flexWrap="wrap" py="2.5" px="6" borderBottom="1px solid" borderColor="app.border">
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
            {(left?.columns ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </chakra.label>
        <Switch
          checked={diffOn}
          onChange={setDiffOn}
          disabled={!comparable}
          label={t("pinCompareDiff")}
        />
        {left && right && !comparable && (
          <chakra.span fontSize="sm" color="var(--status-warning)">
            {t("pinCompareNotComparable")}
          </chakra.span>
        )}
        <chakra.span flex="1" />
        {right && (
          <Button size="sm" variant="secondary" onClick={() => onUnpin(right.id)} title={t("pinCompareUnpin")}>
            {t("pinCompareUnpin")}
          </Button>
        )}
      </Flex>
      <Box flex="1" minHeight={0}>
        <Splitter
          direction="row"
          storageKey="noobdb.split.pinCompare"
          first={pane(left)}
          second={pane(right, rightTableColumns, left)}
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
      <chakra.h2 margin={0} fontSize="lg" fontWeight={600} color="app.text">
        {t("pinCompareTitle")}
      </chakra.h2>
      <chakra.span flex="1" />
      <Button size="sm" variant="secondary" onClick={onClear} disabled={clearDisabled} title={t("pinCompareClearAll")}>
        {t("pinCompareClearAll")}
      </Button>
      <Button
        minWidth="28px"
        px="2"
        py="1"
        lineHeight={1}
        onClick={onClose}
        aria-label={t("pinCompareClose")}
        title={t("pinCompareClose")}
      >
        <Icon name="close" size={13} />
      </Button>
    </chakra.header>
  );
}
