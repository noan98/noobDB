import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { chakra } from "@chakra-ui/react";
import { transitions } from "../motion";

/**
 * ストリーミング実行中に表示する高さ 2px の indeterminate 進捗バー (#872)。
 *
 * 結果ペイン上端に置き、総件数が不明なストリーミング (クエリ実行・ドライラン
 * プレビュー・インポートなど) の「動いている」ことを Import / Dump / Export
 * モーダルの進捗表現と同じ語彙で示す。表示状態 (running) は呼び出し側の既存
 * 信号 (`tab.streaming` 等) をそのまま受け取り、二重管理しない。
 *
 * - 出入りは `transitions.progress` (motion.ts) の height/opacity 補間。
 * - スライドは既存の CSS keyframes `query-progress-slide` (App.css) を共有し、
 *   reduced-motion では App.css のメディアクエリと `MotionConfig` の両系統で
 *   自動的に静止・即時化される。
 */
export function StreamProgressBar({ active }: { active: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 2 }}
          exit={{ opacity: 0, height: 0 }}
          transition={transitions.progress}
          aria-hidden
          style={{
            position: "relative",
            flexShrink: 0,
            overflow: "hidden",
            background: "color-mix(in srgb, var(--accent) 16%, transparent)",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: "35%",
              borderRadius: "var(--radius-pill)",
              background: "var(--accent)",
              animation: "query-progress-slide var(--dur-progress-loop) var(--ease) infinite",
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * 総数が分かる処理 (インポート・影響分析の走査など) 向けの determinate 進捗バー (#1235)。
 *
 * 0〜1 の割合 (`value`、範囲外はクランプ) を受け、`transitions.progress` で
 * width を補間する。インポートと影響分析で同じ表現になるよう単一ソース化している。
 * reduced-motion では補間せず即時反映する (`MotionConfig` は width を抑制しない)。
 * 進捗の文言は呼び出し側が併記し、バー自体は装飾 (`aria-hidden`)。
 */
export function DeterminateProgressBar({ value }: { value: number }) {
  const reduced = useReducedMotion() ?? false;
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <chakra.div aria-hidden h="8px" borderRadius="sm" bg="app.surfaceMuted" overflow="hidden">
      <motion.div
        style={{ height: "100%", background: "var(--accent)" }}
        animate={{ width: `${ratio * 100}%` }}
        transition={reduced ? { duration: 0 } : transitions.progress}
      />
    </chakra.div>
  );
}
