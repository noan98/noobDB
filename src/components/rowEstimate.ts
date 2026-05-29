/**
 * 概算レコード数のコンパクト表示ヘルパー。
 *
 * テーブルツリーのバッジは「正確な行数」ではなく、DB エンジンが統計情報として
 * 保持している概算値 (COUNT(*) 非実行) を出すため、桁を縮めた近似表記にする。
 * 純粋関数として切り出してあるので Vitest で挙動を固定できる。
 */

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * 概算行数をバッジ向けの短い文字列にする。
 *
 * - 0 はそのまま `"0"` (空テーブルであることを近似記号なしで明示)。
 * - それ以外は `~` を前置した概算であることが分かる表記 (例: `~1.2K`, `~3M`)。
 *
 * 負値や非有限値 (NaN / Infinity) は推定値として無意味なので空文字を返し、
 * 呼び出し側はバッジ自体を出さない判断ができる。
 */
export function formatRowEstimate(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "0";
  return `~${compactFmt.format(n)}`;
}
