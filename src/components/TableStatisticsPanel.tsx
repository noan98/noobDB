import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type IndexInfo } from "../api/tauri";
import { useT } from "../i18n";
import {
  buildTableStatRows,
  computeTableSizeTotals,
  filterTableStats,
  formatBytes,
  formatCount,
  formatRowCount,
  sizeBarPercent,
  sortTableStats,
  type SortDirection,
  type TableStatRow,
  type TableStatSortKey,
} from "./tableSize";
import { mapLimited } from "./mapLimited";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { Button } from "./ui";

/**
 * テーブル/DB サイズ・構造統計ダッシュボード (#562 / #660)。指定データベースの
 * テーブルごとに、行数 (概算)・データ/インデックス/合計サイズ (#562) に加え、列数・
 * インデックス数・PK 有無・FK 数 (#660) を一覧し、ソート/クイックフィルタで俯瞰する。
 * サイズはデータバーで可視化する (表示専用)。テーブル名クリックでそのテーブルを開く。
 *
 * 取得はエンジンのカタログを読むだけ (テーブルスキャンなし) — サイズ/行数は
 * table_sizes、列数は schema_overview、FK は foreign_keys、インデックス/PK は各
 * テーブルの list_indexes を並列数制限つきで引く。読み取り操作のため read_only でも
 * 利用可。SQLite ではサーバ統計が限られる項目は「—」に縮退する。
 */

// list_indexes を同時に開きすぎないための並列上限 (ER 図/スキーマエクスポートと同方針)。
const INDEX_FETCH_CONCURRENCY = 8;

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
const centerTdCss: SystemStyleObject = { ...tdCss, textAlign: "center" };
const tfootTdCss: SystemStyleObject = {
  ...numTdCss,
  borderTop: "2px solid var(--border)",
  fontWeight: 600,
  color: "var(--text-secondary)",
};

export function TableStatisticsPanel({
  sessionId,
  database,
  onOpenTable,
  onClose,
}: {
  sessionId: string;
  database: string;
  /** テーブル名クリックでそのテーブルを開く導線 (任意)。 */
  onOpenTable?: (table: string) => void;
  onClose: () => void;
}) {
  const t = useT();

  const [rows, setRows] = useState<TableStatRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<TableStatSortKey>("total_bytes");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [nameQuery, setNameQuery] = useState("");
  const [onlyNoIndex, setOnlyNoIndex] = useState(false);
  const [onlyNoPrimaryKey, setOnlyNoPrimaryKey] = useState(false);
  // リクエスト世代カウンタ: セッション/DB 切替や連打で複数の取得が走っても、最新の
  // 要求の応答だけを反映する (in-flight ブロックだと旧対象の結果が残りうる)。
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      // サイズ/行数・列数・FK は DB 単位の 1 コマンドずつ。インデックス/PK だけは
      // テーブル単位なので、サイズ一覧のテーブル名に対して並列数制限つきで引く。
      const [sizes, overview, foreignKeys] = await Promise.all([
        api.tableSizes(sessionId, database),
        api.schemaOverview(sessionId, database),
        api.foreignKeys(sessionId, database),
      ]);
      if (seq !== requestSeqRef.current) return;
      const indexResults = await mapLimited(
        sizes.map((s) => s.name),
        INDEX_FETCH_CONCURRENCY,
        async (name): Promise<[string, IndexInfo[] | null]> => {
          try {
            return [name, await api.listIndexes(sessionId, database, name)];
          } catch {
            // 1 テーブルの取得失敗は全体を落とさず「不明」(null) に縮退する。
            return [name, null];
          }
        },
      );
      if (seq !== requestSeqRef.current) return;
      const indexesByTable = new Map<string, IndexInfo[] | null>(indexResults);
      setRows(buildTableStatRows(sizes, overview, foreignKeys, indexesByTable));
      setError(null);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(String(e));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [sessionId, database]);

  useEffect(() => {
    setRows([]);
    setError(null);
    void load();
  }, [load]);

  const onSort = useCallback(
    (key: TableStatSortKey) => {
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

  const filtered = filterTableStats(rows, { nameQuery, onlyNoIndex, onlyNoPrimaryKey });
  const sorted = sortTableStats(filtered, sortKey, sortDir);
  const totals = computeTableSizeTotals(sorted);
  // データバーは合計サイズ列に対して、絞り込み前の一覧中の最大値を基準にスケールする
  // (フィルタで最大が消えてもバーの物差しが揺れないように)。
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total_bytes ?? 0), 0);
  const arrow = (key: TableStatSortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  // 現在のソート状態を支援技術へ伝える aria-sort 値。
  const ariaSort = (key: TableStatSortKey): "ascending" | "descending" | "none" =>
    sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none";
  // ヘッダはキーボードでも並び替えできるように Enter / Space を拾う。
  const onHeaderKey = (e: ReactKeyboardEvent, key: TableStatSortKey) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSort(key);
    }
  };
  // 各ソートヘッダ共通の a11y プロパティ (フォーカス可能 + role + aria-sort + キー操作)。
  // th はネイティブに columnheader ロールを持つ。role を上書きすると aria-sort が
  // 無効になるため、role は付けずキーボード/クリック操作だけを足す。
  const headerProps = (key: TableStatSortKey) => ({
    tabIndex: 0,
    "aria-sort": ariaSort(key),
    onClick: () => onSort(key),
    onKeyDown: (e: ReactKeyboardEvent) => onHeaderKey(e, key),
  });

  const pkLabel = (has: boolean | null) =>
    has == null ? "—" : has ? t("sizePkYes") : t("sizePkNo");

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
        <chakra.input
          type="text"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
          placeholder={t("sizeFilterName")}
          aria-label={t("sizeFilterName")}
          css={{
            padding: "5px 9px",
            fontSize: "var(--text-sm)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg)",
            color: "var(--text)",
            minWidth: "180px",
          }}
        />
        <chakra.label display="flex" alignItems="center" gap="1.5" fontSize="sm" color="app.text" cursor="pointer">
          <input type="checkbox" checked={onlyNoIndex} onChange={(e) => setOnlyNoIndex(e.target.checked)} />
          {t("sizeFilterNoIndex")}
        </chakra.label>
        <chakra.label display="flex" alignItems="center" gap="1.5" fontSize="sm" color="app.text" cursor="pointer">
          <input type="checkbox" checked={onlyNoPrimaryKey} onChange={(e) => setOnlyNoPrimaryKey(e.target.checked)} />
          {t("sizeFilterNoPk")}
        </chakra.label>
        {rows.length > 0 && (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("sizeFilterCount", { shown: sorted.length, total: rows.length })}
          </chakra.span>
        )}
      </Flex>

      {error ? (
        <chakra.p margin={0} fontSize="sm" color="var(--status-error)">
          {t("sizeLoadError", { error })}
        </chakra.p>
      ) : rows.length === 0 && !loading ? (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("sizeEmpty")}
        </chakra.p>
      ) : sorted.length === 0 && !loading ? (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("sizeNoMatch")}
        </chakra.p>
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse">
            <thead>
              <tr>
                <chakra.th css={{ ...thBase, textAlign: "left" }} {...headerProps("name")}>
                  {t("sizeColName")}
                  {arrow("name")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("row_estimate")}>
                  {t("sizeColRows")}
                  {arrow("row_estimate")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("column_count")}>
                  {t("sizeColColumns")}
                  {arrow("column_count")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("index_count")}>
                  {t("sizeColIndexes")}
                  {arrow("index_count")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "center" }} {...headerProps("primary_key")}>
                  {t("sizeColPk")}
                  {arrow("primary_key")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("foreign_key_count")}>
                  {t("sizeColFk")}
                  {arrow("foreign_key_count")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("data_bytes")}>
                  {t("sizeColData")}
                  {arrow("data_bytes")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("index_bytes")}>
                  {t("sizeColIndex")}
                  {arrow("index_bytes")}
                </chakra.th>
                <chakra.th css={{ ...thBase, textAlign: "right" }} {...headerProps("total_bytes")}>
                  {t("sizeColTotal")}
                  {arrow("total_bytes")}
                </chakra.th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.name}>
                  <chakra.td css={tdCss}>
                    {onOpenTable ? (
                      <chakra.button
                        type="button"
                        onClick={() => onOpenTable(r.name)}
                        title={t("sizeOpenTable", { table: r.name })}
                        css={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          font: "inherit",
                          color: "var(--accent)",
                          cursor: "pointer",
                          textAlign: "left",
                          _hover: { textDecoration: "underline" },
                        }}
                      >
                        {r.name}
                      </chakra.button>
                    ) : (
                      r.name
                    )}
                  </chakra.td>
                  <chakra.td css={numTdCss}>{formatRowCount(r.row_estimate)}</chakra.td>
                  <chakra.td css={numTdCss}>{formatCount(r.columnCount)}</chakra.td>
                  <chakra.td css={numTdCss}>{formatCount(r.indexCount)}</chakra.td>
                  <chakra.td css={centerTdCss}>{pkLabel(r.hasPrimaryKey)}</chakra.td>
                  <chakra.td css={numTdCss}>{formatCount(r.foreignKeyCount)}</chakra.td>
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
                <chakra.td css={tfootTdCss} />
                <chakra.td css={tfootTdCss} />
                <chakra.td css={tfootTdCss} />
                <chakra.td css={tfootTdCss} />
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
