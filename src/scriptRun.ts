// `.sql` スクリプトファイル実行 (#973) の純ロジック。
//
// `ScriptRunModal.tsx` (副作用・描画) と対になる。オプションの排他制御・進捗率・
// 結果サマリの組み立てをここへ出し、Vitest でユニットテストする。

import type {
  ScriptAnalysis,
  ScriptDangerKind,
  ScriptDoneEvent,
  ScriptErrorEvent,
  ScriptOptions,
  ScriptProgressEvent,
} from "./api/tauri";

export const DEFAULT_SCRIPT_OPTIONS: ScriptOptions = {
  continueOnError: false,
  wrapInTransaction: false,
  encoding: null,
  startAtStatement: 0,
  skipStatements: [],
};

/** 排他制御つきで切り替えられる真偽オプション。 */
export type ScriptToggleKey = "continueOnError" | "wrapInTransaction";

/**
 * オプションを 1 つ切り替える。`continueOnError` と `wrapInTransaction` は排他
 * (all-or-nothing のトランザクションで「失敗をスキップして続行」は成り立たない —
 * バックエンドも両方 true を拒否する) なので、片方を ON にしたらもう片方を OFF にする。
 */
export function toggleScriptOption(
  opts: ScriptOptions,
  key: ScriptToggleKey,
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
  /** 停止した文の通し番号 (トランザクション制御文を含む)。事前確認の一覧・再開位置と同じ番号。 */
  index: number | null;
  sql: string | null;
  rolledBack: boolean;
} {
  return {
    message: e.failure?.error ?? e.error,
    line: e.failure?.line ?? null,
    index: e.failure?.index ?? null,
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

// ── 事前確認 (ドライラン、#1535) ────────────────────────────────────────────

/** 開始文番号の入力欄の文字列を 0 以上の整数へ。空・不正・負は 0 (先頭から)。 */
export function parseStartAt(text: string): number {
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** 除外集合の 1 文を切り替えた新しい集合を返す。 */
export function toggleExcluded(excluded: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(excluded);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/** `ScriptOptions.skipStatements` へ渡す昇順の配列。 */
export function skipList(excluded: ReadonlySet<number>): number[] {
  return [...excluded].sort((a, b) => a - b);
}

/** 一覧に載っている危険文を全部除外した (または全部戻した) 集合。 */
export function setDangerousExcluded(
  excluded: ReadonlySet<number>,
  analysis: Pick<ScriptAnalysis, "dangerous">,
  exclude: boolean,
): Set<number> {
  const next = new Set(excluded);
  for (const d of analysis.dangerous) {
    if (exclude) next.add(d.index);
    else next.delete(d.index);
  }
  return next;
}

/**
 * 実行すると流れる危険文の数。一覧 (`dangerous`) に載っている文は除外・開始位置より前の
 * ものを引き、一覧に載らなかった分 (`dangerousTotal` − 一覧の件数) は個別に除外できず、
 * 開始位置も判別できないので、そのまま「流れる」ものとして数える (fail-closed)。
 */
export function remainingDangerous(
  analysis: Pick<ScriptAnalysis, "dangerous" | "dangerousTotal">,
  excluded: ReadonlySet<number>,
  startAt: number,
): number {
  const unlisted = Math.max(0, analysis.dangerousTotal - analysis.dangerous.length);
  const listed = analysis.dangerous.filter(
    (d) => !excluded.has(d.index) && !(startAt > 1 && d.index < startAt),
  ).length;
  return unlisted + listed;
}

/** 件数が 1 以上の危険種別だけを、固定の表示順で返す。 */
export function dangerKindCounts(
  analysis: Pick<ScriptAnalysis, "dangerCounts">,
): { kind: ScriptDangerKind; count: number }[] {
  const order: ScriptDangerKind[] = ["drop", "truncate", "deleteNoWhere", "updateNoWhere"];
  return order
    .map((kind) => ({ kind, count: analysis.dangerCounts[kind] }))
    .filter((e) => e.count > 0);
}

/** 先頭の一覧が全文を網羅していない (`head` が `totalStatements` より短い)。 */
export function analysisIsTruncated(analysis: Pick<ScriptAnalysis, "head" | "totalStatements">): boolean {
  return analysis.head.length < analysis.totalStatements;
}

/**
 * 停止エラーから「この文から再開」できる開始位置を返す。再開できないときは `null`:
 * 原因の文が分からない (準備段階の失敗)、ロールバックされた (その範囲の文が取り消されて
 * いるので、途中からだと欠けたまま進む)、全体をトランザクションで包んでいた (全部が
 * 取り消される)。`skipFailed` なら失敗した文自体を飛ばして次の文から再開する。
 */
export function resumeStartAt(
  e: Pick<ScriptErrorEvent, "failure" | "rolledBack">,
  options: Pick<ScriptOptions, "wrapInTransaction">,
  skipFailed = false,
): number | null {
  if (!e.failure || e.rolledBack || options.wrapInTransaction) return null;
  return skipFailed ? e.failure.index + 1 : e.failure.index;
}
