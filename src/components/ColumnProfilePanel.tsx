import { useCallback, useEffect, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, type ColumnProfile, type TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { chartSeriesColors } from "./chartData";
import { CartesianChart } from "./ChartView";
import {
  formatPercent,
  formatProfileCount,
  profileChartKind,
  profileChartModel,
  profileNoteKey,
  profilePercent,
  profileTargetLabel,
  profileValueLabel,
  type ProfileTarget,
} from "./columnProfile";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Select } from "./ui";

/**
 * 列データプロファイル (「列を探索」、#974) のボトムパネル。
 *
 * SQL を書きながら「この列にどんな値が入っているか」を参照する情報なので、
 * ui-design-system.md §7.1 に従い Modal ではなく Bottom Panel に置く (エディタと
 * 結果を消さない)。見出しと閉じるボタンはシェル (`BottomPanel`) が持つ。
 *
 * - 集計はバックエンドの `profile_column` がサーバ側で**全件**に対して行う
 *   (取得済み行だけを見る結果グリッドのクイック統計 #524 とは別物)。すべて
 *   読み取りの SELECT なので read_only セッションでも動く。
 * - 列を選ぶ (またはグリッドの列から開く) と自動で実行する。明示操作の結果なので
 *   全件走査を勝手に始めることにはならない。再実行ボタンも置く。
 * - 描画は `ChartView` の棒グラフ (`CartesianChart`) を再利用し、数値列は
 *   ヒストグラム、それ以外は上位頻出値の棒にする。整形ロジックは `columnProfile.ts`。
 * - 型の都合で計算できなかった段は理由コード (`notes`) を文言にして示し、黙って
 *   欠落させない (アドバイザの `skipped` と同じ方針)。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1) var(--space-2)",
  textAlign: "left",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
};

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Box
      minW="120px"
      flex="1"
      px="3"
      py="2"
      borderRadius="md"
      borderWidth="1px"
      borderColor="app.border"
      bg="app.surface"
    >
      <chakra.div textStyle="overline" color="app.textMuted">
        {label}
      </chakra.div>
      <chakra.div
        fontSize="md"
        fontWeight={600}
        fontFamily="var(--font-mono)"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {value}
      </chakra.div>
      {sub && (
        <chakra.div fontSize="xs" color="app.textMuted">
          {sub}
        </chakra.div>
      )}
    </Box>
  );
}

export function ColumnProfilePanel({
  sessionId,
  driver,
  target,
  onSelectColumn,
}: {
  sessionId: string;
  driver: string;
  target: ProfileTarget;
  /** 列の選択を App の対象 state へ戻す (タブを閉じて開き直しても列が残る)。 */
  onSelectColumn: (column: string) => void;
}) {
  const t = useT();
  const [columns, setColumns] = useState<TableColumnInfo[] | null>(null);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [approximate, setApproximate] = useState(false);
  const [profile, setProfile] = useState<ColumnProfile | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 連続して列を切り替えたとき、遅れて返った古い結果で上書きしない。
  const requestSeq = useRef(0);

  const { database, table, column } = target;

  useEffect(() => {
    let cancelled = false;
    setColumns(null);
    setColumnsError(null);
    api
      .describeTable(sessionId, database, table)
      .then((cols) => {
        if (!cancelled) setColumns(cols);
      })
      .catch((e) => {
        if (!cancelled) setColumnsError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  const run = useCallback(async () => {
    if (!column) return;
    const seq = ++requestSeq.current;
    setRunning(true);
    setError(null);
    try {
      const p = await api.profileColumn(sessionId, database, table, column, approximate);
      if (seq === requestSeq.current) setProfile(p);
    } catch (e) {
      if (seq === requestSeq.current) {
        setProfile(null);
        setError(String(e));
      }
    } finally {
      if (seq === requestSeq.current) setRunning(false);
    }
  }, [sessionId, database, table, column, approximate]);

  // 対象列が決まった / 変わったら自動で実行する (近似の切替も再実行する)。
  useEffect(() => {
    setProfile(null);
    if (column) void run();
  }, [run, column]);

  const chartKind = profile ? profileChartKind(profile) : null;
  const chartModel =
    profile && chartKind
      ? profileChartModel(profile, chartKind, {
          value: t("profileValue"),
          count: t("profileCount"),
          nullLabel: "NULL",
        })
      : null;

  return (
    <Box flex="1" overflowY="auto" py="3" px="4" display="flex" flexDirection="column" gap="3">
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("profileDesc")}
      </chakra.p>

      <Flex align="center" gap="3" flexWrap="wrap">
        <chakra.span fontFamily="var(--font-mono)" fontSize="sm" color="app.textSecondary">
          {profileTargetLabel(driver, { database, table, column: null })}
        </chakra.span>
        <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm">
          <chakra.span color="app.textMuted">{t("profileColumnLabel")}</chakra.span>
          <Select
            value={column ?? ""}
            onChange={(e) => {
              if (e.target.value) onSelectColumn(e.target.value);
            }}
            width="auto"
            disabled={!columns}
            aria-label={t("profileColumnLabel")}
          >
            {!column && <option value="">{t("profileSelectColumn")}</option>}
            {column && !columns?.some((c) => c.name === column) && (
              <option value={column}>{column}</option>
            )}
            {(columns ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.data_type})
              </option>
            ))}
          </Select>
        </chakra.label>
        <Tooltip label={t("profileApproximateHint")}>
          <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" cursor="pointer">
            <Checkbox checked={approximate} onChange={() => setApproximate((v) => !v)} />
            {t("profileApproximate")}
          </chakra.label>
        </Tooltip>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void run()}
          disabled={!column || running}
        >
          <Icon name="refresh" size={ICON_SIZES.sm} />
          <chakra.span marginLeft="1.5">{profile ? t("profileRerun") : t("profileRun")}</chakra.span>
        </Button>
        {running && (
          <Flex align="center" gap="2">
            <Spinner size={14} />
            <chakra.span fontSize="sm" color="app.textMuted">
              {t("profileRunning")}
            </chakra.span>
          </Flex>
        )}
      </Flex>

      {columnsError && (
        <chakra.div role="alert" fontSize="sm" color="app.textError">
          {t("profileLoadColumnsError", { error: columnsError })}
        </chakra.div>
      )}

      {error && (
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("profileError", { error })}
          action={{ label: t("profileRetry"), onClick: () => void run() }}
        />
      )}

      {!column && !error && <EmptyState compact icon="columns" title={t("profileEmpty")} />}

      {profile && (
        <>
          {profile.notes.length > 0 && (
            <Box
              borderRadius="sm"
              border="1px solid"
              borderColor={semanticColorToken("warning", "border")}
              bg={semanticColorToken("warning", "subtle")}
              color={semanticColorToken("warning", "text")}
              px="3"
              py="2"
            >
              {profile.notes.map((code) => (
                <chakra.div key={code} fontSize="sm">
                  {t(profileNoteKey(code))}
                </chakra.div>
              ))}
            </Box>
          )}

          <Flex gap="2" flexWrap="wrap">
            <StatTile label={t("profileType")} value={profile.data_type} />
            <StatTile label={t("profileTotal")} value={formatProfileCount(profile.total_count)} />
            <StatTile
              label={t("profileNulls")}
              value={formatPercent(profilePercent(profile.null_count, profile.total_count))}
              sub={formatProfileCount(profile.null_count)}
            />
            <StatTile
              label={t("profileDistinct")}
              value={formatProfileCount(profile.distinct_count)}
              sub={profile.distinct_approximate ? t("profileApproxMark") : undefined}
            />
            <StatTile label={t("profileMin")} value={profileValueLabel(profile.min_value) ?? "NULL"} />
            <StatTile label={t("profileMax")} value={profileValueLabel(profile.max_value) ?? "NULL"} />
          </Flex>

          {chartModel && chartKind ? (
            <Flex gap="4" flexWrap="wrap" align="flex-start">
              <Box flex="2" minW="320px">
                <chakra.div textStyle="overline" color="app.textMuted" marginBottom="1">
                  {chartKind === "histogram" ? t("profileHistogram") : t("profileTopValues")}
                </chakra.div>
                <Box h="220px">
                  <CartesianChart
                    model={chartModel}
                    type="bar"
                    xName={t("profileValue")}
                    colors={chartSeriesColors(undefined, 1)}
                  />
                </Box>
              </Box>
              {profile.top_values.length > 0 && (
                <Box flex="1" minW="240px" maxH="260px" overflowY="auto">
                  <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                    <chakra.caption textAlign="left" textStyle="overline" color="app.textMuted" paddingBottom="1">
                      {t("profileTopValues")}
                    </chakra.caption>
                    <chakra.thead>
                      <chakra.tr>
                        <chakra.th css={thCss}>{t("profileValue")}</chakra.th>
                        <chakra.th css={thCss} textAlign="right">{t("profileCount")}</chakra.th>
                        <chakra.th css={thCss} textAlign="right">{t("profileShare")}</chakra.th>
                      </chakra.tr>
                    </chakra.thead>
                    <chakra.tbody>
                      {profile.top_values.map((tv, i) => (
                        <chakra.tr key={i}>
                          <chakra.td
                            css={tdCss}
                            fontFamily="var(--font-mono)"
                            maxW="240px"
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                          >
                            {profileValueLabel(tv.value) ?? "NULL"}
                          </chakra.td>
                          <chakra.td css={tdCss} textAlign="right" fontFamily="var(--font-mono)">
                            {formatProfileCount(tv.count)}
                          </chakra.td>
                          <chakra.td css={tdCss} textAlign="right" color="app.textMuted">
                            {formatPercent(profilePercent(tv.count, profile.total_count))}
                          </chakra.td>
                        </chakra.tr>
                      ))}
                    </chakra.tbody>
                  </chakra.table>
                </Box>
              )}
            </Flex>
          ) : (
            <EmptyState compact icon="chart" title={t("profileNoValues")} />
          )}
        </>
      )}
    </Box>
  );
}
