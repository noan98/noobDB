/**
 * PostgreSQL LISTEN / NOTIFY 監視パネル (#2019) の純ロジック。副作用なし (DOM / IPC に
 * 触れない) なので Vitest で単体テストできる。
 *
 * チャンネル名の検証はバックエンド (`db/pg_listen.rs` の `validate_channel`) と同じ規則で、
 * 画面で先に弾くための鏡。SQL へのクオートは sqlx の `PgListener` が行うので、ここでは
 * 識別子として SQL を組み立てない。
 */
import type { PgNotification } from "../api/tauri";
import type { I18nKey } from "../i18n";

/** 受信バッファの上限。超えたら古い通知から捨てる。 */
export const PG_LISTEN_MAX_BUFFER = 1000;
/** 同時に購読できるチャンネル数の上限 (バックエンドの `MAX_CHANNELS` と同じ)。 */
export const PG_LISTEN_MAX_CHANNELS = 50;
/** PostgreSQL の識別子長の上限 (バイト)。 */
export const PG_LISTEN_MAX_CHANNEL_BYTES = 63;
/** 一覧の 1 行に出す payload の最大文字数。超えた分は省略記号にする。 */
export const PG_LISTEN_PREVIEW_CHARS = 200;

/** 受信順の通し番号つき通知 (一覧の安定したキー)。 */
export interface BufferedNotification extends PgNotification {
  seq: number;
}

/**
 * 通知をバッファの末尾に足し、`max` を超えた分を先頭 (古い方) から捨てる。
 * 戻り値の `dropped` はこの呼び出しで捨てた件数。
 */
export function appendNotification(
  buffer: readonly BufferedNotification[],
  next: BufferedNotification,
  max: number = PG_LISTEN_MAX_BUFFER,
): { items: BufferedNotification[]; dropped: number } {
  const items = [...buffer, next];
  const dropped = Math.max(0, items.length - max);
  return { items: dropped > 0 ? items.slice(dropped) : items, dropped };
}

export type ChannelNameProblem = "empty" | "tooLong" | "nul";

export type ChannelNameCheck = { ok: true; name: string } | { ok: false; problem: ChannelNameProblem };

/** 入力欄のチャンネル名を検証する。前後の空白は落とす (識別子の内部の空白は保つ)。 */
export function checkChannelName(raw: string): ChannelNameCheck {
  const name = raw.trim();
  if (name === "") return { ok: false, problem: "empty" };
  if (name.includes("\0")) return { ok: false, problem: "nul" };
  if (new TextEncoder().encode(name).length > PG_LISTEN_MAX_CHANNEL_BYTES) {
    return { ok: false, problem: "tooLong" };
  }
  return { ok: true, name };
}

/** PostgreSQL 以外には LISTEN / NOTIFY が無い。 */
export function supportsPgListen(driver: string | null | undefined): boolean {
  return driver === "postgres";
}

/** 非対応の理由コード → 説明文の i18n キー (`queryInspector.supportReasonI18nKey` と同じ流儀)。 */
export function pgListenReasonKey(reason: string): I18nKey {
  switch (reason) {
    case "unsupported_driver":
      return "pgListenReasonUnsupportedDriver";
    default:
      return "pgListenReasonUnknown";
  }
}

/** 一覧の 1 行に出す payload。改行は空白に畳み、長いものは省略記号で切る。 */
export function payloadPreview(payload: string, max: number = PG_LISTEN_PREVIEW_CHARS): string {
  const flat = payload.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/** payload が JSON なら整形した文字列、そうでなければ `null` (詳細表示用)。 */
export function prettyJsonPayload(payload: string): string | null {
  const text = payload.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** 受信時刻 (エポックミリ秒) をローカル時刻の `HH:MM:SS.mmm` にする。 */
export function formatReceivedAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 表示一時停止 (#2093) 中は、停止した時点の一覧 (スナップショット) をそのまま見せる。
 * 受信バッファは上限で古い方から捨てられていくが、見ている行は消さない。`frozen` が null なら追従表示。
 */
export function visibleNotifications(
  items: readonly BufferedNotification[],
  frozen: readonly BufferedNotification[] | null,
): BufferedNotification[] {
  return [...(frozen ?? items)];
}

/**
 * 一時停止中に溜まった (まだ画面に出ていない) 通知の件数 (バッファ上の seq > 凍結点)。
 * `channel` を渡すとそのチャンネルの分だけ数える (絞り込み中のバッジ用)。
 */
export function pendingCount(
  items: readonly BufferedNotification[],
  pausedAt: number | null,
  channel: string | null = null,
): number {
  if (pausedAt === null) return 0;
  return items.filter((n) => n.seq > pausedAt && (channel === null || n.channel === channel)).length;
}

/** チャンネル別の件数 (チップに出す)。 */
export function countByChannel(items: readonly BufferedNotification[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of items) out.set(n.channel, (out.get(n.channel) ?? 0) + 1);
  return out;
}
