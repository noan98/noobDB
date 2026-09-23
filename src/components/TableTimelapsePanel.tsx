import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type DiffStatus,
  type TableWatch,
  type TimelapseGenerationDiff,
  type TimelapseGenerationMeta,
} from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import { useSettings } from "../settings";
import {
  buildTimelapseRows,
  countTimelapseDiff,
  resolveGenerationPair,
  summarizeCapture,
  totalTimelapseBytes,
  type TimelapseRowKind,
} from "../tableTimelapse";
import { resolveMaskedColumns } from "./columnMask";
import { useConfirm } from "./ConfirmDialog";
import { statusColors } from "./diffStatusColors";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { ErrorNote } from "./modalForm";
import { Spinner } from "./Spinner";
import { formatBytes } from "./tableSize";
import { Button, Select } from "./ui";

/**
 * テーブル・タイムラプス (#739) のボトムパネル。
 *
 * ウォッチ登録したテーブル (マスターデータ級の小テーブル) の世代スナップショット
 * 一覧と、任意の 2 世代間の行差分 (追加 / 削除 / 変更行のセル単位ハイライト) を
 * 表示する。「さっきの変更で何が変わったか」を SQL を書きながら確認する参照情報
 * なので ui-design-system.md §7.1 に従い Bottom Panel に置く (見出しと閉じる
 * ボタンはシェルが持つ)。
 *
 * - 保存・ローテーション・差分計算は Rust 側 (`timelapse_*` IPC)。差分は
 *   `db::data_diff::compute_data_diff` の流用で、表示モデルへの整形は
 *   `tableTimelapse.ts` の純関数。
 * - ウォッチ登録はスキーマツリーのテーブル右クリックから `watchRequest` として
 *   届く。登録前に確認ダイアログで制約 (行数上限・PK 必須・大テーブルは対象外) と
 *   プライバシー (実データのローカルコピー / 保存先 / マスクは表示専用) を明示する。
 * - 機微カラムマスク (#1069) は結果グリッドと同じ設定で**表示だけ**伏せる。
 */

export interface TimelapseWatchRequest {
  database: string;
  table: string;
  /** 同じテーブルを続けて要求しても effect が再実行されるよう毎回変える連番。 */
  seq: number;
}

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
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};

/** 差分行の種別 → `DiffStatus` の色語彙 (スキーマ/データ比較と共通)。 */
const KIND_STATUS: Record<TimelapseRowKind, DiffStatus> = {
  added: "source_only",
  removed: "target_only",
  changed: "different",
};

function rowBackground(kind: TimelapseRowKind): string | undefined {
  if (kind === "added") return semanticColorVar("success", "subtle");
  if (kind === "removed") return semanticColorVar("danger", "subtle");
  return undefined;
}

function formatCaptured(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Chip({ status, children }: { status: DiffStatus; children: React.ReactNode }) {
  const c = statusColors(status);
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      px="2"
      py="0.5"
      borderRadius="pill"
      borderWidth="1px"
      fontSize="xs"
      textStyle="numeric"
      style={{ color: c.color, borderColor: c.borderColor }}
    >
      {children}
    </chakra.span>
  );
}

export function TableTimelapsePanel({
  sessionId,
  profileId,
  maxGenerations,
  watchRequest,
  onRequestConsumed,
  refreshKey,
}: {
  sessionId: string;
  profileId: string;
  maxGenerations: number;
  /** スキーマツリーから届いたウォッチ登録要求 (処理したら `onRequestConsumed`)。 */
  watchRequest: TimelapseWatchRequest | null;
  onRequestConsumed: () => void;
  /** 親 (接続時の自動取得) が世代を追加したときに一覧を読み直させるカウンタ。 */
  refreshKey: number;
}) {
  const t = useT();
  const { columnMaskEnabled, columnMaskPatterns } = useSettings();
  const { confirm, dialog } = useConfirm();

  const [watches, setWatches] = useState<TableWatch[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pair, setPair] = useState<{ fromId: number; toId: number } | null>(null);
  const [diff, setDiff] = useState<TimelapseGenerationDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.timelapseListWatches(profileId);
      setWatches(list);
      setLoadError(null);
      return list;
    } catch (e) {
      setLoadError(String(e));
      return null;
    }
  }, [profileId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const selected = useMemo(() => {
    if (!watches || watches.length === 0) return null;
    return watches.find((w) => w.id === selectedId) ?? watches[0];
  }, [watches, selectedId]);
  const generations: TimelapseGenerationMeta[] = selected?.generations ?? [];
  const effectivePair = resolveGenerationPair(generations, pair);

  // 選択中の 2 世代の差分を取得する。ペアが変わるたびに取り直す。
  const fromId = effectivePair?.fromId ?? null;
  const toId = effectivePair?.toId ?? null;
  useEffect(() => {
    if (fromId === null || toId === null) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    api
      .timelapseDiffGenerations(fromId, toId)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiff(null);
          setDiffError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fromId, toId]);

  // ── ウォッチ登録 (スキーマツリーの右クリックから) ──
  const handledSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (!watchRequest || handledSeqRef.current === watchRequest.seq) return;
    handledSeqRef.current = watchRequest.seq;
    const { database, table } = watchRequest;
    onRequestConsumed();
    void (async () => {
      setActionError(null);
      setNotice(null);
      const ok = await confirm({
        title: t("timelapseWatchConfirmTitle", { table }),
        message: (
          <chakra.ul display="flex" flexDirection="column" gap="1.5" paddingLeft="4" margin="0">
            <li>{t("timelapseWatchScope", { limit: 5000 })}</li>
            <li>{t("timelapseWatchPk")}</li>
            <li>{t("timelapseWatchPrivacy")}</li>
            <li>{t("timelapseWatchMask")}</li>
          </chakra.ul>
        ),
        confirmLabel: t("timelapseWatchConfirmOk"),
      });
      if (!ok) return;
      setBusy(true);
      try {
        let outcome = await api.timelapseWatchTable({
          sessionId,
          database,
          table,
          allowPartial: false,
          maxGenerations,
        });
        if (outcome.watch_id === null && outcome.over_limit) {
          setBusy(false);
          const partialOk = await confirm({
            title: t("timelapseOverLimitTitle", { limit: outcome.row_limit }),
            message: t("timelapseOverLimitMessage", { limit: outcome.row_limit }),
            confirmLabel: t("timelapseOverLimitOk", { limit: outcome.row_limit }),
            tone: "warning",
          });
          if (!partialOk) {
            setNotice(t("timelapseWatchDeclined", { limit: outcome.row_limit }));
            return;
          }
          setBusy(true);
          outcome = await api.timelapseWatchTable({
            sessionId,
            database,
            table,
            allowPartial: true,
            maxGenerations,
          });
        }
        const list = await reload();
        if (outcome.watch_id !== null) {
          setSelectedId(outcome.watch_id);
          setPair(null);
          setNotice(t("timelapseWatched", { table }));
        } else if (list === null) {
          setNotice(null);
        }
      } catch (e) {
        setActionError(String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [watchRequest, onRequestConsumed, confirm, t, sessionId, maxGenerations, reload]);

  // ── 手動更新 ──
  const captureNow = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const outcomes = await api.timelapseCapture(sessionId, maxGenerations);
      const summary = summarizeCapture(outcomes);
      await reload();
      setPair(null);
      if (summary.failed.length > 0) {
        setActionError(
          summary.failed.map((f) => `${f.table}: ${f.error}`).join("\n"),
        );
      }
      setNotice(
        summary.changed.length > 0
          ? t("timelapseCaptureChanged", { tables: summary.changed.join(", ") })
          : t("timelapseCaptureUnchanged"),
      );
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, maxGenerations, reload, t]);

  // ── ウォッチ解除 (世代データを消すかを確認する) ──
  const unwatch = useCallback(
    async (w: TableWatch) => {
      setActionError(null);
      setNotice(null);
      let deleteData = false;
      if (w.active) {
        const ok = await confirm({
          title: t("timelapseUnwatchTitle", { table: w.table }),
          message: t("timelapseUnwatchMessage"),
          confirmLabel: t("timelapseUnwatch"),
          tone: "warning",
        });
        if (!ok) return;
      }
      if (w.generations.length > 0) {
        deleteData = await confirm({
          title: t("timelapseDeleteDataTitle"),
          message: t("timelapseDeleteDataMessage", { count: w.generations.length, table: w.table }),
          confirmLabel: t("timelapseDeleteDataOk"),
          cancelLabel: w.active ? t("timelapseKeepData") : undefined,
          tone: "danger",
        });
        // 解除済み (データだけ残っている) ウォッチでは削除を断ったら何もしない。
        if (!w.active && !deleteData) return;
      }
      try {
        await api.timelapseUnwatch(w.id, deleteData || w.generations.length === 0);
        await reload();
        if (deleteData) setSelectedId(null);
      } catch (e) {
        setActionError(String(e));
      }
    },
    [confirm, t, reload],
  );

  const masked = useMemo(
    () =>
      diff
        ? resolveMaskedColumns(diff.diff.columns, {
            enabled: columnMaskEnabled,
            patterns: columnMaskPatterns,
            overrides: {},
          })
        : null,
    [diff, columnMaskEnabled, columnMaskPatterns],
  );
  const rows = useMemo(() => (diff ? buildTimelapseRows(diff.diff, masked) : []), [diff, masked]);
  const counts = diff ? countTimelapseDiff(diff.diff) : null;

  const kindLabel: Record<TimelapseRowKind, string> = {
    added: t("timelapseKindAdded"),
    removed: t("timelapseKindRemoved"),
    changed: t("timelapseKindChanged"),
  };

  const genLabel = (g: TimelapseGenerationMeta, i: number) =>
    `${i === 0 ? `${t("timelapseLatest")} · ` : ""}${formatCaptured(g.captured_at)} (${t("timelapseRows", {
      count: g.row_count,
    })}${g.truncated ? ` · ${t("timelapsePartial")}` : ""})`;

  return (
    <Box flex="1" minH={0} display="flex" flexDirection="column">
      {dialog}
      <Flex align="center" gap="2" px="4" py="2" borderBottom="1px solid" borderColor="app.border" flexWrap="wrap">
        <Button type="button" variant="secondary" size="sm" onClick={() => void captureNow()} disabled={busy}>
          {busy ? <Spinner size={12} /> : <Icon name="refresh" size={ICON_SIZES.sm} />}
          <chakra.span marginLeft="1.5">{t("timelapseCaptureNow")}</chakra.span>
        </Button>
        {watches && watches.length > 0 && (
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("timelapseUsage", { size: formatBytes(totalTimelapseBytes(watches)) })}
          </chakra.span>
        )}
        {notice && (
          <chakra.span fontSize="xs" color="app.textSecondary" role="status">
            {notice}
          </chakra.span>
        )}
      </Flex>
      {actionError && (
        <Box px="4" pt="2">
          <ErrorNote role="alert" whiteSpace="pre-wrap">
            {actionError}
          </ErrorNote>
        </Box>
      )}

      {loadError ? (
        <EmptyState
          icon="warning"
          title={t("timelapseLoadError", { error: loadError })}
          action={{ label: t("timelapseRetry"), onClick: () => void reload() }}
        />
      ) : watches === null ? (
        <Flex align="center" gap="2" px="4" py="3">
          <Spinner size={14} />
        </Flex>
      ) : watches.length === 0 ? (
        <EmptyState
          icon="clock"
          title={t("timelapseEmptyTitle")}
          description={t("timelapseEmptyDescription", { limit: 5000 })}
        />
      ) : (
        <Flex flex="1" minH={0}>
          <chakra.ul
            listStyleType="none"
            margin="0"
            p="2"
            w="240px"
            flexShrink={0}
            overflowY="auto"
            borderRight="1px solid"
            borderColor="app.border"
            display="flex"
            flexDirection="column"
            gap="1"
            aria-label={t("timelapseWatchListAria")}
          >
            {watches.map((w) => {
              const active = w.id === selected?.id;
              return (
                <li key={w.id}>
                  <chakra.button
                    type="button"
                    width="100%"
                    textAlign="left"
                    display="flex"
                    flexDirection="column"
                    gap="0.5"
                    px="2"
                    py="1.5"
                    borderRadius="sm"
                    borderWidth="1px"
                    borderColor={active ? "app.accent" : "transparent"}
                    bg={active ? "app.hover" : "transparent"}
                    cursor="pointer"
                    _hover={{ bg: "app.hover" }}
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedId(w.id);
                      setPair(null);
                    }}
                  >
                    <chakra.span fontFamily="var(--font-mono)" fontSize="sm" color="app.text">
                      {w.table}
                    </chakra.span>
                    <chakra.span fontSize="xs" color="app.textMuted">
                      {w.database} · {t("timelapseGenerationCount", { count: w.generations.length })}
                      {!w.active && ` · ${t("timelapseInactive")}`}
                      {w.partial && ` · ${t("timelapsePartial")}`}
                    </chakra.span>
                  </chakra.button>
                </li>
              );
            })}
          </chakra.ul>

          {selected && (
            <Box flex="1" minW={0} overflow="auto" px="4" py="3" display="flex" flexDirection="column" gap="3">
              <Flex align="center" gap="2" flexWrap="wrap">
                <Icon name="table" size={ICON_SIZES.md} />
                <chakra.span fontFamily="var(--font-mono)" fontSize="sm">
                  {selected.database}.{selected.table}
                </chakra.span>
                <Box flex="1" />
                <Button type="button" variant="dangerOutline" size="sm" onClick={() => void unwatch(selected)}>
                  {selected.active ? t("timelapseUnwatch") : t("timelapseDeleteDataOk")}
                </Button>
              </Flex>

              {generations.length < 2 || !effectivePair ? (
                <chakra.p fontSize="sm" color="app.textMuted">
                  {t("timelapseNeedTwo")}
                </chakra.p>
              ) : (
                <Flex align="center" gap="2" flexWrap="wrap">
                  <Select
                    maxW="320px"
                    aria-label={t("timelapseFrom")}
                    value={String(effectivePair.fromId)}
                    onChange={(e) => setPair({ fromId: Number(e.target.value), toId: effectivePair.toId })}
                  >
                    {generations.map((g, i) => (
                      <option key={g.id} value={g.id}>
                        {genLabel(g, i)}
                      </option>
                    ))}
                  </Select>
                  <Icon name="chevron-right" size={ICON_SIZES.sm} />
                  <Select
                    maxW="320px"
                    aria-label={t("timelapseTo")}
                    value={String(effectivePair.toId)}
                    onChange={(e) => setPair({ fromId: effectivePair.fromId, toId: Number(e.target.value) })}
                  >
                    {generations.map((g, i) => (
                      <option key={g.id} value={g.id}>
                        {genLabel(g, i)}
                      </option>
                    ))}
                  </Select>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPair(null)}>
                    {t("timelapseLatestVsPrevious")}
                  </Button>
                </Flex>
              )}

              {diffError && <ErrorNote role="alert">{t("timelapseDiffError", { error: diffError })}</ErrorNote>}
              {diffLoading && !diff && <Spinner size={14} />}

              {diff && counts && effectivePair && (
                <>
                  <Flex gap="2" flexWrap="wrap" align="center">
                    <Chip status="source_only">{t("timelapseCountAdded", { count: counts.added })}</Chip>
                    <Chip status="different">{t("timelapseCountChanged", { count: counts.changed })}</Chip>
                    <Chip status="target_only">{t("timelapseCountRemoved", { count: counts.removed })}</Chip>
                  </Flex>
                  {diff.partial && (
                    <chakra.p fontSize="xs" color="app.textWarning">
                      {t("timelapsePartialNote", { limit: 5000 })}
                    </chakra.p>
                  )}
                  {diff.columns_added.length > 0 && (
                    <chakra.p fontSize="xs" color="app.textSecondary">
                      {t("timelapseColumnsAdded", { columns: diff.columns_added.join(", ") })}
                    </chakra.p>
                  )}
                  {diff.columns_removed.length > 0 && (
                    <chakra.p fontSize="xs" color="app.textSecondary">
                      {t("timelapseColumnsRemoved", { columns: diff.columns_removed.join(", ") })}
                    </chakra.p>
                  )}
                  {masked && (
                    <chakra.p fontSize="xs" color="app.textMuted">
                      {t("timelapseMaskedNote")}
                    </chakra.p>
                  )}
                  {rows.length === 0 ? (
                    <chakra.p fontSize="sm" color="app.textMuted">
                      {t("timelapseNoChanges")}
                    </chakra.p>
                  ) : (
                    <chakra.table style={{ borderCollapse: "collapse" }} aria-label={t("timelapseDiffAria")}>
                      <chakra.thead>
                        <chakra.tr>
                          <chakra.th css={thCss}>{t("timelapseChangeColumn")}</chakra.th>
                          {diff.diff.columns.map((c) => (
                            <chakra.th key={c} css={thCss}>
                              {c}
                            </chakra.th>
                          ))}
                        </chakra.tr>
                      </chakra.thead>
                      <chakra.tbody>
                        {rows.map((r) => (
                          <chakra.tr
                            key={r.key}
                            data-kind={r.kind}
                            style={{ background: rowBackground(r.kind) }}
                          >
                            <chakra.td css={tdCss}>
                              <chakra.span
                                fontFamily="var(--font-sans, inherit)"
                                fontSize="xs"
                                fontWeight={600}
                                style={{ color: statusColors(KIND_STATUS[r.kind]).color }}
                              >
                                {kindLabel[r.kind]}
                              </chakra.span>
                            </chakra.td>
                            {r.cells.map((c) => (
                              <chakra.td
                                key={c.column}
                                css={tdCss}
                                data-changed={c.changed || undefined}
                                style={
                                  c.changed ? { background: semanticColorVar("warning", "subtle") } : undefined
                                }
                                color={c.masked ? "app.textMuted" : c.primaryKey ? "app.keyAccent" : undefined}
                              >
                                {c.text}
                                {c.before !== null && (
                                  <chakra.div fontSize="xs" color="app.textMuted" textDecoration="line-through">
                                    {c.before}
                                  </chakra.div>
                                )}
                              </chakra.td>
                            ))}
                          </chakra.tr>
                        ))}
                      </chakra.tbody>
                    </chakra.table>
                  )}
                </>
              )}
            </Box>
          )}
        </Flex>
      )}
    </Box>
  );
}
