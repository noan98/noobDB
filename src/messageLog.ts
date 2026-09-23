import { useSyncExternalStore } from "react";
import type { ActivityEntry, ActivitySeverity } from "./activityLog";

/**
 * Bottom Panel の「メッセージ」タブ (#1114) が表示するステータス履歴の共有ストア。
 *
 * フッターのステータスバーは**最新の 1 件だけ**を表示し、次の操作で上書きされる。
 * 「さっきのエラー文をもう一度読みたい」「一括実行の前に何が出ていたか」を後から
 * 確かめる手段がなかったため、ステータスが変わるたびにここへ積む。
 *
 * アクティビティ (`activityLog.ts`) との違い:
 * - アクティビティ = **トースト**の履歴 (インポート完了・同期結果など操作の結末)
 * - メッセージ = **ステータスバー**の履歴 (接続・実行・編集の適用などの状態文)
 *
 * エントリの形は `ActivityEntry` と同じにして、一覧 UI (`SeverityLog.tsx`) と
 * 絞り込み・件数の純関数 (`filterActivity` / `countBySeverity`) をそのまま共有する。
 * 揮発性 (セッション内のみ) である点もアクティビティと揃える。
 */

export interface MessageEntry extends ActivityEntry {
  /**
   * 直前と同じメッセージとして畳むための識別子 (`statusLogClass` が決める)。
   */
  dedupeKey: string;
  /** 畳んだ回数 (1 = 畳んでいない)。 */
  repeat: number;
}

/** 保持する最大件数。超えた分は古いものから捨てる。 */
export const MESSAGE_LIMIT = 200;

/**
 * 新しいメッセージを先頭 (最新が先) に足した新しい配列を返す。入力は変更しない。
 *
 * 直前 (= 先頭) のエントリと `dedupeKey` と重大度が一致する場合は、新しい行を
 * 積まずに先頭を置き換え、`repeat` を 1 増やす (本文・時刻は新しい方)。`id` は
 * 先頭のものを引き継ぐので、一覧の React key が変わらず行が点滅しない。
 */
export function appendMessage(
  list: readonly MessageEntry[],
  entry: Omit<MessageEntry, "repeat">,
  limit: number = MESSAGE_LIMIT,
): MessageEntry[] {
  if (!(limit > 0)) return [];
  const top = list[0];
  if (top && top.dedupeKey === entry.dedupeKey && top.severity === entry.severity) {
    return [{ ...entry, id: top.id, repeat: top.repeat + 1 }, ...list.slice(1)];
  }
  return [{ ...entry, repeat: 1 }, ...list].slice(0, Math.floor(limit));
}

// ─────────────────────────────────────────────────────────────────────────────
// ストア (activityLog.ts と同じ useSyncExternalStore の形)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY: MessageEntry[] = [];
let current: MessageEntry[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getMessages(): MessageEntry[] {
  return current;
}

/** ステータスを 1 件記録する。呼ぶのは `App.tsx` のステータス監視 effect だけ。 */
export function pushMessage(severity: ActivitySeverity, message: string, dedupeKey: string): void {
  current = appendMessage(current, { id: nextId++, severity, message, dedupeKey, at: Date.now() });
  emit();
}

/** 履歴を消す。 */
export function clearMessages(): void {
  if (current.length === 0) return;
  current = EMPTY;
  emit();
}

/** テスト用のリセット (id 採番も戻す)。 @public */
export function __resetMessageLog(): void {
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

export function useMessageLog(): MessageEntry[] {
  return useSyncExternalStore(subscribe, getMessages, getMessages);
}
