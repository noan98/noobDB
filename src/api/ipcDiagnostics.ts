import { pushActivity } from "../activityLog";
import { t } from "../i18n";

/**
 * IPC レスポンスの検証失敗 (`parseResponse`) を、本番の利用者にも見える形で残す (#1536)。
 *
 * これまで検証失敗は DEV のコンソールにしか出ず、本番では「期待した形式と一致しません」という
 * エラーだけが出て、フロントとバックエンドのバージョン不整合を疑う手掛かりが残らなかった。
 * 失敗した経路でだけアクティビティ (ベル / Bottom Panel のログ) に 1 件記録し、行を展開すると
 * コマンド名・失敗パス・アプリのバージョンを含む診断テキストをコピーできる。
 * **成功経路には一切触れない** (性能影響なし)。
 */

/** 同じ失敗の再記録を抑える時間。ポーリングで毎回同じ検証失敗が出ても一覧を埋めない。 */
export const IPC_FAILURE_DEDUPE_MS = 5 * 60 * 1000;

const lastRecorded = new Map<string, number>();

/** 診断テキストに載せる失敗パスの最大件数。巨大な配列の全要素分を並べない。 */
const MAX_ISSUES = 20;

/** テスト用のリセット。 @public */
export function __resetIpcDiagnostics(): void {
  lastRecorded.clear();
}

/**
 * 検証失敗を 1 件記録する。同じコマンド・同じ失敗の組は `IPC_FAILURE_DEDUPE_MS` 内なら記録しない。
 * `issues` は `パス: メッセージ` の行 (`parseResponse` が組み立てたもの)。
 * @returns 記録したら true、重複として捨てたら false
 */
export function recordIpcValidationFailure(
  command: string,
  issues: readonly string[],
  now: number = Date.now(),
): boolean {
  const trimmed = issues.slice(0, MAX_ISSUES);
  const key = `${command}\0${trimmed.join("\0")}`;
  const last = lastRecorded.get(key);
  if (last !== undefined && now - last < IPC_FAILURE_DEDUPE_MS) return false;
  lastRecorded.set(key, now);
  pushActivity("error", t("ipcValidationActivity", { command }), {
    kind: "ipcValidation",
    command,
    issues: trimmed,
    at: now,
  });
  return true;
}

/**
 * 「問題を報告する」ときに貼れる診断テキスト。秘密や行データは含まない
 * (コマンド名・失敗したフィールドのパスとメッセージ・バージョン・時刻だけ)。
 */
export function buildIpcDiagnosticText(
  detail: { command: string; issues: readonly string[]; at: number },
  appVersion: string | null,
): string {
  return [
    "noobDB IPC response validation failure",
    `app version: ${appVersion ?? "unknown"}`,
    `time: ${new Date(detail.at).toISOString()}`,
    `command: ${detail.command}`,
    "issues:",
    ...detail.issues.map((i) => `  - ${i}`),
  ].join("\n");
}
