/**
 * SQL ノートブック (#2380) の説明セル用の最小 Markdown パーサ。
 *
 * ライブラリを足さず、見出し・段落・箇条書き・番号付き・コードブロック・引用・水平線と、
 * 強調・コード・リンクだけを扱う。**HTML は一切解釈しない**: 入力中の `<` `>` `&` はすべてテキスト扱いで、
 * 画面描画 (`MarkdownView`、React 要素のみ) も HTML 書き出し (`markdownToHtml`、エスケープ済み文字列) も
 * 同じ構文木から作るので、片方だけエスケープが抜ける事故を避けられる。
 *
 * 安全側の割り切り:
 * - リンクの URL は `http:` / `https:` / `mailto:` だけ通す。それ以外 (`javascript:` など) はリンクにせず文字として出す。
 * - 画像 (`![alt](url)`) は読み込みにつながるので解釈しない (HTML 書き出しが外部リソースを読まないため)。
 * - 入れ子のリストは持たない (インデントは無視して平らに並べる)。
 */

export type MdInline =
  | { t: "text"; v: string }
  | { t: "strong"; c: MdInline[] }
  | { t: "em"; c: MdInline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: MdInline[] };

export type MdBlock =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; c: MdInline[] }
  | { t: "p"; lines: MdInline[][] }
  | { t: "ul"; items: MdInline[][] }
  | { t: "ol"; items: MdInline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; lines: MdInline[][] }
  | { t: "hr" };

/** リンクとして通す URL か。`javascript:` / `data:` / 相対パスはすべて拒否する。 */
export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)[^\s]+$/i.test(href.trim());
}

/** 閉じ区切りを探す。直前がバックスラッシュなら無視する。 */
function indexOfClose(text: string, close: string, from: number): number {
  let i = text.indexOf(close, from);
  while (i > 0 && text[i - 1] === "\\") i = text.indexOf(close, i + 1);
  return i;
}

/** 行内要素を解釈する。解釈できない記号はそのまま文字として残す。 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // バックスラッシュエスケープ: 次の記号を文字として出す。
    if (ch === "\\" && i + 1 < text.length && /[\\`*_[\]()#!<>-]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = indexOfClose(text, "](", i + 1);
      if (close > i + 1) {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close + 1) {
          const href = text.slice(close + 2, urlEnd).trim();
          const label = text.slice(i + 1, close);
          flush();
          if (isSafeHref(href)) {
            out.push({ t: "link", href, c: parseInline(label) });
          } else {
            // 安全でない URL はリンクにせず、見えたまま文字として残す。
            out.push({ t: "text", v: `[${label}](${href})` });
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const end = indexOfClose(text, ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      // 単語の途中の `_` (snake_case) は強調にしない。
      const prev = i > 0 ? text[i - 1] : " ";
      const intraWord = ch === "_" && /\w/.test(prev);
      const end = intraWord ? -1 : indexOfClose(text, ch, i + 1);
      if (end > i + 1 && text[i + 1] !== " " && !(ch === "_" && /\w/.test(text[end + 1] ?? " "))) {
        flush();
        out.push({ t: "em", c: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

const FENCE_RE = /^(\s*)(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

/** Markdown 本文をブロック列にする。 */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  const isBlank = (l: string) => l.trim() === "";
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      const body: string[] = [];
      i += 1;
      // 閉じフェンスが無ければ末尾まで (入力途中でも壊れない)。
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ t: "code", lang: fence[3], v: body.join("\n") });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        t: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        c: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = !UL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i += 1;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const quoted: MdInline[][] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        quoted.push(parseInline(m[1]));
        i += 1;
      }
      blocks.push({ t: "quote", lines: quoted });
      continue;
    }
    // 段落: 空行か別のブロックが始まるまで。
    const para: MdInline[][] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i])
    ) {
      para.push(parseInline(lines[i].trim()));
      i += 1;
    }
    blocks.push({ t: "p", lines: para });
  }
  return blocks;
}

/** HTML の特殊文字を実体参照にする。テキストノードと属性値の両方に使える。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineToHtml(nodes: readonly MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return escapeHtml(n.v);
        case "code":
          return `<code>${escapeHtml(n.v)}</code>`;
        case "strong":
          return `<strong>${inlineToHtml(n.c)}</strong>`;
        case "em":
          return `<em>${inlineToHtml(n.c)}</em>`;
        case "link":
          return `<a href="${escapeHtml(n.href)}" rel="noopener noreferrer">${inlineToHtml(n.c)}</a>`;
      }
    })
    .join("");
}

function linesToHtml(lines: readonly MdInline[][]): string {
  return lines.map(inlineToHtml).join("<br>\n");
}

/** ブロック列を HTML 文字列にする。入力はすべてエスケープ済みで、`<script>` などは文字のまま出る。 */
export function markdownToHtml(blocks: readonly MdBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "heading":
          return `<h${b.level}>${inlineToHtml(b.c)}</h${b.level}>`;
        case "p":
          return `<p>${linesToHtml(b.lines)}</p>`;
        case "ul":
          return `<ul>${b.items.map((it) => `<li>${inlineToHtml(it)}</li>`).join("")}</ul>`;
        case "ol":
          return `<ol>${b.items.map((it) => `<li>${inlineToHtml(it)}</li>`).join("")}</ol>`;
        case "code":
          return `<pre><code>${escapeHtml(b.v)}</code></pre>`;
        case "quote":
          return `<blockquote>${linesToHtml(b.lines)}</blockquote>`;
        case "hr":
          return "<hr>";
      }
    })
    .join("\n");
}
