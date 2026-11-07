import { useEffect, useState, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import { estimateEtaMs, formatDuration, progressRatio, ratePerSecond } from "../progressEta";
import type { SemanticRole } from "../semanticColors";
import { Callout } from "./Callout";
import { DeterminateProgressBar } from "./StreamProgressBar";
import { StatTile } from "./StatTile";

/**
 * 長時間 I/O (ダンプ・取り込み・エクスポート・データ転送・チャンク DML) の進捗と完了表示の
 * 共通部品 (#2122)。DumpModal で確立した「進捗バー + StatTile + 結果 Callout」を画面ごとに
 * 手組みせず、done / total / 経過 ms と追加の StatTile を渡すだけで揃える。
 *
 * - 総数 (`total`) が分かる間だけバーと % と ETA を出す。不定ならタイルだけ (件数・経過・速度)。
 * - ETA は算出できるまで `progressEtaPending` を出す (`progressEta.ts`)。
 * - 終了後は `tone` でバーを意味色に止め、`JobOutcome` が Callout (アイコン + 文言) で結果を示す。
 */

export interface JobStat {
  label: string;
  value: number | string;
  sub?: string;
}

export interface JobProgressDetailProps {
  /** 処理済み件数。 */
  done: number;
  /** 総件数。不定なら null (バーと ETA を出さない)。 */
  total: number | null;
  elapsedMs: number;
  /** 実行中か。実行中のときだけ ETA を出す。 */
  running?: boolean;
  /** 終了後にバーを止める意味色。 */
  tone?: SemanticRole;
  /** 完了として 100% で示す (総数が分かっていて処理が最後まで届いたとき)。 */
  full?: boolean;
  /** 経過時間タイルの前に並べる追加のタイル。 */
  stats?: JobStat[];
  /**
   * 1 秒あたりの行数タイル。バーの分子 `done` とは別に、行数の累計 (`count`) を渡す
   * (done がテーブル数・シート数のことがあるため)。渡したときだけ表示する。
   */
  rate?: { label: string; count: number };
  testId?: string;
  barTestId?: string;
  statsTestId?: string;
}

/** バー + StatTile 行。 */
export function JobProgressDetail({
  done,
  total,
  elapsedMs,
  running,
  tone,
  full,
  stats = [],
  rate: rateSpec,
  testId,
  barTestId,
  statsTestId,
}: JobProgressDetailProps) {
  const t = useT();
  const ratio = full && total !== null && total > 0 ? 1 : progressRatio(done, total);
  const etaMs = running ? estimateEtaMs(done, total, elapsedMs) : null;
  // 総数が分からないときは ETA を算出できないので、行を出さず経過だけにする。
  const etaText =
    running && ratio !== null
      ? etaMs === null
        ? t("progressEtaPending")
        : t("progressEta", { time: formatDuration(etaMs) })
      : undefined;
  const rate = rateSpec ? ratePerSecond(rateSpec.count, elapsedMs) : null;
  return (
    <chakra.div display="flex" flexDirection="column" gap="2" data-testid={testId}>
      {ratio !== null && (
        <chakra.div display="flex" alignItems="center" gap="3" data-testid={barTestId}>
          <chakra.div flex="1">
            <DeterminateProgressBar value={ratio} tone={tone} />
          </chakra.div>
          <chakra.span textStyle="numeric" minW="4ch" textAlign="right">
            {t("progressPercent", { percent: Math.floor(ratio * 100) })}
          </chakra.span>
        </chakra.div>
      )}
      <chakra.div display="flex" gap="2" flexWrap="wrap" data-testid={statsTestId}>
        {stats.map((s) => (
          <StatTile key={s.label} label={s.label} value={s.value} sub={s.sub} />
        ))}
        {rateSpec && (
          <StatTile
            label={rateSpec.label}
            value={rate === null ? "-" : t("jobRateValue", { rate: Math.round(rate).toLocaleString() })}
          />
        )}
        <StatTile label={t("jobStatElapsed")} value={formatDuration(elapsedMs)} sub={etaText} />
      </chakra.div>
    </chakra.div>
  );
}

const OUTCOME_TONE: Record<"done" | "cancelled" | "error", SemanticRole> = {
  done: "success",
  cancelled: "warning",
  error: "danger",
};

/**
 * 終了後の表示: バーを意味色で止め (`detail`)、結果を Callout (アイコン + 文言) で示す。
 * `children` は Callout の下に置く (取り込みのスキップ行の保存ボタンなど)。
 */
export function JobOutcome({
  kind,
  tone,
  detail,
  message,
  children,
  testId,
}: {
  kind: "done" | "cancelled" | "error";
  /** 既定は kind から決める (完了 success / 中断 warning / 失敗 danger)。スキップ有りの完了は warning にできる。 */
  tone?: SemanticRole;
  /** 進捗の最終値。無ければ Callout だけ。 */
  detail?: JobProgressDetailProps | null;
  message: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  const role = tone ?? OUTCOME_TONE[kind];
  return (
    <chakra.div display="flex" flexDirection="column" gap="2" data-testid={testId}>
      {detail && <JobProgressDetail {...detail} running={false} tone={role} full={kind === "done"} />}
      <Callout tone={role} role={kind === "error" ? "alert" : "status"}>
        {message}
      </Callout>
      {children}
    </chakra.div>
  );
}

/** 進捗ブロックの出入り (`variants.collapse`)。reduced-motion は MotionConfig が即時化する。 */
export function JobPresence({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="job"
          initial={variants.collapse.initial}
          animate={variants.collapse.animate}
          exit={variants.collapse.exit}
          transition={transitions.enter}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * 実行中の経過時間 (ms)。`running` が true の間 1 秒ごとに更新し、false になったら
 * その時点の値で止める (終了後の結果表示が最終の経過時間を出せる)。
 */
export function useJobClock(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - t0), 1000);
    return () => {
      clearInterval(id);
      setElapsed(Date.now() - t0);
    };
  }, [running]);
  return elapsed;
}
