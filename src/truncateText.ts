/**
 * 表示用の文字列切り詰め (#1604)。UTF-16 のコード単位やコードポイントで切ると、
 * サロゲートペア・旗絵文字 (地域指示子 2 文字)・ZWJ 絵文字列・結合文字の途中で割れて、
 * 末尾に孤立した文字 (置換文字や意味のない記号) が残る。書記素クラスタ単位で切る。
 */

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

function makeSegmenter(): GraphemeSegmenter | null {
  // lib が ES2020 のため Intl.Segmenter の型が無い。実行環境に無ければ null (コードポイント単位で代替)。
  const Seg = (
    Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => GraphemeSegmenter }
  ).Segmenter;
  try {
    return Seg ? new Seg(undefined, { granularity: "grapheme" }) : null;
  } catch {
    return null;
  }
}

const segmenter = makeSegmenter();

/** 先頭 `max` 書記素を返す。収まるなら null (切り詰め不要)。 */
export function takeGraphemes(text: string, max: number): string | null {
  // UTF-16 長が max 以下なら書記素数も max 以下なので、安価に早期終了できる。
  if (text.length <= max) return null;
  const units: Iterable<string> = segmenter
    ? (function* () {
        for (const s of segmenter.segment(text)) yield s.segment;
      })()
    : Array.from(text);
  let out = "";
  let count = 0;
  for (const u of units) {
    if (count === max) return out;
    out += u;
    count++;
  }
  return null;
}
