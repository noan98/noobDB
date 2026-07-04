/**
 * OS デスクトップ通知 (#707) の副作用層。判定ロジックは `queryNotify.ts` に
 * 分離済みで、ここは `@tauri-apps/plugin-notification` / `@tauri-apps/api/window`
 * への薄いラッパーのみを持つ。既存の `dialog` プラグイン (`ExportModal` 等) と
 * 同じく、Tauri プラグインは `api/tauri.ts` の IPC ラッパー方針の対象外 (Rust
 * コマンドではなくプラグイン自体の JS API) として直接 import する。
 *
 * すべてベストエフォート: 通知の送信/権限確認に失敗してもクエリ完了処理自体は
 * 継続させたいので、例外は握りつぶす (呼び出し元をブロックしない)。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permissionState: "granted" | "denied" | "unknown" = "unknown";

async function ensurePermission(): Promise<boolean> {
  if (permissionState === "granted") return true;
  if (permissionState === "denied") return false;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === "granted";
    }
    permissionState = granted ? "granted" : "denied";
    return granted;
  } catch {
    // 権限 API 自体が失敗する環境 (未対応 OS 等) では通知を諦める。
    permissionState = "denied";
    return false;
  }
}

/** 現在のウィンドウがフォーカスされているかを返す。判定に失敗した場合は
 *  「フォーカス中」扱い (安全側 = 通知を出さない) にフォールバックする。 */
export async function isAppWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return true;
  }
}

/** クエリ完了などのメタ情報 (件数・経過時間・エラー先頭行) のみを載せた OS
 *  通知を送る。SQL 本文や結果データはここでは一切扱わない — 呼び出し元
 *  (`App.tsx`) が渡す `title`/`body` に含めないこと。 */
export async function sendQueryNotification(title: string, body: string): Promise<void> {
  try {
    const granted = await ensurePermission();
    if (!granted) return;
    sendNotification({ title, body });
  } catch {
    // ベストエフォート: 通知が失敗してもアプリの他の処理には影響させない。
  }
}

let clickFocusRegistered = false;

/** 通知クリックでアプリウィンドウを前面化する購読を 1 回だけ登録する
 *  (何度呼んでも安全な冪等操作)。アプリ起動時に一度呼び出しておく想定。 */
export function registerNotificationClickFocus(): void {
  if (clickFocusRegistered) return;
  clickFocusRegistered = true;
  onAction(() => {
    const win = getCurrentWindow();
    void win.unminimize().catch(() => {});
    void win.setFocus().catch(() => {});
  }).catch(() => {
    // リスナー登録自体に失敗した場合は次回呼び出しで再試行できるようにする。
    clickFocusRegistered = false;
  });
}
