/**
 * アプリ内自動更新 (#705) の副作用層。判定/整形の純粋ロジックは
 * `updaterFormat.ts` に分離済みで、ここは `@tauri-apps/plugin-updater` /
 * `@tauri-apps/plugin-process` / `@tauri-apps/api/app` への薄いラッパーのみを持つ。
 * 既存の `dialog` / `notification` プラグインと同じく、Tauri プラグインは
 * `api/tauri.ts` の IPC ラッパー方針の対象外 (Rust コマンドではなくプラグイン自体の
 * JS API) として直接 import する。
 *
 * 方針 (#705 の受け入れ基準):
 *   - 起動時チェックはベストエフォート。ネットワーク不通・マニフェスト取得失敗は
 *     静かに無視し、起動をブロックしない。
 *   - ダウンロード・適用・再起動は**必ずユーザ承認を得てから**。この層は勝手に
 *     再起動しない (`installUpdateAndRestart` を呼ぶのは承認後のみ)。
 *   - 署名検証に失敗した更新はプラグインが適用しない (この層は例外として受け取る)。
 */
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { downloadProgressPercent } from "./updaterFormat";

export interface AvailableUpdate {
  /** 配布されている新しいバージョン。 */
  version: string;
  /** いま動いているバージョン。 */
  currentVersion: string;
  /** リリース日 (マニフェストにあれば)。 */
  date?: string;
  /** リリースノート (マニフェストにあれば)。 */
  body?: string;
  /** 内部利用: ダウンロード/インストール/解放に使うプラグインリソース。 */
  handle: Update;
}

/** 実行中アプリのバージョンを返す。取得に失敗した場合は null (UI 側で「不明」表示)。 */
export async function getCurrentAppVersion(): Promise<string | null> {
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

/**
 * 更新を確認する。更新があれば {@link AvailableUpdate}、無ければ (最新なら) null を
 * 返す。**チェック自体が失敗した場合は例外を投げる** ので、呼び出し側は「最新です
 * (null)」と「確認できませんでした (throw)」を区別できる:
 *   - 起動時の自動チェックは例外を握りつぶして静かに無視 (オフライン耐性)。
 *   - 設定画面の手動チェックはエラーをトーストで知らせ、null は「最新です」と表示。
 */
export async function checkForAppUpdate(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    body: update.body,
    handle: update,
  };
}

export interface InstallProgress {
  /** 0〜100 の整数。合計サイズが不明なときは null (不定進捗として扱う)。 */
  percent: number | null;
  /** これまでにダウンロードしたバイト数。 */
  downloadedBytes: number;
  /** 合計バイト数 (マニフェスト/レスポンスに含まれない場合は undefined)。 */
  totalBytes: number | undefined;
}

/**
 * 更新をダウンロード → インストールし、完了後にアプリを再起動する。**必ずユーザ
 * 承認を得てから**呼ぶこと (この関数自体は確認ダイアログを出さない)。進捗は
 * `onProgress` で通知する。ネットワーク断・**署名検証失敗**などで失敗した場合は
 * 例外を投げる (検証に失敗した更新はプラグインが適用しないため、ここには成功が
 * 返ってこない)。成功時は `relaunch()` によりプロセスが差し替わるため、この関数は
 * 通常は戻らない。
 */
export async function installUpdateAndRestart(
  update: AvailableUpdate,
  onProgress?: (progress: InstallProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.handle.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength;
        downloaded = 0;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        break;
      case "Finished":
        // ダウンロード完了。以降はプラグインがインストールを進める。
        break;
    }
    onProgress?.({
      percent: downloadProgressPercent(downloaded, total),
      downloadedBytes: downloaded,
      totalBytes: total,
    });
  });
  await relaunch();
}

/**
 * ユーザが更新を見送ったときに、確保したプラグインリソースを解放する
 * (ベストエフォート — 失敗しても無視)。次回チェックでは新しいリソースが作られる。
 */
export async function dismissUpdate(update: AvailableUpdate): Promise<void> {
  try {
    await update.handle.close();
  } catch {
    // 解放に失敗してもアプリ動作には影響しない。
  }
}
