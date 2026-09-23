import type { I18nKey } from "./i18n";
import type { ActivitySeverity } from "./activityLog";

/**
 * フッターのステータスバーに出すメッセージの型と、その重大度判定 (純ロジック)。
 *
 * 元は `App.tsx` の中に置かれていたが、Bottom Panel の「メッセージ」タブ (#1114) が
 * 同じ判定でステータスを履歴化するため、両者が共有できるようここへ切り出した。
 * ステータスバーは**最新の 1 件しか見せない** (次の実行で上書きされる) ので、
 * 見逃したエラー文を後から読み返す置き場が「メッセージ」タブになる。
 */
export type Status =
  // No status to surface (e.g. freshly connected, no query run yet). The
  // footer bar is hidden entirely; one-shot confirmations like "connected"
  // live in the toast notifications instead.
  | { kind: "idle" }
  | { kind: "literal"; text: string; error?: boolean; errorKind?: string | null }
  // `errorKind` carries the structured `AppError.kind` (#683) so the hint/
  // illustration resolver can classify reliably instead of pattern-matching the
  // message text. Optional: paths that only have a plain string omit it and the
  // resolver falls back to message matching.
  | { kind: "key"; key: I18nKey; vars?: Record<string, string | number>; error?: boolean; errorKind?: string | null };

// エラーは重大度別に区別する。`critical` は接続喪失など回復に再接続を要する
// 致命的状態 (赤、目立つバッジ)、`warning` はタイムアウトなど接続は生きている軽度
// 障害 (黄)、`error` は SQL 構文エラー・制約違反など個別クエリの失敗 (赤)。
export type StatusTone = "running" | "success" | "error" | "warning" | "critical" | "info";

// Status keys that represent an in-progress operation (spinner + accent border).
const RUNNING_STATUS_KEYS: ReadonlySet<string> = new Set([
  "statusConnecting",
  "statusRunningQuery",
  "statusRunningPreview",
  "statusApplyingEdits",
]);

// 致命的 (critical): セッションが使えなくなり再接続が必要な状態。フッターに残し、
// 「重大」バッジ + 再接続導線で対処を促す。
const CRITICAL_STATUS_KEYS: ReadonlySet<string> = new Set(["statusConnectionLost"]);

// 警告 (warning): 接続は維持されており、設定変更や再試行で回復しうる軽度の障害。
const WARNING_STATUS_KEYS: ReadonlySet<string> = new Set([
  "statusQueryTimeout",
  "statusQueryTimeoutPartial",
]);

/**
 * 途中経過だけを伝えるステータス。フッターでは spinner や行数カウンタとして
 * 意味があるが、**完了すれば同じ操作の結果メッセージで上書きされる**ため、
 * メッセージ履歴には残さない (ストリーミング中は行が届くたびに更新されるので、
 * 残すと 1 回の実行で数十行の「取得中…」が積もる)。
 */
const PROGRESS_STATUS_KEYS: ReadonlySet<string> = new Set([
  ...RUNNING_STATUS_KEYS,
  "statusStreaming",
  "statusPreviewStreaming",
  "statusLoadingMore",
  "statusBatchRunning",
  "statusReconnectingAttempt",
]);

// Maps a status to a tone for the footer's icon + colored left border.
// Derived from the existing `error` flag and known keys, so call sites don't
// each have to declare a severity.
export function statusTone(s: Status): StatusTone {
  if (s.kind === "idle") return "info";
  if (s.kind === "key") {
    if (RUNNING_STATUS_KEYS.has(s.key)) return "running";
    // critical / warning は error フラグの有無より優先して重大度を確定させる。
    if (CRITICAL_STATUS_KEYS.has(s.key)) return "critical";
    if (WARNING_STATUS_KEYS.has(s.key)) return "warning";
    if (s.error) return "error";
    if (s.key === "appDisconnected") return "info";
    return "success";
  }
  if (s.error) return "error";
  return "info";
}

/** トーン → メッセージ履歴の重大度 (アクティビティと同じ 4 段階に畳む)。 */
const TONE_SEVERITY: Record<Exclude<StatusTone, "running">, ActivitySeverity> = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  critical: "error",
};

/**
 * ステータスをメッセージ履歴に残すときの分類。残さない (idle / 途中経過) なら null。
 * `text` はフッターに実際に出している (翻訳済みの) 本文。
 *
 * `dedupeKey` は「直前と同じメッセージとして 1 行に畳んでよいか」の識別子で、
 * 履歴側 (`messageLog.ts` の `appendMessage`) は直前の行とこれが一致すれば
 * 新しい行を積まずに回数を数える。
 *
 * - **成功 / 情報**は i18n キー単位で畳む。自動リフレッシュは同じ「取得完了」を
 *   数秒おきに出し、件数・経過時間だけが毎回違う — 本文で比べると畳めず、履歴が
 *   tick で埋まって肝心のエラーが流れてしまう。
 * - **エラー / 警告**は本文単位で畳む。同じキー (`statusQueryError`) でも本文
 *   (エラー内容) が違えば別の出来事なので、別の行として残す。
 */
export function statusLogClass(
  s: Status,
  text: string,
): { severity: ActivitySeverity; dedupeKey: string } | null {
  if (s.kind === "idle") return null;
  if (s.kind === "key" && PROGRESS_STATUS_KEYS.has(s.key)) return null;
  const tone = statusTone(s);
  if (tone === "running") return null;
  const severity = TONE_SEVERITY[tone];
  const quiet = severity === "success" || severity === "info";
  return {
    severity,
    dedupeKey: quiet && s.kind === "key" ? `key:${s.key}` : `text:${text}`,
  };
}
