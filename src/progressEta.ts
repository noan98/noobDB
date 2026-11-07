// 長時間処理 (チャンク DML・ダンプ) の進捗表示用の純関数 (#2092)。
// 表示層から切り離して境界ケース (速度 0・総数不明・完了済み) を単体テストできるようにする。

/** 完了割合 (0〜1)。総数が不明・0 以下なら null (バーを出さない)。範囲外はクランプする。 */
export function progressRatio(done: number, total: number | null | undefined): number | null {
  if (total == null || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(done) || done <= 0) return 0;
  return Math.min(1, done / total);
}

/**
 * 残り時間の推定 (ミリ秒)。これまでの平均速度 (done / elapsed) が続くと仮定する。
 * - 総数不明・速度 0 (まだ 1 件も進んでいない / 経過 0) は推定不能で null。
 * - すでに total に達していれば 0。
 * スロットル待機も経過に含まれるので、待機を挟むほど推定も長くなる (実時間の見積り)。
 */
export function estimateEtaMs(
  done: number,
  total: number | null | undefined,
  elapsedMs: number,
): number | null {
  if (total == null || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(done) || !Number.isFinite(elapsedMs)) return null;
  if (done >= total) return 0;
  if (done <= 0 || elapsedMs <= 0) return null;
  return Math.round((elapsedMs * (total - done)) / done);
}

/** 秒数表記 `m:ss` / `h:mm:ss` (ロケール非依存)。負値・非有限値は 0:00。 */
export function formatDuration(ms: number): string {
  const secs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** スロットル待機の残り秒 (切り上げ)。待機中でなければ null、期限を過ぎていれば 0。 */
export function waitSecondsLeft(waitUntil: number | null, now: number): number | null {
  if (waitUntil == null) return null;
  return Math.max(0, Math.ceil((waitUntil - now) / 1000));
}

/** 1 秒あたりの処理件数。経過が 1 秒未満 (まだ測れない)・非有限値は null。 */
export function ratePerSecond(done: number, elapsedMs: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(elapsedMs) || elapsedMs < 1000) return null;
  return Math.max(0, done) / (elapsedMs / 1000);
}
