import type { ActivitySeverity, MergedLogEntry } from "./activityLog";
import { tableToMarkdown } from "./components/tabularText";

/**
 * アクティビティ履歴 (トースト + ステータスメッセージの統合一覧) を Markdown / テキストへ
 * 書き出す純ロジック (#1539)。履歴は揮発ストア (上限 200 件) なので、障害対応や不具合報告の
 * ために直前の操作を残す手段として、時刻・重大度・文言を時系列 (古い順) で整形する。
 */

export interface ActivityExportLabels {
  time: string;
  severity: string;
  message: string;
  /** 重大度ごとの表示名 (i18n 済み)。 */
  severities: Record<ActivitySeverity, string>;
}

/** `YYYY-MM-DD HH:MM:SS +09:00` 形式。`offsetMinutes` は UTC からの進み (JST なら 540)。 */
export function formatExportTimestamp(at: number, offsetMinutes: number): string {
  const shifted = new Date(at + offsetMinutes * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${p(shifted.getUTCFullYear(), 4)}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())} ` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** 端末のローカル時刻でのオフセット (分)。 */
function localOffsetMinutes(at: number): number {
  return -new Date(at).getTimezoneOffset();
}

function messageWithRepeat(e: MergedLogEntry): string {
  return e.repeat > 1 ? `${e.message} (×${e.repeat})` : e.message;
}

/** 古い順に並べ直した配列 (入力は表示順 = 新しい順)。同時刻は元の並びの逆順を保つ。 */
function chronological(entries: readonly MergedLogEntry[]): MergedLogEntry[] {
  return [...entries].reverse().sort((a, b) => a.at - b.at);
}

/** Markdown の表。時刻はローカル (オフセット付き)。 */
export function activityToMarkdown(
  entries: readonly MergedLogEntry[],
  labels: ActivityExportLabels,
  offsetMinutes?: number,
): string {
  const rows = chronological(entries).map((e) => [
    formatExportTimestamp(e.at, offsetMinutes ?? localOffsetMinutes(e.at)),
    labels.severities[e.severity],
    messageWithRepeat(e),
  ]);
  return tableToMarkdown([labels.time, labels.severity, labels.message], rows);
}

/**
 * プレーンテキスト: `[時刻] [重大度] 文言` を 1 件 1 ブロックで並べる。文言が複数行のときは
 * 2 行目以降を字下げして、行頭の `[` で次の記録と見分けられるようにする。
 */
export function activityToText(
  entries: readonly MergedLogEntry[],
  labels: ActivityExportLabels,
  offsetMinutes?: number,
): string {
  const lines: string[] = [];
  for (const e of chronological(entries)) {
    const ts = formatExportTimestamp(e.at, offsetMinutes ?? localOffsetMinutes(e.at));
    const [first = "", ...rest] = messageWithRepeat(e).split(/\r?\n/);
    lines.push(`[${ts}] [${labels.severities[e.severity]}] ${first}`);
    for (const r of rest) lines.push(`    ${r}`);
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
