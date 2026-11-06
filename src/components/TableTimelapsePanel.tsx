import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, VisuallyHidden, type SystemStyleObject } from "@chakra-ui/react";
import { useReducedMotionConfig } from "motion/react";

import {
  api,
  type CellValue,
  type DiffStatus,
  type TableWatch,
  type TimelapseGenerationDiff,
  type TimelapseGenerationMeta,
} from "../api/tauri";
import { useLocale, useT } from "../i18n";
import { formatCaptured } from "../timelapseScrubber";
import { semanticColorVar } from "../semanticColors";
import { useSettings } from "../settings";
import {
  PLAYBACK_DWELL_MS,
  initialPlayback,
  pairAtStep,
  playbackMaxStep,
  playbackReducer,
  stepOfPair,
  type PlaybackAction,
} from "../timelapsePlayback";
import {
  buildTimelapseExportRows,
  buildTimelapseRows,
  countTimelapseDiff,
  isTimelapseDmlBlocked,
  timelapseRowsToJson,
  timelapseRowsToTable,
  resolveGenerationPair,
  summarizeCapture,
  totalTimelapseBytes,
  type TimelapseRowKind,
} from "../tableTimelapse";
import { resolveMaskedColumns } from "./columnMask";
import { TextExportButton } from "./TextExportButton";
import { TimelapseDmlModal } from "./TimelapseDmlModal";
import { tableToCsv } from "./tabularText";
import { useConfirm } from "./ConfirmDialog";
import { statusColors } from "./diffStatusColors";
import { EmptyState } from "./EmptyState";
import { errorIllustration, NoResultsIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import { ErrorNote } from "./modalForm";
import { rowKeyNote } from "../rowKey";
import { SkeletonRow, SkeletonTableRows } from "./Skeleton";
import { Spinner } from "./Spinner";
import { formatBytes } from "./tableSize";
import { TimelapseRowHistoryView } from "./TimelapseRowHistory";
import { Button } from "./ui";
import { Tooltip } from "./Tooltip";
import { TimelapseScrubber } from "./TimelapseScrubber";
import { ListboxSelect } from "./ListboxSelect";
import { CountUpText } from "./CountUp";
import { useRowCrossfade } from "./useRowCrossfade";

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

/** 変更セルのフラッシュ (`.flash-ring::after`, apply-flash と同じ) の基準位置。 */
const flashCellCss: SystemStyleObject = { position: "relative" };

/** ウォッチ一覧の初回ロードスケルトン (#1174) のバー幅パターン。視覚的な単調さを
 *  避けるため周期させる (`ConnectionList` の `SKELETON_ROW_WIDTHS` と同じ発想)。 */
const TIMELAPSE_WATCH_SKELETON_WIDTHS = [72, 55, 68, 48];

/** 差分計算中の骨格 (#1174) に敷く列数。世代ペアが変わるたびに実列数
 *  (`diff.diff.columns.length + 1`) が変わり得るため、結果ペインの列数未知
 *  スケルトン (`resultSkeleton.ts`) と同じ考え方で固定の既定列数にする。 */
const TIMELAPSE_DIFF_SKELETON_COLUMNS = 4;

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
  const locale = useLocale();
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
  // 行の値の推移 (#1621)。ウォッチやペアを切り替えたら閉じる。
  const [historyKey, setHistoryKey] = useState<CellValue[] | null>(null);
  // タイムライン再生 (#2015)。段は選択中ペアから導くので、保持するのは再生中かどうかだけ。
  const [playing, setPlaying] = useState(false);
  // スクラバー / 再生 / ステップ送りを操作した後だけ変更セルをフラッシュする
  // (最初に開いただけの表示は静止のまま)。
  const [stepped, setStepped] = useState(false);
  // 表示中の差分がどのペアのものか。再生中は次の取得が終わるまで直前の差分を残すため、
  // 「現在のペアの差分が出揃ったか」の判定に使う。
  const [diffFor, setDiffFor] = useState<{ fromId: number; toId: number } | null>(null);
  const reduced = useReducedMotionConfig() ?? false;
  // 段送り (再生 / スクラバー / ←→) で次のペアへ移るとき、直前の差分を残したまま取得する
  // ための印。差分 effect が読んだら false に戻す。`playing` とは切り離してある (最終段へ
  // 入る瞬間に playing が false になっても差分を消さないため)。
  const keepDiffRef = useRef(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は本体では使わず、親からの更新要求で一覧を取り直すためのトリガー
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
    // 直前のペアの差分は破棄する。残すと取得が終わるまで古い件数と行が新しい結果に
    // 見えてしまう (読み込み中の表示は diff が無いときに出る, #1534)。
    // ただし段送りでは、直前の差分を残して次の差分へクロスフェード / カウントアップさせる
    // (#2015)。残している間のグリッドは aria-busy + 減光で「更新中」と分かるようにする。
    const keep = keepDiffRef.current;
    keepDiffRef.current = false;
    if (!keep) setDiff(null);
    api
      .timelapseDiffGenerations(fromId, toId)
      .then((d) => {
        if (!cancelled) {
          setDiff(d);
          setDiffFor({ fromId, toId });
        }
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

  // ── タイムライン再生 (#2015) ──
  const maxStep = playbackMaxStep(generations);
  const currentStep = stepOfPair(generations, effectivePair) ?? 1;
  const applyPlayback = (action: PlaybackAction) => {
    const next = playbackReducer({ ...initialPlayback(currentStep, maxStep), playing }, action);
    setPlaying(next.playing);
    // 再生開始時も含め、ペアを現在の段 (隣接ペア) に合わせ直す (任意選択の非隣接ペアから始めない)。
    const p = pairAtStep(generations, next.step);
    if (p && (p.fromId !== fromId || p.toId !== toId)) {
      keepDiffRef.current = true;
      setPair(p);
      setHistoryKey(null);
    }
    setStepped(true);
  };
  const applyPlaybackRef = useRef(applyPlayback);
  applyPlaybackRef.current = applyPlayback;

  const diffSettled =
    diffFor !== null && diffFor.fromId === fromId && diffFor.toId === toId && !diffLoading && diff !== null;
  // 再生中: 現在のペアの差分が出揃ってから一定時間見せて次の段へ進む。取得中は進めない
  // (= 隣接ペアの取得は常に直列)。停止 / アンマウント / ペア変更で timer を破棄し、取得中の
  // 古い応答は上の差分 effect の `cancelled` で捨てる。
  useEffect(() => {
    if (!playing) return;
    if (diffError) {
      setPlaying(false);
      return;
    }
    if (!diffSettled) return;
    const timer = setTimeout(() => applyPlaybackRef.current({ type: "advance" }), PLAYBACK_DWELL_MS);
    return () => clearTimeout(timer);
  }, [playing, diffSettled, diffError]);
  // reduced-motion が有効になった / 段が無くなったら再生しない。
  useEffect(() => {
    if (playing && (reduced || maxStep < 2)) setPlaying(false);
  }, [playing, reduced, maxStep]);

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
        // 非破壊の確認なので「今後は表示しない」を選べる (#1626)。
        rememberKey: "timelapseWatch",
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
        setActionError(summary.failed.map((f) => `${f.table}: ${f.error}`).join("\n"));
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
  const dmlBlocked = diff ? isTimelapseDmlBlocked(diff.diff.key_kind) : false;
  const keyNote = diff ? rowKeyNote(diff.diff.key_kind, diff.diff.primary_key) : null;

  // 差分の書き出し (#1539)。行モデルは画面と同じマスク判定を通し、マスク列は伏せ字のまま出す。
  const buildExport = (kind: "csv" | "json"): string => {
    if (!diff) return "";
    const exportRows = buildTimelapseExportRows(diff.diff, masked);
    if (kind === "json") {
      return timelapseRowsToJson(exportRows, {
        table: diff.diff.table,
        fromCapturedAt: diff.from_captured_at,
        toCapturedAt: diff.to_captured_at,
      });
    }
    const table = timelapseRowsToTable(
      exportRows,
      [
        t("timelapseExportColKind"),
        t("timelapseExportColKey"),
        t("timelapseExportColColumn"),
        t("timelapseExportColBefore"),
        t("timelapseExportColAfter"),
      ],
      {
        added: t("timelapseKindAdded"),
        removed: t("timelapseKindRemoved"),
        changed: t("timelapseKindChanged"),
      },
    );
    return tableToCsv(table.header, table.rows);
  };

  // 再現用 DML のプレビュー (#1624)。マスク前の値は伏せ字判定した列を除いて SQL に書かない。
  const [dmlOpen, setDmlOpen] = useState(false);
  const dmlRows = useMemo(() => (diff ? buildTimelapseExportRows(diff.diff, null) : []), [diff]);
  const maskedColumnSet = useMemo(
    () => new Set(diff ? diff.diff.columns.filter((_, i) => masked?.[i]) : []),
    [diff, masked],
  );

  // 段送りのたびにグリッドを軽くクロスフェードする (結果グリッドと同じ `useRowCrossfade`)。
  const gridTbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const diffToken = diff ? `${diff.from_captured_at}|${diff.to_captured_at}` : "";
  useRowCrossfade(gridTbodyRef, { sort: stepped ? diffToken : "", filter: "" }, String(selected?.id ?? ""));

  const kindLabel: Record<TimelapseRowKind, string> = {
    added: t("timelapseKindAdded"),
    removed: t("timelapseKindRemoved"),
    changed: t("timelapseKindChanged"),
  };

  const genLabel = (g: TimelapseGenerationMeta, i: number) =>
    `${i === 0 ? `${t("timelapseLatest")} · ` : ""}${formatCaptured(g.captured_at, locale)} (${t(
      "timelapseRows",
      {
        count: g.row_count,
      },
    )}${g.truncated ? ` · ${t("timelapsePartial")}` : ""})`;

  return (
    <Box flex="1" minH={0} display="flex" flexDirection="column">
      {dialog}
      {dmlOpen && diff && selected && (
        <TimelapseDmlModal
          rows={dmlRows}
          maskedColumns={maskedColumnSet}
          driver={selected.driver}
          database={selected.database}
          table={diff.diff.table}
          keyKind={diff.diff.key_kind}
          onClose={() => setDmlOpen(false)}
        />
      )}
      <Flex
        align="center"
        gap="2"
        px="4"
        py="2"
        borderBottom="1px solid"
        borderColor="app.border"
        flexWrap="wrap"
      >
        <Button type="button" variant="secondary" size="sm" onClick={() => void captureNow()} disabled={busy}>
          {busy ? <Spinner size={12} decorative /> : <Icon name="refresh" size={ICON_SIZES.sm} />}
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
          illustration={errorIllustration(loadError)}
          icon="warning"
          title={t("timelapseLoadError", { error: loadError })}
          action={{ label: t("timelapseRetry"), onClick: () => void reload() }}
        />
      ) : watches === null ? (
        // 初回ロード中 (まだウォッチ一覧を取得していない): 中央の bare Spinner
        // ではなく、後に来る左ペインのリスト構造をシマーで予兆表示する
        // (#846 の横展開、#1174)。
        <Flex flex="1" minH={0} role="status" aria-live="polite">
          <VisuallyHidden>{t("timelapseLoading")}</VisuallyHidden>
          <Box
            w="240px"
            flexShrink={0}
            p="2"
            borderRight="1px solid"
            borderColor="app.border"
            display="flex"
            flexDirection="column"
            gap="1"
            aria-hidden
          >
            {TIMELAPSE_WATCH_SKELETON_WIDTHS.map((w, i) => (
              <SkeletonRow key={i} style={{ width: `${w}%`, animationDelay: `${i * 0.08}s` }} />
            ))}
          </Box>
        </Flex>
      ) : watches.length === 0 ? (
        <EmptyState
          illustration={<NoResultsIllustration />}
          brandHalo
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
                      setHistoryKey(null);
                      setPlaying(false);
                      setStepped(false);
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
            <Box
              flex="1"
              minW={0}
              overflow="auto"
              px="4"
              py="3"
              display="flex"
              flexDirection="column"
              gap="3"
            >
              <Flex align="center" gap="2" flexWrap="wrap">
                <Icon name="table" size={ICON_SIZES.md} />
                <chakra.span fontFamily="var(--font-mono)" fontSize="sm">
                  {selected.database}.{selected.table}
                </chakra.span>
                <Box flex="1" />
                <Button
                  type="button"
                  variant="dangerOutline"
                  size="sm"
                  onClick={() => void unwatch(selected)}
                >
                  {selected.active ? t("timelapseUnwatch") : t("timelapseDeleteDataOk")}
                </Button>
              </Flex>

              {generations.length < 2 || !effectivePair ? (
                <chakra.p textStyle="body" color="app.textMuted">
                  {t("timelapseNeedTwo")}
                </chakra.p>
              ) : (
                <Flex align="center" gap="2" flexWrap="wrap">
                  <ListboxSelect
                    css={{ width: "100%", maxWidth: "320px" }}
                    ariaLabel={t("timelapseFrom")}
                    value={String(effectivePair.fromId)}
                    options={generations.map((g, i) => ({ value: String(g.id), label: genLabel(g, i) }))}
                    onChange={(v) => {
                      setPlaying(false);
                      setPair({ fromId: Number(v), toId: effectivePair.toId });
                    }}
                  />
                  <Icon name="chevron-right" size={ICON_SIZES.sm} />
                  <ListboxSelect
                    css={{ width: "100%", maxWidth: "320px" }}
                    ariaLabel={t("timelapseTo")}
                    value={String(effectivePair.toId)}
                    options={generations.map((g, i) => ({ value: String(g.id), label: genLabel(g, i) }))}
                    onChange={(v) => {
                      setPlaying(false);
                      setPair({ fromId: effectivePair.fromId, toId: Number(v) });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPlaying(false);
                      setPair(null);
                    }}
                  >
                    {t("timelapseLatestVsPrevious")}
                  </Button>
                </Flex>
              )}

              {maxStep >= 2 && effectivePair && (
                <Flex
                  align="center"
                  gap="2"
                  flexWrap="wrap"
                  role="group"
                  aria-label={t("timelapseScrubAria")}
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      applyPlayback(playing ? { type: "pause" } : { type: "play", reducedMotion: reduced })
                    }
                    disabled={reduced || diffError !== null}
                    minW="28"
                  >
                    {!playing && <Icon name="play" size={ICON_SIZES.sm} />}
                    <chakra.span marginLeft={playing ? 0 : "1.5"}>
                      {playing ? t("timelapsePause") : t("timelapsePlay")}
                    </chakra.span>
                  </Button>
                  <Tooltip label={t("timelapseStepPrev")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("timelapseStepPrev")}
                      disabled={currentStep <= 1}
                      onClick={() => applyPlayback({ type: "stepBy", delta: -1 })}
                    >
                      <Icon name="chevron-left" size={ICON_SIZES.sm} />
                    </Button>
                  </Tooltip>
                  <TimelapseScrubber
                    generations={generations}
                    step={currentStep}
                    maxStep={maxStep}
                    onSeek={(step) => applyPlayback({ type: "seek", step })}
                  />
                  <Tooltip label={t("timelapseStepNext")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("timelapseStepNext")}
                      disabled={currentStep >= maxStep}
                      onClick={() => applyPlayback({ type: "stepBy", delta: 1 })}
                    >
                      <Icon name="chevron-right" size={ICON_SIZES.sm} />
                    </Button>
                  </Tooltip>
                  <chakra.span textStyle="caption">
                    <chakra.span textStyle="numeric">
                      {t("timelapseScrubStep", { step: currentStep, max: maxStep })}
                    </chakra.span>
                  </chakra.span>
                  {reduced && (
                    <chakra.p margin={0} w="100%" textStyle="caption" color="app.textMuted">
                      {t("timelapsePlayReducedMotion")}
                    </chakra.p>
                  )}
                </Flex>
              )}

              {diffError && (
                <ErrorNote role="alert">{t("timelapseDiffError", { error: diffError })}</ErrorNote>
              )}
              {diffLoading && !diff && (
                // 差分計算中: 列数は世代ペアが変わるたびに変わり得るため、結果
                // ペインの列数未知スケルトンと同じ既定列数で骨格を出す
                // (#846 / #1071 の横展開、#1174)。
                <chakra.table
                  width="100%"
                  style={{ borderCollapse: "collapse" }}
                  role="status"
                  aria-live="polite"
                >
                  <VisuallyHidden as="caption">{t("timelapseDiffLoading")}</VisuallyHidden>
                  <chakra.tbody aria-hidden>
                    <SkeletonTableRows columns={TIMELAPSE_DIFF_SKELETON_COLUMNS} rows={3} />
                  </chakra.tbody>
                </chakra.table>
              )}

              {diff && counts && effectivePair && (
                <>
                  <Flex gap="2" flexWrap="wrap" align="center">
                    <Chip status="source_only">
                      <CountUpText
                        values={[counts.added]}
                        render={([n]) => t("timelapseCountAdded", { count: n })}
                      />
                    </Chip>
                    <Chip status="different">
                      <CountUpText
                        values={[counts.changed]}
                        render={([n]) => t("timelapseCountChanged", { count: n })}
                      />
                    </Chip>
                    <Chip status="target_only">
                      <CountUpText
                        values={[counts.removed]}
                        render={([n]) => t("timelapseCountRemoved", { count: n })}
                      />
                    </Chip>
                    <Box flex="1" />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setDmlOpen(true)}
                      // 前の差分を残している間 (取得中) は、別ペアの SQL / 書き出しを作らせない。
                      disabled={rows.length === 0 || dmlBlocked || !diffSettled}
                      title={dmlBlocked ? t("timelapseDmlRowidBlocked") : undefined}
                    >
                      {t("timelapseDmlButton")}
                    </Button>
                    <TextExportButton
                      filenameBase={`timelapse-${diff.diff.table}`}
                      disabled={rows.length === 0 || !diffSettled}
                      formats={[
                        { id: "csv", label: "CSV", build: () => buildExport("csv") },
                        { id: "json", label: "JSON", build: () => buildExport("json") },
                      ]}
                    />
                  </Flex>
                  {keyNote && (
                    <chakra.p margin={0} textStyle="caption" color="app.textMuted">
                      {t(keyNote.key, keyNote.vars)}
                    </chakra.p>
                  )}
                  {dmlBlocked && (
                    <chakra.p margin={0} textStyle="caption" color="app.textMuted">
                      {t("timelapseDmlRowidBlocked")}
                    </chakra.p>
                  )}
                  {diff.key_changed && (
                    <chakra.p margin={0} textStyle="caption" color="app.textWarning">
                      {t("timelapseKeyChanged")}
                    </chakra.p>
                  )}
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
                  {masked && <chakra.p textStyle="caption">{t("timelapseMaskedNote")}</chakra.p>}
                  {historyKey && selected && (
                    <TimelapseRowHistoryView
                      watchId={selected.id}
                      rowKey={historyKey}
                      onClose={() => setHistoryKey(null)}
                    />
                  )}
                  {rows.length === 0 ? (
                    <chakra.p textStyle="body" color="app.textMuted">
                      {t("timelapseNoChanges")}
                    </chakra.p>
                  ) : (
                    <chakra.table
                      style={{ borderCollapse: "collapse" }}
                      aria-label={t("timelapseDiffAria")}
                      aria-busy={!diffSettled || undefined}
                      opacity={diffSettled ? undefined : 0.6}
                    >
                      <chakra.thead>
                        <chakra.tr>
                          <chakra.th css={thCss}>{t("timelapseChangeColumn")}</chakra.th>
                          <chakra.th css={thCss}>
                            <VisuallyHidden>{t("timelapseRowHistoryColumn")}</VisuallyHidden>
                          </chakra.th>
                          {diff.diff.columns.map((c) => (
                            <chakra.th key={c} css={thCss}>
                              {c}
                            </chakra.th>
                          ))}
                        </chakra.tr>
                      </chakra.thead>
                      <chakra.tbody ref={gridTbodyRef}>
                        {rows.map((r) => (
                          <chakra.tr
                            // diffToken を混ぜるのは、段が変わるたびに行を作り直して
                            // 変更セルの flash-ring (CSS アニメ) を再生し直すため。
                            key={`${diffToken}:${r.key}`}
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
                            <chakra.td css={tdCss}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={t("timelapseRowHistoryOpen", { key: JSON.stringify(r.rawKey) })}
                                onClick={() => setHistoryKey(r.rawKey)}
                              >
                                <Icon name="clock" size={ICON_SIZES.sm} />
                              </Button>
                            </chakra.td>
                            {r.cells.map((c) => (
                              <chakra.td
                                key={c.column}
                                css={stepped && c.changed ? { ...tdCss, ...flashCellCss } : tdCss}
                                className={stepped && c.changed ? "flash-ring" : undefined}
                                data-changed={c.changed || undefined}
                                style={
                                  c.changed
                                    ? { background: semanticColorVar("warning", "subtle") }
                                    : undefined
                                }
                                color={
                                  c.masked ? "app.textMuted" : c.primaryKey ? "app.keyAccent" : undefined
                                }
                              >
                                {c.text}
                                {c.before !== null && (
                                  <chakra.div
                                    fontSize="xs"
                                    color="app.textMuted"
                                    textDecoration="line-through"
                                  >
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
