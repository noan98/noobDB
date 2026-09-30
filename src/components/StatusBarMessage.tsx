import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { durations, variants } from "../motion";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

/**
 * フッターステータスバーの状態アイコンと文言 (#1213)。
 *
 * ほぼ全操作で更新される最高頻度の面なので、`durations.fast` の短尺で
 * 「running → success / warning」の切替に自然に目が行くようにする。
 * アイコンは `variants.fadeScale`、文言は `AnimatePresence mode="wait"` +
 * `variants.slideUp` (key = メッセージ内容) で差し替える (MultiStateBadge と同じ流儀)。
 * reduced-motion は MotionConfig / data-motion で自動的に抑制される。
 */

/** ステータスバーで描くアイコンの種類。null は「アイコン無し」。 */
export type StatusBarIconKind = "running" | "success" | "warning" | null;

/** 高頻度更新向けの短尺 transition (新しい値は作らず durations.fast を使う)。 */
const STATUS_TRANSITION = { duration: durations.fast } as const;

const MotionSpan = chakra(
  motion.span,
  {},
  { forwardProps: ["transition", "initial", "animate", "exit"] },
);

/** running(Spinner) / success(check) / warning をクロスフェードするアイコン。 */
export function StatusBarIcon({ kind }: { kind: StatusBarIconKind }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {kind !== null && (
        <MotionSpan
          key={kind}
          initial={variants.fadeScale.initial}
          animate={variants.fadeScale.animate}
          exit={variants.fadeScale.exit}
          transition={STATUS_TRANSITION}
          display="inline-flex"
          alignItems="center"
        >
          {kind === "running" ? (
            <Spinner size={13} />
          ) : kind === "success" ? (
            <Icon name="check" />
          ) : (
            <Icon name="warning" />
          )}
        </MotionSpan>
      )}
    </AnimatePresence>
  );
}

/**
 * 単一行のステータス文言。メッセージの種類 (`messageKey`) が変わったときだけ
 * 下から差し替える。ストリーミング中の「N 行取得中…」のように同じメッセージの
 * 数値だけが高頻度で変わる更新ではアニメーションを再生せず、その場で書き換える
 * (バッチごとに exit を待つとちらつき、表示が遅れて見えるため)。
 * `messageKey` を省略した場合は文言そのものを key にする。
 */
export function StatusBarText({ text, messageKey }: { text: string; messageKey?: string }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <MotionSpan
        key={messageKey ?? text}
        initial={variants.slideUp.initial}
        animate={variants.slideUp.animate}
        exit={variants.slideUp.exit}
        transition={STATUS_TRANSITION}
        display="block"
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {text}
      </MotionSpan>
    </AnimatePresence>
  );
}
