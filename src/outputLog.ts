import { useSyncExternalStore } from "react";
import type { I18nKey } from "./i18n";

/**
 * Bottom Panel の「出力」タブ (#1114) が表示する実行ログの共有ストア。
 *
 * エディタから実行した文 1 つにつき 1 行を残す (DataGrip / SSMS の Output と同じ役割)。
 * 結果グリッドは**最後の 1 回**の結果しか持たず、ステータスバーも次の実行で
 * 上書きされるため、「さっき流した UPDATE は何行に効いたか」「一括実行のどこで
 * 落ちたか」を後から確かめる置き場が無かった。
 *
 * クエリ履歴 (サイドバーの History / `api.listHistory`) との違い:
 * - 履歴 = **何を書いたか** (SQL の再利用が目的。永続化され、実行結果は持たない)
 * - 出力 = **何が起きたか** (このセッションの実行結果。件数・所要時間・エラー本文)
 *
 * 記録は `App.tsx` の実行経路が結果を受け取った地点で `pushOutput` を呼ぶだけで、
 * 実行経路 (DB アクセス) そのものには手を入れない。自動リフレッシュの tick は
 * 「ユーザが実行した文」ではないので記録しない。
 *
 * 揮発性 (セッション内のみ) で上限件数を超えたら古い方から捨てる点は
 * `activityLog.ts` と揃えている。
 */

/** 実行の結末。 */
export type OutputOutcome =
  /** 結果セットを返した (SELECT など)。`rows` は取得した行数。 */
  | "rows"
  /** 結果セットを返さない文が成功した (DML / DDL)。`rows` は影響行数。 */
  | "affected"
  | "error"
  | "timeout"
  | "cancelled"
  /** 一括実行で手前の文が失敗したため実行しなかった。 */
  | "skipped";

export interface OutputEntry {
  id: number;
  /** 記録時刻 (epoch ミリ秒)。 */
  at: number;
  sql: string;
  outcome: OutputOutcome;
  /** `rows` / `affected` / 部分結果の行数。無い結末では null。 */
  rows: number | null;
  /** 所要時間。スキップなど実行していない結末では null。 */
  elapsedMs: number | null;
  /** エラー本文 (`error` / `timeout`)。 */
  error: string | null;
  /** 実行した接続の表示名。 */
  connection: string | null;
  /** 実行した DB (タブの DB → プロファイル既定)。 */
  database: string | null;
}

export type OutputInput = Omit<OutputEntry, "id" | "at">;

/** 保持する最大件数。 */
export const OUTPUT_LIMIT = 500;

/** 絞り込み。`problems` はエラー / タイムアウト / キャンセル / スキップ。 */
export type OutputFilter = "all" | "problems";

const PROBLEM_OUTCOMES: ReadonlySet<OutputOutcome> = new Set([
  "error",
  "timeout",
  "cancelled",
  "skipped",
]);

// ─────────────────────────────────────────────────────────────────────────────
// 純ロジック
// ─────────────────────────────────────────────────────────────────────────────

/** 先頭 (最新が先) に足し、`limit` を超えた古い分を捨てた新しい配列。 */
export function appendOutput(
  list: readonly OutputEntry[],
  entry: OutputEntry,
  limit: number = OUTPUT_LIMIT,
): OutputEntry[] {
  if (!(limit > 0)) return [];
  return [entry, ...list].slice(0, Math.floor(limit));
}

export function isProblemOutcome(outcome: OutputOutcome): boolean {
  return PROBLEM_OUTCOMES.has(outcome);
}

export function filterOutput(list: readonly OutputEntry[], filter: OutputFilter): OutputEntry[] {
  if (filter === "all") return [...list];
  return list.filter((e) => isProblemOutcome(e.outcome));
}

export function countProblems(list: readonly OutputEntry[]): number {
  return list.reduce((n, e) => (isProblemOutcome(e.outcome) ? n + 1 : n), 0);
}

/**
 * 一覧の 1 行に出す SQL の見出し。空白を 1 つに潰し、`max` 文字を超えたら
 * 末尾を `…` にする (全文はツールチップ / コピーで確認する)。
 */
export function sqlHeadline(sql: string, max = 160): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 結末の要約文を i18n キー + 変数で返す (文言解決は UI 側)。エラーは 1 行目だけを
 * 要約に出し、全文は行を展開して読む。
 */
export function outputSummary(e: OutputEntry): { key: I18nKey; vars: Record<string, string | number> } {
  const ms = e.elapsedMs ?? 0;
  switch (e.outcome) {
    case "rows":
      return { key: "outputSummaryRows", vars: { rows: e.rows ?? 0, ms } };
    case "affected":
      return { key: "outputSummaryAffected", vars: { rows: e.rows ?? 0, ms } };
    case "timeout":
      return { key: "outputSummaryTimeout", vars: { rows: e.rows ?? 0, ms } };
    case "cancelled":
      return { key: "outputSummaryCancelled", vars: { rows: e.rows ?? 0, ms } };
    case "skipped":
      return { key: "outputSummarySkipped", vars: {} };
    case "error":
    default:
      return { key: "outputSummaryError", vars: { error: firstLine(e.error ?? "") } };
  }
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// ストア
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY: OutputEntry[] = [];
let current: OutputEntry[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getOutput(): OutputEntry[] {
  return current;
}

/** 実行結果を 1 件記録する。 */
export function pushOutput(input: OutputInput): void {
  current = appendOutput(current, { ...input, id: nextId++, at: Date.now() });
  emit();
}

export function clearOutput(): void {
  if (current.length === 0) return;
  current = EMPTY;
  emit();
}

/** テスト用のリセット。 @public */
export function __resetOutputLog(): void {
  current = EMPTY;
  nextId = 1;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useOutputLog(): OutputEntry[] {
  return useSyncExternalStore(subscribe, getOutput, getOutput);
}
