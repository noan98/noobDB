// AI へ送る文字列の切り詰め。UTF-16 の長さで slice するとサロゲートペア (絵文字・BMP 外の漢字)
// が境界で割れて孤立サロゲートが残り、送信 JSON を壊しうるので、割れる位置は 1 文字ずらす。

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 先頭から最大 `max` 文字 (UTF-16 コードユニット) を残す。ペアを割る場合は 1 文字手前で切る。 */
export function sliceHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHigh(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/** 末尾から最大 `max` 文字 (UTF-16 コードユニット) を残す。ペアを割る場合は 1 文字短く残す。 */
export function sliceTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(start < text.length && isLow(text.charCodeAt(start)) ? start + 1 : start);
}
