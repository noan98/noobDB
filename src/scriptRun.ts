// `.sql` スクリプトファイル実行 (#973) の純ロジック。
//
// `ScriptRunModal.tsx` (副作用・描画) と対になる。オプションの排他制御・進捗率・
// 結果サマリの組み立てをここへ出し、Vitest でユニットテストする。

import type {
  ScriptDoneEvent,
  ScriptErrorEvent,
  ScriptOptions,
  ScriptProgressEvent,
} from "./api/tauri";

export const DEFAULT_SCRIPT_OPTIONS: ScriptOptions = {
  continueOnError: false,
  wrapInTransaction: false,
};

/**
 * オプションを 1 つ切り替える。`continueOnError` と `wrapInTransaction` は排他
 * (all-or-nothing のトランザクションで「失敗をスキップして続行」は成り立たない —
 * バックエンドも両方 true を拒否する) なので、片方を ON にしたらもう片方を OFF にする。
 */
export function toggleScriptOption(
  opts: ScriptOptions,
  key: keyof ScriptOptions,
): ScriptOptions {
  const next = { ...opts, [key]: !opts[key] };
  if (next[key]) {
    if (key === "continueOnError") next.wrapInTransaction = false;
    else next.continueOnError = false;
  }
  return next;
}

/** 読み込み済みバイト数による進捗率 (0〜1)。総バイト数が不明 (0) なら `null`。 */
export function scriptProgressRatio(p: Pick<ScriptProgressEvent, "bytesRead" | "totalBytes">): number | null {
  if (!Number.isFinite(p.totalBytes) || p.totalBytes <= 0) return null;
  const r = p.bytesRead / p.totalBytes;
  if (!Number.isFinite(r)) return null;
  return Math.min(1, Math.max(0, r));
}

/** 進捗率をパーセント整数に丸める (表示用)。 */
export function scriptProgressPercent(p: Pick<ScriptProgressEvent, "bytesRead" | "totalBytes">): number | null {
  const r = scriptProgressRatio(p);
  return r == null ? null : Math.floor(r * 100);
}

/** 実行完了後の結果の種別 (トースト・表示の出し分け用)。 */
export type ScriptOutcomeKind = "success" | "partial";

/** 完了イベントを「全文成功」か「一部失敗 (continue-on-error)」に分類する。 */
export function classifyScriptDone(e: Pick<ScriptDoneEvent, "failedCount">): ScriptOutcomeKind {
  return e.failedCount > 0 ? "partial" : "success";
}

/**
 * 完了イベントで一覧に載らなかった失敗の件数 (バックエンドは失敗一覧を上限件数で
 * 打ち切り、件数だけは `failedCount` で全件数える)。
 */
export function omittedFailureCount(e: Pick<ScriptDoneEvent, "failedCount" | "failures">): number {
  return Math.max(0, e.failedCount - e.failures.length);
}

/**
 * 停止エラーの要約。原因の文が分かれば行番号と SQL の先頭を添える。ロケール依存の
 * 文言は呼び出し側 (i18n) が持つので、ここでは素材だけを返す。
 */
export function describeScriptError(e: ScriptErrorEvent): {
  message: string;
  line: number | null;
  sql: string | null;
  rolledBack: boolean;
} {
  return {
    message: e.failure?.error ?? e.error,
    line: e.failure?.line ?? null,
    sql: e.failure?.sql ?? null,
    rolledBack: e.rolledBack,
  };
}

let scriptStreamSeq = 0;
/** 実行ごとに一意な stream id (進捗イベントの絞り込みとキャンセル対象)。 */
export function makeScriptStreamId(now: number = Date.now()): string {
  scriptStreamSeq += 1;
  return `script_${now.toString(36)}_${scriptStreamSeq.toString(36)}`;
}
