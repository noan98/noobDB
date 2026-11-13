/**
 * アプリ内自動更新 (#705) の「確認 → 承認時にダウンロード・適用・再起動」という UI フローを
 * 1 か所に集約する。起動時チェック (`App.tsx`) と設定画面の手動チェック (`SettingsView`) の両方が
 * `confirmAndInstallUpdate` を呼び、`App` に 1 つ置いた `UpdatePromptHost` が専用の
 * `UpdateAvailableModal` を描く (#2297。汎用 ConfirmDialog + 進捗トーストから置き換え)。
 * 副作用の実体 (プラグイン呼び出し) は `../updater.ts` に、純粋な整形は `../updaterFormat.ts` にある。
 */
import { useSyncExternalStore } from "react";
import { AnimatePresence } from "motion/react";
import {
  dismissUpdate,
  installUpdateAndRestart,
  type AvailableUpdate,
  type InstallProgress,
} from "../updater";
import { saveSkippedUpdateVersion } from "../updateSkip";
import { clearPendingWhatsNew, savePendingWhatsNew } from "../whatsNewStore";
import { UpdateAvailableModal, type UpdatePhase } from "./UpdateAvailableModal";

export interface UpdatePromptDeps {
  /**
   * 起動時の自動チェック用 (#1631)。true なら「このバージョンは見送る」ボタンを足し、押したときだけ
   * そのバージョンを覚えて、より新しい版が出るまで次回以降の起動では出さない。Esc / × / 「後で」は
   * 見送りにしない。設定画面の手動チェックでは指定しない (毎回見せる)。
   */
  rememberSkip?: boolean;
}

interface Session {
  update: AvailableUpdate;
  rememberSkip: boolean;
  phase: UpdatePhase;
  progress: InstallProgress | null;
  error: string | null;
  /** ダウンロード中に「バックグラウンドで続行」で閉じた。ダウンロードは続き、失敗したら再び出す。 */
  hidden: boolean;
}

let session: Session | null = null;
let settle: (() => void) | null = null;
const listeners = new Set<() => void>();

function setSession(next: Session | null): void {
  session = next;
  for (const l of listeners) l();
}

function patch(p: Partial<Session>): void {
  if (session) setSession({ ...session, ...p });
}

/** `confirmAndInstallUpdate` の Promise を (一度だけ) 解決する。 */
function resolveCaller(): void {
  const r = settle;
  settle = null;
  r?.();
}

function finishWithoutInstall(): void {
  if (session) void dismissUpdate(session.update);
  setSession(null);
  resolveCaller();
}

async function startInstall(): Promise<void> {
  const cur = session;
  // キーリピートなどで二重に呼ばれても、ダウンロードを重ねて走らせない。
  if (!cur || cur.phase === "downloading" || cur.phase === "applying") return;
  // 適用後の起動で「新機能ハイライト」を出すため、再起動の前に版とノートを覚えておく (#1864)。
  savePendingWhatsNew(cur.update);
  setSession({ ...cur, phase: "downloading", progress: null, error: null, hidden: false });
  try {
    await installUpdateAndRestart(cur.update, (progress) => {
      if (session?.update !== cur.update) return;
      patch({ progress, phase: progress.percent === 100 ? "applying" : "downloading" });
    });
  } catch (e) {
    clearPendingWhatsNew();
    if (session?.update !== cur.update) return;
    // 失敗はモーダル内に出す。バックグラウンドで続行中だった場合も再び前面に出す。
    patch({ phase: "failed", error: e instanceof Error ? e.message : String(e), hidden: false });
  }
}

/** Esc / × / 「後で」/「バックグラウンドで続行」。段階ごとに意味が変わる (見送りにはしない, #1631)。 */
function closeSession(): void {
  if (!session) return;
  if (session.phase === "downloading" || session.phase === "applying") {
    patch({ hidden: true });
    resolveCaller();
    return;
  }
  finishWithoutInstall();
}

function skipSession(): void {
  if (!session) return;
  saveSkippedUpdateVersion(session.update.version);
  finishWithoutInstall();
}

/**
 * 更新がある状態から、専用モーダルでユーザ承認を得て、ダウンロード・適用・再起動まで進める。
 *   - 承認されなければ確保したリソースを解放して何もしない。
 *   - 承認されたら同じモーダル内で進捗を出し、`installUpdateAndRestart` を呼ぶ (成功時は
 *     relaunch でプロセスが差し替わるため通常は戻らない)。失敗はモーダル内のエラー + 再試行。
 *   - 返す Promise は、モーダルが閉じた (見送り・後で・バックグラウンド続行) 時点で解決する。
 */
export function confirmAndInstallUpdate(update: AvailableUpdate, deps: UpdatePromptDeps = {}): Promise<void> {
  if (session) {
    // すでに別の更新モーダルが開いている。重ねず、確保したリソースだけ解放する。
    // バックグラウンドで続行中なら、黙って終わらずに既存のモーダルを前面に戻す。
    if (session.hidden) patch({ hidden: false });
    void dismissUpdate(update);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    settle = resolve;
    setSession({
      update,
      rememberSkip: deps.rememberSkip === true,
      phase: "confirm",
      progress: null,
      error: null,
      hidden: false,
    });
  });
}

/** `App` に 1 つだけ置く。`confirmAndInstallUpdate` が開いたセッションを `UpdateAvailableModal` で描く。 */
export function UpdatePromptHost() {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => session,
  );
  return (
    <AnimatePresence>
      {s && !s.hidden && (
        <UpdateAvailableModal
          key={s.update.version}
          update={s.update}
          phase={s.phase}
          progress={s.progress}
          error={s.error}
          rememberSkip={s.rememberSkip}
          onStart={() => void startInstall()}
          onClose={closeSession}
          onSkip={skipSession}
        />
      )}
    </AnimatePresence>
  );
}
