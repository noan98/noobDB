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

/**
 * 「バージョン不一致かもしれない」警告を出す、検証に失敗した**異なるコマンド**の数 (#1622)。
 * 1 コマンドだけの失敗はそのコマンドの不具合のこともあるが、複数のコマンドが同じセッションで
 * 揃って形式不一致になるのは、アプリとバックエンドの版がずれている典型的な症状。
 */
export const IPC_MISMATCH_COMMAND_THRESHOLD = 3;

/** コマンドごとの直近の検証失敗 (重複抑止とは無関係に、失敗のたびに更新する)。 */
const failedCommands = new Map<string, { issues: string[]; at: number }>();

export interface IpcFailureSummary {
  command: string;
  issues: string[];
  at: number;
}

export interface IpcMismatchState {
  /** 警告を出している最中か。閉じたら以後そのセッションでは二度と true にならない。 */
  active: boolean;
  failures: IpcFailureSummary[];
}

const IDLE_STATE: IpcMismatchState = { active: false, failures: [] };
let mismatchState: IpcMismatchState = IDLE_STATE;
let mismatchDismissed = false;
let mismatchShown = false;
const mismatchListeners = new Set<() => void>();

function emitMismatch(): void {
  for (const l of mismatchListeners) l();
}

export function subscribeIpcMismatch(cb: () => void): () => void {
  mismatchListeners.add(cb);
  return () => {
    mismatchListeners.delete(cb);
  };
}

export function getIpcMismatchState(): IpcMismatchState {
  return mismatchState;
}

/** 警告を閉じる。同じセッションでは再表示しない。 */
export function dismissIpcMismatch(): void {
  mismatchDismissed = true;
  mismatchState = IDLE_STATE;
  emitMismatch();
}

function trackFailedCommand(command: string, issues: string[], at: number): void {
  failedCommands.set(command, { issues, at });
  if (mismatchShown || mismatchDismissed) {
    // 表示中は一覧 (診断テキスト) だけ最新にする。
    if (mismatchState.active) {
      mismatchState = { active: true, failures: summarizeFailures() };
      emitMismatch();
    }
    return;
  }
  if (failedCommands.size >= IPC_MISMATCH_COMMAND_THRESHOLD) {
    mismatchShown = true;
    mismatchState = { active: true, failures: summarizeFailures() };
    emitMismatch();
  }
}

function summarizeFailures(): IpcFailureSummary[] {
  return [...failedCommands].map(([command, v]) => ({ command, ...v }));
}

/** テスト用のリセット。 @public */
export function __resetIpcDiagnostics(): void {
  lastRecorded.clear();
  failedCommands.clear();
  mismatchState = IDLE_STATE;
  mismatchDismissed = false;
  mismatchShown = false;
  emitMismatch();
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
  trackFailedCommand(command, trimmed, now);
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

/** 複数コマンドの検証失敗をまとめた診断テキスト (#1622)。秘密や行データは含まない。 */
export function buildIpcMismatchDiagnosticText(
  failures: readonly IpcFailureSummary[],
  appVersion: string | null,
): string {
  return [
    "noobDB IPC response validation failures (possible app/backend version mismatch)",
    `app version: ${appVersion ?? "unknown"}`,
    `failed commands: ${failures.length}`,
    ...failures.flatMap((f) => [
      "",
      `command: ${f.command}`,
      `time: ${new Date(f.at).toISOString()}`,
      "issues:",
      ...f.issues.map((i) => `  - ${i}`),
    ]),
  ].join("\n");
}
