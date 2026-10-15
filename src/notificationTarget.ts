// 完了通知から該当の結果タブへ移動する (#1631) ための純ロジック。副作用なし。
//
// 通知には実行したタブの ID を `extra` に載せる (SQL や結果は載せない)。クリック (onAction)
// で `extra.tabId` が届けばそのタブを開く。デスクトップではプラグインがクリックを通知して
// こない環境があるため、「通知を出した直後にウィンドウが前面化された」ことをクリックの
// 代わりとして扱うフォールバックも持つ (`consumeFocusTarget`)。

/** 通知を出したタブの記録。 */
export interface NotifiedTab {
  tabId: string;
  at: number;
}

/** フォーカスをクリックの代わりとみなす猶予 (ms)。通知を見てすぐ戻ってきた場合だけ移動する。 */
export const NOTIFICATION_FOCUS_WINDOW_MS = 60_000;

/** 通知の `extra` からタブ ID を取り出す。文字列でなければ null。 */
export function tabIdFromNotificationExtra(extra: unknown): string | null {
  if (!extra || typeof extra !== "object") return null;
  const v = (extra as Record<string, unknown>).tabId;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * ウィンドウが前面になったとき、直近の通知のタブへ移動すべきか。猶予内なら
 * `{ tabId, next: null }` (一度使ったら消す)、猶予を過ぎていたら記録を捨てて `tabId: null`。
 */
export function consumeFocusTarget(
  last: NotifiedTab | null,
  now: number,
  windowMs: number = NOTIFICATION_FOCUS_WINDOW_MS,
): { tabId: string | null; next: NotifiedTab | null } {
  if (!last) return { tabId: null, next: null };
  if (now - last.at > windowMs || now < last.at) return { tabId: null, next: null };
  return { tabId: last.tabId, next: null };
}
