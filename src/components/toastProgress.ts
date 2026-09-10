/**
 * アクション付きトースト (Undo 等、#676) の残り時間プログレスレール (#983) が
 * 使う純ロジック。`Toast.tsx` の `timerMeta` (remaining ms / startedAt) から、
 * レールの「開始比率」と「アニメーション秒数」を導出するだけの計算で、React の
 * render サイクルにもタイマーの実体にも依存しない (Vitest で完結)。
 *
 * `Toast.tsx` 側は、タイマーを arm/resume した瞬間の `remaining` (ms) をそのまま
 * この 2 関数へ渡す: `railRatio` がレールの開始位置 (満量に対する割合)、
 * `railDurationSeconds` がそこから 0 へ縮むアニメーションの所要秒数になる。
 * pause 時は `remaining` が既に経過分だけ差し引かれた「凍結値」になっている
 * (`pauseTimer` 参照) ため、同じ `railRatio` をそのまま静止位置として使える。
 */

/**
 * 残り時間 (ms) を全体の時間 (ms) に対する比率へ変換する。`totalMs` が 0 以下の
 * 壊れた入力では常に 0 を返し、`remainingMs` が負値/NaN/超過なら [0, 1] へ
 * クランプする。
 */
export function railRatio(remainingMs: number, totalMs: number): number {
  if (!(totalMs > 0)) return 0;
  const ratio = remainingMs / totalMs;
  if (!(ratio > 0)) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * 残り時間 (ms) を motion の `transition.duration` (秒) へ変換する。負値/0/NaN は
 * 0 にクランプし、アニメーションが逆走したり一瞬だけ乱れて見えるのを防ぐ。
 */
export function railDurationSeconds(remainingMs: number): number {
  return remainingMs > 0 ? remainingMs / 1000 : 0;
}
