// レプリケーション監視タブ (#2180) の純ロジック。副作用なし。
//
// 閾値の判定・メーターの位置・並べ替えを描画から切り離し、Vitest で固定する。

import type { ReplicationLink, ReplicationSlot } from "../api/tauri";

/** 使われていないスロットが WAL をこれ以上溜めたら先頭で警告する (1 GiB)。 */
export const SLOT_WAL_WARN_BYTES = 1024 * 1024 * 1024;

/** 遅延メーターの警告マーカー (秒)。これ以上は警告色にする。 */
export const LAG_WARN_SECS = 30;

/** 遅延メーターの目盛りの上限 (秒)。これ以上は満タン表示。 */
export const LAG_METER_MAX_SECS = 60;

/** 非アクティブで WAL を `threshold` バイト以上保持しているスロット (保持量の多い順)。 */
export function slotsHoldingWal(
  slots: readonly ReplicationSlot[],
  threshold: number = SLOT_WAL_WARN_BYTES,
): ReplicationSlot[] {
  return slots
    .filter((s) => !s.active && s.retained_bytes != null && s.retained_bytes >= threshold)
    .sort((a, b) => (b.retained_bytes ?? 0) - (a.retained_bytes ?? 0) || a.name.localeCompare(b.name));
}

/** `wal_status = 'lost'` のスロット (必要な WAL が失われ、もう使えない)。 */
export function slotsLost(slots: readonly ReplicationSlot[]): ReplicationSlot[] {
  return slots.filter((s) => s.wal_status === "lost");
}

/** 遅延 (秒) をメーターの位置 (0〜100%) にする。`null` / 負値 / 非有限値は 0。 */
export function lagMeterPercent(secs: number | null | undefined): number {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(100, (secs / LAG_METER_MAX_SECS) * 100);
}

/** 警告マーカーの位置 (0〜100%)。 */
export function lagWarnPercent(): number {
  return (LAG_WARN_SECS / LAG_METER_MAX_SECS) * 100;
}

/** 遅延が警告の閾値以上か。`null` は判定不能なので偽。 */
export function isLagWarning(secs: number | null | undefined): boolean {
  return secs != null && Number.isFinite(secs) && secs >= LAG_WARN_SECS;
}

/** 遅延 (秒) を表示用に整形する。1 分未満は小数 1 桁の秒、それ以上は分・秒。 */
export function formatLagSecs(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)} s`;
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

/** 接続先に異常があるか (停止中のスレッド・エラー・遅延超過)。行の強調に使う。 */
export function linkNeedsAttention(link: ReplicationLink): boolean {
  return (
    link.io_running === false ||
    link.sql_running === false ||
    link.last_error != null ||
    isLagWarning(link.lag_secs)
  );
}

/** 一覧の並び: 異常のある行 → 名前順。 */
export function sortLinks(links: readonly ReplicationLink[]): ReplicationLink[] {
  return [...links].sort(
    (a, b) => Number(linkNeedsAttention(b)) - Number(linkNeedsAttention(a)) || a.name.localeCompare(b.name),
  );
}
