/**
 * アプリ内自動更新 (#705) の「表示・整形」まわりの純粋ロジック。実際の Tauri
 * プラグイン呼び出し (`@tauri-apps/plugin-updater` / `plugin-process`) は
 * `updater.ts` に分離し、ここは副作用なし・Vitest で境界値を固定できる関数だけを
 * 持つ (通知の `queryNotify.ts` ⇔ `notifications.ts` と同じ分離方針)。
 */

/**
 * ダウンロード進捗をパーセント (0〜100 の整数) に変換する。合計サイズが不明
 * (0 以下 / 未指定 / 非有限) のときは `null` を返し、呼び出し側は「不定進捗」
 * として扱う。ダウンロード済みが合計を超えても 100 でクランプする。
 */
export function downloadProgressPercent(
  downloaded: number,
  contentLength: number | undefined,
): number | null {
  if (contentLength === undefined) return null;
  if (!Number.isFinite(contentLength) || contentLength <= 0) return null;
  if (!Number.isFinite(downloaded) || downloaded <= 0) return 0;
  const pct = Math.round((downloaded / contentLength) * 100);
  return Math.max(0, Math.min(100, pct));
}

/**
 * リリースノート (更新の `body`) を確認ダイアログ向けに整える。更新マニフェストは
 * 外部 (GitHub Releases) 由来なので、長大な本文で UI を壊さないよう先頭
 * `maxLen` 文字に切り詰め、前後の空白を落とす。空/未指定なら空文字を返す。
 */
export function truncateReleaseNotes(body: string | undefined, maxLen = 600): string {
  if (!body) return "";
  const trimmed = body.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

/**
 * バージョン文字列を表示用に整える。updater が返す `version` には稀に先頭 `v` が
 * 付くことがあるため取り除き、前後空白も落とす。空なら `?` にフォールバックして
 * UI 側の undefined 表示を防ぐ。
 */
export function displayVersion(version: string | undefined | null): string {
  if (!version) return "?";
  const v = version.trim().replace(/^v/i, "");
  return v.length > 0 ? v : "?";
}
