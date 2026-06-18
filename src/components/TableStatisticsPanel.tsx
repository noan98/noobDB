import { useCallback, useEffect, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type TableSizeInfo } from "../api/tauri";
import { useT } from "../i18n";
import {
  computeTableSizeTotals,
  formatBytes,
  formatRowCount,
  sizeBarPercent,
  sortTableSizes,
  type SortDirection,
  type TableSizeSortKey,
} from "./tableSize";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { Button } from "./ui";

/**
 * テーブル/DB サイズ・統計ダッシュボード (#562)。指定データベースのテーブルごとに
 * 行数 (概算)・データ/インデックス/合計サイズを取得し、ソート可能な一覧 + 合計で
 * 表示する。サイズはデータバーで可視化する (表示専用)。
 *
 * 取得はエンジンのカタログを読むだけ (テーブルスキャンなし) なので、ProcessList と
 * 同じ接続スコープの全画面ビューとして扱う。読み取り操作のため read_only でも利用可。
 */

const thBase: SystemStyleObject = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "6px 10px",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
  cursor: "pointer",
  userSelect: "none",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "5px 10px",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
};
const numTdCss: SystemStyleObject = { ...tdCss, textAlign: "right" };
const tfootTdCss: SystemStyleObject = {
  ...numTdCss,
  borderTop: "2px solid var(--border)",
  fontWeight: 600,
  color: "var(--text-secondary)",
};

export function TableStatisticsPanel({
  sessionId,
  database,
  onClose,
}: {
  sessionId: string;
  database: string;
  onClose: () => void;
}) {
  const t = useT();

  const [rows, setRows] = useState<TableSizeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<TableSizeSortKey>("total_bytes");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      const list = await api.tableSizes(sessionId, database);
      setRows(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [sessionId, database]);

  useEffect(() => {
    setRows([]);
    setError(null);
    void load();
  }, [load]);

  const onSort = useCallback(
    (key: TableSizeSortKey) => {
      setSortKey((curKey) => {
        if (curKey === key) {
          // 同じ列の再クリックで方向トグル。
          setSortDir((d) => (d === "asc" ? "desc" : "asc"));
          return curKey;
        }
        // 新しい列: 名前は昇順、数値列は降順 (大きいものを上に) が直感的。
        setSortDir(key === "name" ? "asc" : "desc");
        return key;
      });
    },
    [],
  );

  const sorted = sortTableSizes(rows, sortKey, sortDir);
  const totals = computeTableSizeTotals(rows);
  // データバーは合計サイズ列に対して、一覧中の最大値を基準にスケールする。
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total_bytes ?? 0), 0);
  const arrow = (key: TableSizeSortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="14px">
      <chakra.header
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <chakra.h2 margin={0} fontSize="lg" fontWeight={600} color="app.text">
          {t("sizeTitle")} — {database}
        </chakra.h2>
        <Button
          minWidth="28px"
          px="2"
          py="1"
          fontSize="base"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("sizeClose")}
          title={t("sizeClose")}
        >
          <Icon name="close" size={13} />
        </Button>
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("sizeDesc", { database })}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <Button type="button" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={13} /> {t("sizeRefresh")}
        </Button>
        {loading && <Spinner size={14} />}
      </Flex>

      {error ? (
        <chakra.p margin={0} fontSize="sm" color="var(--status-error)">
          {t("sizeLoadError", { error })}
        </chakra.p>
      ) : rows.length === 0 && !loading ? (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("sizeEmpty")}
        </chakra.p>
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse">
            <thead>
              <tr>
                <chakra.th css={{ ...thBase, textAlign: "left" }} onClick={() => onSort("name")}>
                  {t("sizeColName")}
                  {arrow("name")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} onClick={() => onSort("row_estimate")}>
                  {t("sizeColRows")}
                  {arrow("row_estimate")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} onClick={() => onSort("data_bytes")}>
                  {t("sizeColData")}
                  {arrow("data_bytes")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} onClick={() => onSort("index_bytes")}>
                  {t("sizeColIndex")}
                  {arrow("index_bytes")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} onClick={() => onSort("total_bytes")}>
                  {t("sizeColTotal")}
                  {arrow("total_bytes")}
                </chakra.th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.name}>
                  <chakra.td css={tdCss}>{r.name}</chakra.td>
                  <chakra.td css={numTdCss}>{formatRowCount(r.row_estimate)}</chakra.td>
                  <chakra.td css={numTdCss}>{formatBytes(r.data_bytes)}</chakra.td>
                  <chakra.td css={numTdCss}>{formatBytes(r.index_bytes)}</chakra.td>
                  <chakra.td css={numTdCss}>
                    <Box position="relative">
                      {/* データバー (表示専用): 一覧中の最大合計を 100% とする。 */}
                      <Box
                        position="absolute"
                        top={0}
                        right={0}
                        bottom={0}
                        width={`${sizeBarPercent(r.total_bytes, maxTotal)}%`}
                        background="var(--accent)"
                        opacity={0.18}
                        borderRadius="var(--radius-sm)"
                        aria-hidden
                      />
                      <chakra.span position="relative">{formatBytes(r.total_bytes)}</chakra.span>
                    </Box>
                  </chakra.td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <chakra.td css={{ ...tfootTdCss, textAlign: "left" }}>
                  {t("sizeTotalsLabel", { count: totals.tableCount })}
                </chakra.td>
                <chakra.td css={tfootTdCss}>{formatRowCount(totals.rowEstimate)}</chakra.td>
                <chakra.td css={tfootTdCss}>{formatBytes(totals.dataBytes)}</chakra.td>
                <chakra.td css={tfootTdCss}>{formatBytes(totals.indexBytes)}</chakra.td>
                <chakra.td css={tfootTdCss}>{formatBytes(totals.totalBytes)}</chakra.td>
              </tr>
            </tfoot>
          </chakra.table>
        </Box>
      )}
    </Box>
  );
}
