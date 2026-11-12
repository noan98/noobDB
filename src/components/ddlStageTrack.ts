import type { DdlStep } from "./onlineDdl";
import type { DdlRunReport } from "./onlineDdlRunner";

/**
 * 段階トラック (`DdlStageTrack`, #2263) の純ロジック。各段階の状態とロック強度の分類だけを持ち、
 * 描画は `DdlStageTrack.tsx` が担う。実行の進捗 (`onProgress(done, total)`) と失敗レポートから導く。
 */

/** 段階の状態。未実行 / 実行中 / 完了 / 失敗。 */
export type StageStatus = "pending" | "running" | "done" | "failed";

/** ロック強度のバッジ。`outsideTx` は CONCURRENTLY のようにトランザクション外で流す段階。 */
export type StageLock = "shortExclusive" | "exclusive" | "concurrent" | "outsideTx";

/** 実行の様子。`plan` は実行前の計画表示、`running` は進捗、`failed` は失敗レポート。 */
export type StageTrackState =
  | { kind: "plan" }
  | { kind: "running"; done: number }
  | { kind: "failed"; failedIndex: number };

/** 段階ごとの状態を並べて返す。失敗した段階より後ろは「未実行」のまま。 */
export function stageStatuses(total: number, state: StageTrackState): StageStatus[] {
  return Array.from({ length: total }, (_, i): StageStatus => {
    if (state.kind === "plan") return "pending";
    if (state.kind === "running") return i < state.done ? "done" : i === state.done ? "running" : "pending";
    return i < state.failedIndex ? "done" : i === state.failedIndex ? "failed" : "pending";
  });
}

/** 失敗レポートから `StageTrackState` を作る。失敗でない (または段階が特定できない) ときは null。 */
export function failedTrackState(report: DdlRunReport): StageTrackState | null {
  if (report.ok || report.failedIndex === null) return null;
  return { kind: "failed", failedIndex: report.failedIndex };
}

/**
 * 段階が持つロックの強さ。CONCURRENTLY はトランザクション外 (強いロックを取らず既存トランザクションの終了を待つ)、
 * VALIDATE は SHARE UPDATE EXCLUSIVE で読み書きと並行して全件を検証、NOT VALID の追加 / SET NOT NULL は短い排他ロック、それ以外は排他ロック。
 */
export function stageLock(step: DdlStep): StageLock {
  if (!step.transactional) return "outsideTx";
  if (step.phase === "validate") return "concurrent";
  // 短いのは NOT VALID の追加と SET NOT NULL (検証済みの CHECK があるので走査しない)。通常の ALTER は書き換えなどで
  // 強いロックを長く持ちうるので「短い」とは言わない。
  if (step.phase === "addNotValid" || step.phase === "setNotNull") return "shortExclusive";
  return "exclusive";
}
