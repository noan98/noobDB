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
import { consumeFocusTarget, tabIdFromNotificationExtra, type NotifiedTab } from "./notificationTarget";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permissionState: "granted" | "denied" | "unknown" = "unknown";
let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionState === "granted") return true;
  if (permissionState === "denied") return false;
  // 複数クエリがほぼ同時に完了しても権限要求は 1 回に集約する (in-flight 共有)。
  if (permissionPromise !== null) return permissionPromise;
  permissionPromise = (async () => {
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
    } finally {
      permissionPromise = null;
    }
  })();
  return permissionPromise;
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
export async function sendQueryNotification(title: string, body: string, tabId?: string): Promise<void> {
  try {
    const granted = await ensurePermission();
    if (!granted) return;
    // 実行したタブの ID だけを載せる (#1631)。クリックでそのタブへ移動するために使い、SQL や結果は載せない。
    if (tabId) lastNotified = { tabId, at: Date.now() };
    sendNotification(tabId ? { title, body, extra: { tabId } } : { title, body });
  } catch {
    // ベストエフォート: 通知が失敗してもアプリの他の処理には影響させない。
  }
}

let clickFocusRegistered = false;
let focusReturnRegistered = false;
/** 直近に出した通知のタブ。クリックを通知してこない環境のフォールバックに使う。 */
let lastNotified: NotifiedTab | null = null;

/** 通知クリックでアプリウィンドウを前面化する購読を 1 回だけ登録する
 *  (何度呼んでも安全な冪等操作)。アプリ起動時に一度呼び出しておく想定。
 *  `onActivateTab` を渡すと、通知に載せたタブ ID のタブへ移動する (#1631)。
 *  クリックが届かない環境向けに、通知の直後 (猶予内) にウィンドウが前面へ戻ったときは、勝手にタブを
 *  切り替えず `onFocusReturn` へ知らせる (呼び出し側が「結果タブへ移動」のトーストを出す)。
 *  ユーザが自分で選んだタブを奪わないため。 */
export function registerNotificationClickFocus(
  onActivateTab?: (tabId: string) => void,
  onFocusReturn?: (tabId: string) => void,
): void {
  if (!clickFocusRegistered) {
    clickFocusRegistered = true;
    onAction((notification) => {
      const win = getCurrentWindow();
      void win.unminimize().catch(() => {});
      void win.setFocus().catch(() => {});
      const tabId = tabIdFromNotificationExtra(notification?.extra);
      if (tabId) {
        // クリックで移動したので、フォーカス復帰の案内は出さない。
        lastNotified = null;
        onActivateTab?.(tabId);
      }
    }).catch(() => {
      // リスナー登録自体に失敗した場合は次回呼び出しで再試行できるようにする。
      clickFocusRegistered = false;
    });
  }
  if (onFocusReturn && !focusReturnRegistered) {
    focusReturnRegistered = true;
    try {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          const { tabId, next } = consumeFocusTarget(lastNotified, Date.now());
          lastNotified = next;
          if (tabId) onFocusReturn(tabId);
        })
        .catch(() => {
          focusReturnRegistered = false;
        });
    } catch {
      // ウィンドウ API が使えない環境ではフォールバックなし。
      focusReturnRegistered = false;
    }
  }
}
