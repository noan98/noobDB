/**
 * OS デスクトップ通知 (#707) の「出すか出さないか」を決める純粋ロジック。実際の
 * `tauri-plugin-notification` 呼び出しは `notifications.ts` に分離し、ここは
 * 副作用なし・Vitest で境界値を固定できる判定/整形関数のみを持つ。
 *
 * 通知は「時間のかかったクエリが完了したとき、他の作業に切り替えている利用者へ
 * 気付かせる」ためのものなので、次の 2 条件を両方満たすときだけ発火する:
 *   - 実行時間が設定の閾値 (秒) 以上 (**正常終了 `done` と `cancelled` だけ**に適用する)
 *   - ウィンドウが非フォーカス (フォーカス中は画面を見ているので不要)
 * 失敗 (`error`) とタイムアウト (`timeout`) は閾値に関係なく通知する (#1621): 短時間で
 * 失敗したクエリ (接続エラー・構文エラー) は、別作業中だと気づけないため。
 * 加えて設定でオフにできる。
 */

export type QueryNotificationKind = "done" | "error" | "timeout" | "cancelled";

export interface QueryNotificationDecisionInput {
  /** 設定「クエリ完了時に通知」のオン/オフ。 */
  enabled: boolean;
  /** 実行にかかった時間 (ms)。 */
  elapsedMs: number;
  /** 通知を出すまでの閾値 (秒)。 */
  thresholdSecs: number;
  /** 呼び出し時点でウィンドウがフォーカスされているか。 */
  windowFocused: boolean;
  /** 完了の種別。省略時は `done` (閾値を適用する)。 */
  kind?: QueryNotificationKind;
}

/**
 * 通知を出すべきかを判定する。不正な数値 (NaN/Infinity) は安全側 (通知しない)
 * に倒す。閾値・経過時間は負値をクランプしてから比較する。
 */
export function shouldNotifyQueryCompletion(input: QueryNotificationDecisionInput): boolean {
  if (!input.enabled) return false;
  if (input.windowFocused) return false;
  if (!Number.isFinite(input.elapsedMs)) return false;
  if (input.kind === "error" || input.kind === "timeout") return true;
  if (!Number.isFinite(input.thresholdSecs)) return false;
  const elapsed = Math.max(0, input.elapsedMs);
  const thresholdMs = Math.max(0, input.thresholdSecs) * 1000;
  return elapsed >= thresholdMs;
}

/** 通知本文に埋め込むエラーメッセージの整形: 先頭 1 行のみ・長すぎる行は切り詰める
 *  (通知には SQL 本文や結果データを含めない方針。エラー文字列自体は元々 SQL を
 *  含まないメタ情報だが、万一長大な場合でも通知 UI を壊さないよう上限を設ける)。 */
export function firstLineForNotification(text: string, maxLen = 200): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen)}…`;
}
