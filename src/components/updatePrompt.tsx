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
import { saveSkippedUpdateVersion } from "../updateSkip";
import { displayVersion, formatDownloadProgress, truncateReleaseNotes } from "../updaterFormat";

type Translate = ReturnType<typeof useT>;
type ToastApi = ReturnType<typeof useToast>;
type ConfirmFn = ReturnType<typeof useConfirm>["confirm"];
type ChooseFn = ReturnType<typeof useConfirm>["choose"];

export interface UpdatePromptDeps {
  t: Translate;
  toast: ToastApi;
  confirm: ConfirmFn;
  /** 3 択版 (`useConfirm().choose`)。`rememberSkip` のときに使う。 */
  choose?: ChooseFn;
  /**
   * 起動時の自動チェック用 (#1631)。true なら「このバージョンは見送る」ボタンを足し、押したときだけ
   * そのバージョンを覚えて、より新しい版が出るまで次回以降の起動では出さない。Esc / × / 「後で」は
   * 見送りにしない。設定画面の手動チェックでは指定しない (毎回見せる)。
   */
  rememberSkip?: boolean;
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
  const { t, toast, confirm, choose, rememberSkip } = deps;
  const notes = truncateReleaseNotes(update.body);
  const message: ReactNode = (
    <chakra.div display="flex" flexDirection="column" gap="3">
      <chakra.p>
        {t("updateAvailableMessage", {
          version: displayVersion(update.version),
          current: displayVersion(update.currentVersion),
        })}
      </chakra.p>
      {rememberSkip && <chakra.p color="app.textMuted">{t("updateLaterSkipNote")}</chakra.p>}
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
            bg="app.surfaceMuted"
            color="app.textSecondary"
          >
            {notes}
          </chakra.pre>
        </chakra.div>
      )}
    </chakra.div>
  );

  const dialogOpts = {
    title: t("updateAvailableTitle"),
    message,
    confirmLabel: t("updateDownloadAndRestart"),
    cancelLabel: t("updateLater"),
    tone: "primary" as const,
  };
  let ok: boolean;
  if (rememberSkip && choose) {
    const choice = await choose({ ...dialogOpts, altLabel: t("updateSkipVersion") });
    // 見送りは「このバージョンは見送る」を押したときだけ。Esc / × / 後で は次回も出す。
    if (choice === "alt") saveSkippedUpdateVersion(update.version);
    ok = choice === "confirm";
  } else {
    ok = await confirm(dialogOpts);
  }
  if (!ok) {
    void dismissUpdate(update);
    return;
  }

  // 進行中は自動消滅しない (duration 0) トーストを出す。成功時は relaunch で
  // アプリごと消えるので残らない。失敗時は id で閉じてからエラーを出し、「ダウンロード中」
  // と「失敗」が並んで残らないようにする (#1534)。
  const progressId = toast.info(t("updateDownloadingStarted"), 0);
  try {
    let lastText = "";
    await installUpdateAndRestart(update, (progress) => {
      // 合計サイズが不明 (percent が null) の間は従来の不定表示のまま。
      const text = formatDownloadProgress(progress, t);
      if (text === null || text === lastText) return;
      lastText = text;
      toast.update(progressId, text);
    });
  } catch (e) {
    toast.dismiss(progressId);
    toast.error(t("updateFailed", { error: e instanceof Error ? e.message : String(e) }));
  }
}
