// レプリケーション監視タブ (#2180) の純ロジック。副作用なし。
//
// 閾値の判定・メーターの位置・並べ替えを描画から切り離し、Vitest で固定する。

import type { ReplicationLink, ReplicationSlot } from "../api/tauri";
import type { LiveField } from "./liveDiff";

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
export function sortLinks<T extends ReplicationLink>(links: readonly T[]): T[] {
  return [...links].sort(
    (a, b) => Number(linkNeedsAttention(b)) - Number(linkNeedsAttention(a)) || a.name.localeCompare(b.name),
  );
}

/**
 * スロットを削除する SQL。スロット名は識別子ではなく**文字列リテラル**として渡る (`pg_drop_replication_slot(name)`)
 * ので、識別子の引用ではなく `'` を `''` に重ねて埋め込む (PostgreSQL は標準準拠の文字列で `\` を特別扱いしない)。
 */
export function buildDropSlotSql(name: string): string {
  return `SELECT pg_drop_replication_slot('${name.replace(/'/g, "''")}')`;
}

/** 削除ボタンを無効にする理由。削除できるなら `null`。 */
export function dropSlotBlockedReason(
  slot: ReplicationSlot,
  readOnly: boolean,
): "readOnly" | "active" | null {
  if (readOnly) return "readOnly";
  if (slot.active) return "active";
  return null;
}

/**
 * 接続先カードの安定 key (#2213)。`sortLinks` で並びが変わっても同じ接続先は同じ key を保ち、
 * カードの DOM (と StatTile の CountUp) が作り直されない。配列の index は入れない。
 */
export function linkKey(link: ReplicationLink): string {
  return `${link.direction}\u0000${link.name}\u0000${link.address ?? ""}`;
}

/**
 * 一覧全体の key 列 (#2213)。同じ向き・名前・アドレスの接続先は現実に複数ありうる (`pg_basebackup` の
 * walsender が 2 本、Unix ソケット接続でアドレスが null など) ので、重複したときだけ出現順の連番を足して
 * 一意にする。入力 (並べ替え前) の順で数えるので、`sortLinks` で並びが変わっても同じ接続先は同じ key を保つ。
 * 重複を取り除くのではなく連番で区別する (接続先を消さない)。
 */
export function linkKeys(links: readonly ReplicationLink[]): string[] {
  const seen = new Map<string, number>();
  return links.map((l) => {
    const base = linkKey(l);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/** `linkKeys` の key を載せた接続先。描画と差分計算の両方がこの key を使う。 */
export type KeyedLink = ReplicationLink & { key: string };

export function keyLinks(links: readonly ReplicationLink[]): KeyedLink[] {
  const keys = linkKeys(links);
  return links.map((l, i) => ({ ...l, key: keys[i] }));
}

/** `KeyedLink` の行 ID。 */
export function keyedLinkKey(l: KeyedLink): string {
  return l.key;
}

export type ReplicationLinkLiveField = "lag" | "lagWrite" | "lagFlush" | "lagBytes";

/** 接続先の値変化フラッシュ対象 (遅延・WAL 差分)。 */
export const REPLICATION_LINK_LIVE_FIELDS: readonly LiveField<ReplicationLink, ReplicationLinkLiveField>[] = [
  { name: "lag", changed: (a, b) => a.lag_secs !== b.lag_secs },
  { name: "lagWrite", changed: (a, b) => a.write_lag_secs !== b.write_lag_secs },
  { name: "lagFlush", changed: (a, b) => a.flush_lag_secs !== b.flush_lag_secs },
  { name: "lagBytes", changed: (a, b) => a.lag_bytes !== b.lag_bytes },
];

/** スロットの安定 key (スロット名はクラスタ内で一意)。 */
export function slotKey(slot: ReplicationSlot): string {
  return slot.name;
}

export type ReplicationSlotLiveField = "retained";

/** スロットの値変化フラッシュ対象 (WAL 保持量)。 */
export const REPLICATION_SLOT_LIVE_FIELDS: readonly LiveField<ReplicationSlot, ReplicationSlotLiveField>[] = [
  { name: "retained", changed: (a, b) => a.retained_bytes !== b.retained_bytes },
];
