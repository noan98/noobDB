import { useCallback, useEffect, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { motion } from "motion/react";

import {
  api,
  type ColumnProfile,
  type ProfileCount,
  type TableColumnInfo,
  type TableProfileOverview,
} from "../api/tauri";
import { useT } from "../i18n";
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
import { StatTile } from "./StatTile";
import { integerCountUpTarget } from "../useCountUp";
import { Spinner } from "./Spinner";
import { Skeleton, SkeletonTableRows } from "./Skeleton";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Select } from "./ui";
import { ErrorNote } from "./modalForm";
import { Callout } from "./Callout";
import { transitions, variants } from "../motion";

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

// 結果の差し替えはフェードで出す (reduced-motion は MotionConfig が即時化する)。
const MotionReveal = chakra(
  motion.div,
  {},
  {
    forwardProps: ["initial", "animate", "transition"],
  },
);

// 件数は number ならカウントアップ、2^53 超の文字列は丸めず文字列のまま出す (#1238)。
const countTile = (c: ProfileCount | null | undefined) => integerCountUpTarget(c) ?? formatProfileCount(c);
// 補間中の小数は四捨五入してから整形する (CountUp 既定と同じ)。
const formatCount = (n: number) => formatProfileCount(Math.round(n));

/** 列選択から自動集計を発行するまでの待ち時間 (ms)。 */
const PROFILE_DEBOUNCE_MS = 300;

export function ColumnProfilePanel({
  sessionId,
  driver,
  target,
  onSelectColumn,
  onCompare,
}: {
  sessionId: string;
  driver: string;
  target: ProfileTarget;
  /** 列の選択を App の対象 state へ戻す (タブを閉じて開き直しても列が残る)。 */
  onSelectColumn: (column: string) => void;
  /** 他の接続の同じ列と分布を並べて比べるモーダルを開く (#1539)。未指定なら入口を出さない。 */
  onCompare?: (approximate: boolean) => void;
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
  // 全列の概要 (#1539)。全件走査になるので自動実行せず、ボタンで明示的に取る。
  const [overview, setOverview] = useState<TableProfileOverview | null>(null);
  const [overviewRunning, setOverviewRunning] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const overviewSeq = useRef(0);
  // 自動実行の debounce タイマー (手動実行で取り消せるよう ref に持つ)。
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // 対象の表が変わったら前の表の概要は捨てる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依存は「表が変わった」ことの検知にだけ使う
  useEffect(() => {
    overviewSeq.current++;
    setOverview(null);
    setOverviewError(null);
    setOverviewRunning(false);
  }, [sessionId, database, table]);

  const runOverview = async () => {
    const seq = ++overviewSeq.current;
    setOverviewRunning(true);
    setOverviewError(null);
    try {
      const o = await api.profileTable(sessionId, database, table, true);
      if (seq === overviewSeq.current) setOverview(o);
    } catch (e) {
      if (seq === overviewSeq.current) {
        setOverview(null);
        setOverviewError(String(e));
      }
    } finally {
      if (seq === overviewSeq.current) setOverviewRunning(false);
    }
  };

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
  // 列を素早く切り替えたときに全件集計が並走しないよう、自動実行は PROFILE_DEBOUNCE_MS 待つ
  // (ボタンからの手動実行は即時)。待っている間に古い結果が出ないよう seq も進めておく。
  useEffect(() => {
    setProfile(null);
    // 列が無いときも連番を進め、走行中だった前の列の応答を捨てる。
    requestSeq.current++;
    if (!column) {
      setRunning(false);
      setError(null);
      return;
    }
    // debounce 待ちの間に前回のエラーが残らないようにする。
    setError(null);
    const timer = setTimeout(() => {
      debounceTimer.current = null;
      void run();
    }, PROFILE_DEBOUNCE_MS);
    debounceTimer.current = timer;
    return () => {
      clearTimeout(timer);
      if (debounceTimer.current === timer) debounceTimer.current = null;
    };
  }, [run, column]);

  // 手動実行: 待機中の自動実行があれば取り消して、二重に発行しない。
  const runNow = () => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    void run();
  };

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
            {column && !columns?.some((c) => c.name === column) && <option value={column}>{column}</option>}
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
        <Button type="button" variant="primary" size="sm" onClick={runNow} disabled={!column || running}>
          <Icon name="refresh" size={ICON_SIZES.sm} />
          <chakra.span marginLeft="1.5">{profile ? t("profileRerun") : t("profileRun")}</chakra.span>
        </Button>
        {onCompare && (
          <Tooltip label={t("profileCompareOpenTooltip")} focusableWrapper={!column}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onCompare(approximate)}
              disabled={!column}
            >
              {t("profileCompareOpen")}
            </Button>
          </Tooltip>
        )}
        <Tooltip label={t("profileOverviewHint")}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void runOverview()}
            disabled={overviewRunning}
          >
            <Icon name="columns" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">
              {overview ? t("profileOverviewRerun") : t("profileOverviewRun")}
            </chakra.span>
          </Button>
        </Tooltip>
        {running && (
          <Flex align="center" gap="2">
            <Spinner size={14} />
            <chakra.span fontSize="sm" color="app.textMuted">
              {t("profileRunning")}
            </chakra.span>
          </Flex>
        )}
      </Flex>

      {overviewError && (
        <ErrorNote role="alert">{t("profileOverviewError", { error: overviewError })}</ErrorNote>
      )}
      {overviewRunning && (
        <Flex align="center" gap="2">
          <Spinner size={14} />
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("profileOverviewRunning")}
          </chakra.span>
        </Flex>
      )}
      {overview && !overviewRunning && (
        <Box data-testid="profile-overview" maxH="260px" overflow="auto" flexShrink={0}>
          <chakra.div textStyle="caption" color="app.textMuted" marginBottom="1">
            {t("profileOverviewSummary", {
              rows: formatProfileCount(overview.total_count),
              columns: overview.columns.length,
              scans: overview.scans,
            })}
          </chakra.div>
          <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
            <chakra.thead>
              <chakra.tr>
                <chakra.th css={thCss}>{t("profileColumnLabel")}</chakra.th>
                <chakra.th css={thCss}>{t("profileType")}</chakra.th>
                <chakra.th css={thCss} textAlign="right">
                  {t("profileOverviewNonNull")}
                </chakra.th>
                <chakra.th css={thCss} textAlign="right">
                  {t("profileNulls")}
                </chakra.th>
                <chakra.th css={thCss} textAlign="right">
                  {t("profileDistinct")}
                </chakra.th>
                <chakra.th css={thCss}>{t("profileMin")}</chakra.th>
                <chakra.th css={thCss}>{t("profileMax")}</chakra.th>
              </chakra.tr>
            </chakra.thead>
            <chakra.tbody>
              {overview.columns.map((c) => {
                const skipped = c.notes.length > 0;
                return (
                  <chakra.tr
                    key={c.column}
                    css={{ background: c.column === column ? "var(--bg-muted)" : undefined }}
                  >
                    <chakra.td css={tdCss} fontFamily="var(--font-mono)">
                      <chakra.button
                        type="button"
                        onClick={() => onSelectColumn(c.column)}
                        aria-label={t("profileOverviewSelect", { column: c.column })}
                        textAlign="left"
                        color="app.textAccent"
                        cursor="pointer"
                        background="transparent"
                        border="none"
                        padding="0"
                        _hover={{ textDecoration: "underline" }}
                      >
                        {c.column}
                      </chakra.button>
                    </chakra.td>
                    <chakra.td css={tdCss} color="app.textMuted">
                      {c.data_type}
                    </chakra.td>
                    <chakra.td css={tdCss} textAlign="right" fontFamily="var(--font-mono)">
                      {formatProfileCount(c.non_null_count)}
                    </chakra.td>
                    <chakra.td css={tdCss} textAlign="right" fontFamily="var(--font-mono)">
                      {formatPercent(profilePercent(c.null_count, overview.total_count))}
                    </chakra.td>
                    <chakra.td css={tdCss} textAlign="right" fontFamily="var(--font-mono)">
                      {c.distinct_count === null ? "—" : formatProfileCount(c.distinct_count)}
                    </chakra.td>
                    <chakra.td
                      css={tdCss}
                      fontFamily="var(--font-mono)"
                      maxW="160px"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {skipped ? (
                        <Tooltip label={c.notes.map((n) => t(profileNoteKey(n))).join(" ")}>
                          <chakra.span color="app.textMuted">{t("profileOverviewSkippedMark")}</chakra.span>
                        </Tooltip>
                      ) : (
                        (profileValueLabel(c.min_value) ?? "NULL")
                      )}
                    </chakra.td>
                    <chakra.td
                      css={tdCss}
                      fontFamily="var(--font-mono)"
                      maxW="160px"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {skipped ? (
                        <chakra.span color="app.textMuted">{t("profileOverviewSkippedMark")}</chakra.span>
                      ) : (
                        (profileValueLabel(c.max_value) ?? "NULL")
                      )}
                    </chakra.td>
                  </chakra.tr>
                );
              })}
            </chakra.tbody>
          </chakra.table>
        </Box>
      )}

      {columnsError && (
        <ErrorNote role="alert">{t("profileLoadColumnsError", { error: columnsError })}</ErrorNote>
      )}

      {error && (
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("profileError", { error })}
          action={{ label: t("profileRetry"), onClick: runNow }}
        />
      )}

      {!column && !error && <EmptyState compact icon="columns" title={t("profileEmpty")} />}

      {running && (
        // 実行中は結果 (統計タイル + ヒストグラム + 上位値表) の形を模したシマーを
        // 出し、完了時のレイアウトジャンプを抑える (#1211)。待機の告知は上の
        // status が担う。
        <Flex direction="column" gap="3" aria-hidden data-testid="profile-skeleton">
          <Flex gap="2" flexWrap="wrap">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton
                key={i}
                flex="1"
                minW="120px"
                height="52px"
                borderRadius="md"
                style={{ animationDelay: `${i * 0.035}s` }}
              />
            ))}
          </Flex>
          <Flex gap="4" flexWrap="wrap" align="flex-start">
            <Skeleton flex="2" minW="320px" height="220px" borderRadius="md" />
            <Box flex="1" minW="240px">
              <chakra.table width="100%" style={{ borderCollapse: "collapse" }}>
                <chakra.tbody>
                  <SkeletonTableRows columns={3} rows={5} />
                </chakra.tbody>
              </chakra.table>
            </Box>
          </Flex>
        </Flex>
      )}

      {profile && !running && (
        <MotionReveal
          initial={variants.fade.initial}
          animate={variants.fade.animate}
          transition={transitions.enter}
          display="flex"
          flexDirection="column"
          gap="3"
        >
          {profile.notes.length > 0 && (
            <Callout tone="warning" px="3">
              {profile.notes.map((code) => (
                <chakra.div key={code}>{t(profileNoteKey(code))}</chakra.div>
              ))}
            </Callout>
          )}

          <Flex gap="2" flexWrap="wrap">
            <StatTile label={t("profileType")} value={profile.data_type} />
            <StatTile
              label={t("profileTotal")}
              value={countTile(profile.total_count)}
              formatter={formatCount}
            />
            <StatTile
              label={t("profileNulls")}
              value={profilePercent(profile.null_count, profile.total_count) ?? "—"}
              formatter={formatPercent}
              sub={formatProfileCount(profile.null_count)}
            />
            <StatTile
              label={t("profileDistinct")}
              value={countTile(profile.distinct_count)}
              formatter={formatCount}
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
                    <chakra.caption
                      textAlign="left"
                      textStyle="overline"
                      color="app.textMuted"
                      paddingBottom="1"
                    >
                      {t("profileTopValues")}
                    </chakra.caption>
                    <chakra.thead>
                      <chakra.tr>
                        <chakra.th css={thCss}>{t("profileValue")}</chakra.th>
                        <chakra.th css={thCss} textAlign="right">
                          {t("profileCount")}
                        </chakra.th>
                        <chakra.th css={thCss} textAlign="right">
                          {t("profileShare")}
                        </chakra.th>
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
        </MotionReveal>
      )}
    </Box>
  );
}
