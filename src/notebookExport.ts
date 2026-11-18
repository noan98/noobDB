/**
 * SQL ノートブック (#2380) の書き出し (Markdown / 自己完結 HTML)。説明・SQL・結果表の順に並べた文書にする。
 *
 * - Markdown: 結果は GFM の表 (`buildMarkdownTable`、エクスポートと同じエスケープ)。
 * - HTML: 外部リソースを読まない 1 ファイル。ユーザ由来の文字列はすべて `escapeHtml` を通し、
 *   CSP (`default-src 'none'`) でスクリプトや外部読み込みも止める。色は CSS のシステムカラーだけを使う。
 * 画面の文言は呼び出し側 (i18n) から `NotebookExportText` で受け取り、この中は純関数にしている。
 */
import { buildMarkdownTable } from "./components/exportPreview";
import { defaultChartConfig, inferNumericColumns } from "./components/chartData";
import { type SqlHighlightSegment, sqlHighlightLines } from "./components/sqlHighlight";
import { type MdBlock, type MdInline, escapeHtml, markdownToHtml, parseMarkdown } from "./markdownLite";
import { buildChartFigure } from "./notebookChartSvg";
import { DEFAULT_SYNTAX_COLORS, type SyntaxColors } from "./settings";
import {
  MAX_SNAPSHOT_CELL_CHARS,
  type NotebookCell,
  type NotebookDoc,
  type NotebookSnapshot,
  type StaleReason,
  snapshotFreshness,
} from "./notebook";
import type { CellValue } from "./api/tauri";

/** セルの実行先ドライバ (SQL の比較の字句規則に使う)。分からなければ undefined。 */
export type DriverOf = (cell: Extract<NotebookCell, { kind: "sql" }>) => string | undefined;

export interface NotebookExportText {
  /** 文書のタイトルが空のときの見出し。 */
  untitled: string;
  /** 例: `実行: 2026-01-01 10:00 / 12 行 / 35 ms`。 */
  snapshotMeta: (s: NotebookSnapshot, executedAt: string) => string;
  /** 例: `先頭 200 行のみ保存 (全 1000 行)`。 */
  truncated: (shown: number, total: number) => string;
  /** 例: `エラー: ...`。 */
  error: (message: string) => string;
  /** 結果セットが無かったとき。例: `3 行に影響`。 */
  affected: (rows: number) => string;
  /** 未実行のセル。 */
  notRun: string;
  /** 自動 LIMIT が掛かったとき。 */
  autoLimit: (limit: number) => string;
  /** 長い値を切り詰めたとき。 */
  valuesTruncated: (chars: number) => string;
  /** 伏せ字にした列。 */
  masked: (columns: string) => string;
  /** 書き出し時刻の行。 */
  exportedAt: (time: string) => string;
  /** 接続の行。 */
  connection: (name: string) => string;
  /** 結果が古いとき (SQL / 接続を実行後に変えた, #2420)。例: `注意: この結果は変更前の SQL のものです。`。 */
  stale: (reasons: readonly StaleReason[]) => string;
  /** SQL セルの番号バッジ (#2421)。例: `セル 3`。 */
  cellLabel: (n: number) => string;
  /** 目次の見出し (#2421)。 */
  toc: string;
  /** チャートを表で併記する `<details>` の見出し (#2421)。 */
  chartTable: string;
  /** チャート SVG の代替テキスト (#2421)。 */
  chartAria: string;
  /** Markdown 書き出しのチャートセルの注記 (#2421)。例: `チャート (書き出し非対応) — 表で表示`。 */
  chartNotExported: string;
}

/** ISO 時刻を `YYYY-MM-DD HH:mm` (UTC) にそろえる。解釈できなければそのまま。 */
export function formatSnapshotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 画面用のローカル時刻。 */
export function formatLocalSnapshotTime(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
}

/** SQL / コードを囲むフェンス。本文に含まれるバッククォートの連続より長くする。 */
function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function cellText(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export function notebookToMarkdown(
  doc: NotebookDoc,
  text: NotebookExportText,
  now: Date = new Date(),
  driverOf?: DriverOf,
): string {
  const parts: string[] = [];
  parts.push(`# ${doc.title.trim() || text.untitled}`);
  const meta = [text.exportedAt(formatSnapshotTime(now.toISOString()))];
  if (doc.connection) meta.push(text.connection(doc.connection.name));
  parts.push(meta.join(" / "));
  for (const cell of doc.cells) {
    if (cell.kind === "markdown") {
      if (cell.text.trim()) parts.push(cell.text.replace(/\r\n?/g, "\n").trimEnd());
      continue;
    }
    const fence = fenceFor(cell.sql);
    parts.push(`${fence}sql\n${cell.sql.trimEnd()}\n${fence}`);
    const s = cell.snapshot;
    if (!s) {
      parts.push(`_${text.notRun}_`);
      continue;
    }
    const lines = [`_${text.snapshotMeta(s, formatSnapshotTime(s.executedAt))}_`];
    if (cell.view === "chart" && s.hasColumns && !s.error) lines.push(`_${text.chartNotExported}_`);
    const fresh = snapshotFreshness(cell, driverOf?.(cell));
    if (fresh.kind === "stale") lines.push(`> **${text.stale(fresh.reasons).replace(/\s*\r?\n\s*/g, " ")}**`);
    if (s.error) {
      // 改行や記号で構造が崩れないよう、1 行に畳んだ引用にする。
      lines.push(`> ${text.error(s.error).replace(/\s*\r?\n\s*/g, " ")}`);
    } else if (s.hasColumns) {
      // 画面・HTML と同じく NULL は "NULL" と書く。
      const rows = s.rows.map((r) => r.map((v) => (v === null ? "NULL" : v)));
      lines.push(buildMarkdownTable(s.columns, rows).trimEnd());
      if (s.truncated) lines.push(`_${text.truncated(s.rows.length, s.totalRows)}_`);
      if (s.appliedAutoLimit !== null) lines.push(`_${text.autoLimit(s.appliedAutoLimit)}_`);
      if (s.valuesTruncated) lines.push(`_${text.valuesTruncated(MAX_SNAPSHOT_CELL_CHARS)}_`);
      if (s.maskedColumns.length > 0) lines.push(`_${text.masked(s.maskedColumns.join(", "))}_`);
    } else {
      lines.push(text.affected(s.rowsAffected));
    }
    parts.push(lines.join("\n\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

/** SQL のトークン配色 (アプリの既定テーマ値 `DEFAULT_SYNTAX_COLORS` から生成。色の単一ソースは settings.ts)。 */
export function syntaxCss(colors: { light: SyntaxColors; dark: SyntaxColors }): string {
  const vars = (c: SyntaxColors) =>
    (Object.keys(c) as (keyof SyntaxColors)[]).map((k) => `--syn-${k}:${c[k]};`).join("");
  return `:root{${vars(colors.light)}}@media (prefers-color-scheme: dark){:root{${vars(colors.dark)}}}`;
}

const HTML_STYLE = `
${syntaxCss(DEFAULT_SYNTAX_COLORS)}
:root { color-scheme: light dark; --line: color-mix(in srgb, CanvasText 22%, transparent); --soft: color-mix(in srgb, CanvasText 6%, transparent); }
body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; background: Canvas; color: CanvasText; }
h1 { font-size: 1.6rem; }
.meta, .note { color: GrayText; font-size: 0.85rem; }
pre { background: var(--soft); padding: 0.75rem 1rem; border-radius: 0.4rem; overflow-x: auto; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
.t-keyword { color: var(--syn-keyword, currentColor); font-weight: bold; }
.t-string { color: var(--syn-string, currentColor); }
.t-number { color: var(--syn-number, currentColor); }
.t-comment { color: var(--syn-comment, currentColor); font-style: italic; }
.t-function { color: var(--syn-function, currentColor); }
.t-operator { color: var(--syn-operator, currentColor); }
blockquote { margin-left: 0; padding-left: 1rem; border-left: 0.2rem solid var(--line); color: GrayText; }
nav.toc { border: 1px solid var(--line); border-radius: 0.4rem; padding: 0.5rem 1rem; margin: 1rem 0; font-size: 0.9rem; }
nav.toc ul { list-style: none; margin: 0; padding-left: 1rem; }
nav.toc > ul { padding-left: 0; }
nav.toc .toc-title { font-weight: 600; }
section { margin: 1.25rem 0; }
.cellhead { margin: 0 0 0.25rem; font-size: 0.8rem; }
.badge { display: inline-block; padding: 0 0.5rem; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); font-weight: 600; }
table { border-collapse: collapse; font-size: 0.85rem; }
.result { overflow: auto; max-height: 28rem; margin-bottom: 1rem; }
th, td { border: 1px solid var(--line); padding: 0.25rem 0.6rem; text-align: left; vertical-align: top; }
th { background: Canvas; position: sticky; top: 0; box-shadow: inset 0 -1px 0 var(--line); }
tbody tr:nth-child(even) td { background: var(--soft); }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
td .nullbadge { color: GrayText; font-size: 0.75em; padding: 0 0.35rem; border-radius: 0.25rem; background: color-mix(in srgb, CanvasText 10%, transparent); }
.stale { font-weight: 600; border: 1px solid GrayText; border-radius: 0.3rem; padding: 0.25rem 0.6rem; }
.error { font-weight: 600; border-left: 0.2rem solid GrayText; padding-left: 0.6rem; }
figure.chart { margin: 0.5rem 0; }
figure.chart svg { width: 100%; height: auto; max-width: 40rem; }
figure.chart .tick { font-size: 11px; fill: CanvasText; }
figure.chart .grid { stroke: var(--line); stroke-width: 1; }
figure.chart .axis { stroke: GrayText; stroke-width: 1; }
figure.chart .line { fill: none; stroke-width: 2; }
figure.chart .fade { fill-opacity: 0.35; }
figure.chart .slice { stroke: Canvas; stroke-width: 1; }
figure.chart .legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; padding: 0; margin: 0.25rem 0; font-size: 0.8rem; }
figure.chart .sw { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 2px; margin-right: 0.3rem; }
details > summary { cursor: pointer; color: GrayText; font-size: 0.85rem; }
@media print {
  body { max-width: none; margin: 0; }
  section { break-inside: avoid-page; }
  pre { white-space: pre-wrap; overflow: visible; }
  .result { overflow: visible; max-height: none; }
  table { width: 100%; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { position: static; }
  h1, h2, h3 { break-after: avoid; }
}
`;

/** 数値として右寄せする列。`inferNumericColumns` と同じ判定 (画面のチャートと揃える)。 */
function numericColumns(s: NotebookSnapshot): boolean[] {
  return inferNumericColumns(s.columns, s.rows);
}

function sqlToHtml(sql: string, driver: string | undefined): string {
  const body = sql.trimEnd();
  const lines = sqlHighlightLines(body.split("\n"), driver ?? "");
  if (!lines) return `<pre><code>${escapeHtml(body)}</code></pre>`;
  const seg = (g: SqlHighlightSegment) =>
    g.kind === null ? escapeHtml(g.text) : `<span class="t-${g.kind}">${escapeHtml(g.text)}</span>`;
  return `<pre><code>${lines.map((l) => l.map(seg).join("")).join("\n")}</code></pre>`;
}

function inlineText(inl: readonly MdInline[]): string {
  return inl.map((i) => (i.t === "text" || i.t === "code" ? i.v : inlineText(i.c))).join("");
}

interface TocEntry {
  level: number;
  text: string;
  id: string;
}

/** Markdown セルのブロックを HTML にする。見出しには目次用の id を付けて `toc` へ集める。 */
function markdownCellToHtml(blocks: readonly MdBlock[], toc: TocEntry[]): string {
  return blocks
    .map((b) => {
      const html = markdownToHtml([b]);
      if (b.t !== "heading") return html;
      const id = `nb-h-${toc.length + 1}`;
      toc.push({ level: b.level, text: inlineText(b.c), id });
      return html.replace(/^<h([1-6])>/, `<h$1 id="${id}">`);
    })
    .join("\n");
}

function tocToHtml(toc: readonly TocEntry[], title: string): string {
  if (toc.length < 2) return "";
  const min = Math.min(...toc.map((t) => t.level));
  const items = toc
    .map(
      (t) =>
        `<li style="padding-left:${(t.level - min) * 1}rem"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`,
    )
    .join("");
  return `<nav class="toc"><div class="toc-title">${escapeHtml(title)}</div><ul>${items}</ul></nav>`;
}

function tableToHtml(s: NotebookSnapshot): string {
  const num = numericColumns(s);
  const head = s.columns
    .map((c, i) => `<th${num[i] ? ' class="num"' : ""}>${escapeHtml(c.name)}</th>`)
    .join("");
  const body = s.rows
    .map(
      (r) =>
        `<tr>${s.columns
          .map((_, i) => {
            const v = r[i] ?? null;
            if (v === null)
              return `<td${num[i] ? ' class="num"' : ""}><span class="nullbadge">NULL</span></td>`;
            return `<td${num[i] ? ' class="num"' : ""}>${escapeHtml(cellText(v))}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("\n");
  return `<div class="result"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function snapshotToHtml(
  cell: Extract<NotebookCell, { kind: "sql" }>,
  text: NotebookExportText,
  driverOf: DriverOf | undefined,
  chartScope: string,
): string {
  const s = cell.snapshot;
  if (!s) return `<p class="note">${escapeHtml(text.notRun)}</p>`;
  const out = [`<p class="meta">${escapeHtml(text.snapshotMeta(s, formatSnapshotTime(s.executedAt)))}</p>`];
  const fresh = snapshotFreshness(cell, driverOf?.(cell));
  if (fresh.kind === "stale") out.push(`<p class="stale">${escapeHtml(text.stale(fresh.reasons))}</p>`);
  if (s.error) {
    out.push(`<p class="error">${escapeHtml(text.error(s.error))}</p>`);
  } else if (s.hasColumns) {
    const table = tableToHtml(s);
    const fig =
      cell.view === "chart"
        ? (() => {
            const cfg = cell.chart ?? defaultChartConfig(s.columns, s.rows);
            return cfg ? buildChartFigure(s.columns, s.rows, cfg, chartScope, text.chartAria) : null;
          })()
        : null;
    out.push(
      fig
        ? `${fig.html}\n<details><summary>${escapeHtml(text.chartTable)}</summary>\n${table}\n</details>`
        : table,
    );
    if (s.truncated)
      out.push(`<p class="note">${escapeHtml(text.truncated(s.rows.length, s.totalRows))}</p>`);
    if (s.appliedAutoLimit !== null) {
      out.push(`<p class="note">${escapeHtml(text.autoLimit(s.appliedAutoLimit))}</p>`);
    }
    if (s.valuesTruncated) {
      out.push(`<p class="note">${escapeHtml(text.valuesTruncated(MAX_SNAPSHOT_CELL_CHARS))}</p>`);
    }
    if (s.maskedColumns.length > 0) {
      out.push(`<p class="note">${escapeHtml(text.masked(s.maskedColumns.join(", ")))}</p>`);
    }
  } else {
    out.push(`<p>${escapeHtml(text.affected(s.rowsAffected))}</p>`);
  }
  return out.join("\n");
}

export function notebookToHtml(
  doc: NotebookDoc,
  text: NotebookExportText,
  lang: string,
  now: Date = new Date(),
  driverOf?: DriverOf,
): string {
  const title = doc.title.trim() || text.untitled;
  const meta = [text.exportedAt(formatSnapshotTime(now.toISOString()))];
  if (doc.connection) meta.push(text.connection(doc.connection.name));
  const body: string[] = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${escapeHtml(meta.join(" / "))}</p>`,
  ];
  const toc: TocEntry[] = [];
  const sections: string[] = [];
  let sqlNo = 0;
  for (const cell of doc.cells) {
    if (cell.kind === "markdown") {
      if (cell.text.trim())
        sections.push(`<section>\n${markdownCellToHtml(parseMarkdown(cell.text), toc)}\n</section>`);
    } else {
      sqlNo += 1;
      sections.push(
        `<section>\n<p class="cellhead"><span class="badge">${escapeHtml(text.cellLabel(sqlNo))}</span></p>\n${sqlToHtml(cell.sql, driverOf?.(cell))}\n${snapshotToHtml(cell, text, driverOf, `ch${sqlNo}`)}\n</section>`,
      );
    }
  }
  const tocHtml = tocToHtml(toc, text.toc);
  if (tocHtml) body.push(tocHtml);
  body.push(...sections);
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}
