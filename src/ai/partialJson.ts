// 受信途中 (閉じ括弧がまだ届いていない) の JSON から、トップレベルの文字列フィールドだけを
// 取り出す純関数 (#1470)。構造化出力の `explanation` などを、完了前に少しずつ見せるために使う。
// 厳密なパーサではない: 数値・真偽値・配列・入れ子のオブジェクトは読み飛ばす。

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

interface ScannedString {
  value: string;
  /** 終端の `"` まで読めたか。false は受信途中で切れている。 */
  closed: boolean;
  /** 次に読み始める位置。 */
  next: number;
}

/** `start` は開き `"` の位置。エスケープの途中で切れた末尾は捨てる。 */
function scanString(text: string, start: number): ScannedString {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') return { value: out, closed: true, next: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = text[i + 1];
    if (esc === undefined) break;
    if (esc === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += SIMPLE_ESCAPES[esc] ?? esc;
    i += 2;
  }
  // 末尾が上位サロゲート単独 (下位が未着) なら捨てる。表示で文字化けさせない。
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return { value: out, closed: false, next: text.length };
}

/**
 * 途中までの JSON オブジェクトから、トップレベルの文字列フィールドを `キー → 値` で返す。
 * 値が受信途中のフィールドは、そこまでに届いた分を返す。JSON オブジェクトで始まらない
 * 文字列 (前置きの空白は許す) では空のオブジェクトを返す。
 */
export function extractPartialJsonStrings(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;
  while (i < text.length && /\s/.test(text[i] as string)) i += 1;
  if (text[i] !== "{") return result;
  i += 1;
  // 1 = トップレベルのオブジェクト直下。配列・入れ子オブジェクトの中は 2 以上。
  let depth = 1;
  let pendingKey: string | null = null;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      const s = scanString(text, i);
      i = s.next;
      if (depth !== 1) continue;
      if (pendingKey === null) {
        // キーとして読む。閉じていないキーは値が来ないので捨てる。
        if (s.closed && /^\s*:/.test(text.slice(i))) pendingKey = s.value;
      } else {
        result[pendingKey] = s.value;
        pendingKey = null;
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 1) pendingKey = null;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) pendingKey = null;
    else if (depth === 1 && pendingKey !== null && ch !== ":" && !/\s/.test(ch)) {
      // 文字列以外の値 (数値・真偽値・null) は読み飛ばす。
      pendingKey = null;
    }
    i += 1;
  }
  return result;
}

/**
 * 表示用に、指定したフィールドの途中経過を空行区切りで連結する。まだ 1 つも届いていなければ空文字。
 * 複数指定した場合は届いたものだけを `fields` の順に並べる。
 */
export function partialJsonPreview(text: string, fields: readonly string[]): string {
  const all = extractPartialJsonStrings(text);
  return fields
    .map((f) => all[f])
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n\n");
}
