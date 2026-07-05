/**
 * アプリ内自動更新 (#705) の「確認ダイアログ → 承認時にダウンロード・適用・再起動」
 * という UI フローを 1 か所に集約する。起動時チェック (`App.tsx`) と設定画面の手動
 * チェック (`SettingsView`) の両方から呼ばれ、i18n 文言と Toast/Confirm の使い方を
 * 揃えるためのグルー層。副作用の実体 (プラグイン呼び出し) は `../updater.ts` に、
 * 純粋な整形は `../updaterFormat.ts` にある。
 */
import type { ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import type { useConfirm } from "./ConfirmDialog";
import type { useToast } from "./Toast";
import type { useT } from "../i18n";
import { dismissUpdate, installUpdateAndRestart, type AvailableUpdate } from "../updater";
import { displayVersion, truncateReleaseNotes } from "../updaterFormat";

type Translate = ReturnType<typeof useT>;
type ToastApi = ReturnType<typeof useToast>;
type ConfirmFn = ReturnType<typeof useConfirm>["confirm"];

export interface UpdatePromptDeps {
  t: Translate;
  toast: ToastApi;
  confirm: ConfirmFn;
}

/**
 * 更新がある状態から、ユーザ承認を得てダウンロード・適用・再起動まで進める。
 *   - 承認されなければ確保したリソースを解放して何もしない。
 *   - 承認されたら進行中トーストを出し、`installUpdateAndRestart` を呼ぶ (成功時は
 *     relaunch でプロセスが差し替わるため通常は戻らない)。失敗 (署名検証失敗・
 *     ネットワーク断など) はエラートーストで知らせる。
 */
export async function confirmAndInstallUpdate(
  update: AvailableUpdate,
  deps: UpdatePromptDeps,
): Promise<void> {
  const { t, toast, confirm } = deps;
  const notes = truncateReleaseNotes(update.body);
  const message: ReactNode = (
    <chakra.div display="flex" flexDirection="column" gap="3">
      <chakra.p>
        {t("updateAvailableMessage", {
          version: displayVersion(update.version),
          current: displayVersion(update.currentVersion),
        })}
      </chakra.p>
      {notes && (
        <chakra.div>
          <chakra.p fontWeight="semibold" mb="1">
            {t("updateReleaseNotesLabel")}
          </chakra.p>
          <chakra.pre
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            fontSize="sm"
            maxHeight="12rem"
            overflowY="auto"
            padding="2"
            borderRadius="sm"
            bg="bg.subtle"
            color="fg.muted"
          >
            {notes}
          </chakra.pre>
        </chakra.div>
      )}
    </chakra.div>
  );

  const ok = await confirm({
    title: t("updateAvailableTitle"),
    message,
    confirmLabel: t("updateDownloadAndRestart"),
    cancelLabel: t("updateLater"),
    tone: "primary",
  });
  if (!ok) {
    void dismissUpdate(update);
    return;
  }

  // 進行中は自動消滅しない (duration 0) トーストを出す。成功時は relaunch で
  // アプリごと消えるので残らない。
  toast.info(t("updateDownloadingStarted"), 0);
  try {
    await installUpdateAndRestart(update);
  } catch (e) {
    toast.error(t("updateFailed", { error: e instanceof Error ? e.message : String(e) }));
  }
}
