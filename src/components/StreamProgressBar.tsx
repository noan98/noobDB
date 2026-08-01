import { AnimatePresence, motion } from "motion/react";
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
