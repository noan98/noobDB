/**
 * 確定進捗 (done / total) を 0〜1 の割合へ変換する純ロジック (#1235)。
 * `DeterminateProgressBar` の `value` に渡す。総数が 0 以下・非有限の壊れた入力は
 * 0、負値・超過・NaN は [0, 1] へクランプする (ゼロ除算と幅の逆走を避ける)。
 */
export function progressRatio(done: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(total)) return 0;
  const ratio = done / total;
  if (!(ratio > 0)) return 0;
  return ratio > 1 ? 1 : ratio;
}
