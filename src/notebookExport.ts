/**
 * SQL ノートブック (#2380) の書き出し (Markdown / 自己完結 HTML)。説明・SQL・結果表の順に並べた文書にする。
 *
 * - Markdown: 結果は GFM の表 (`buildMarkdownTable`、エクスポートと同じエスケープ)。
 * - HTML: 外部リソースを読まない 1 ファイル。ユーザ由来の文字列はすべて `escapeHtml` を通し、
 *   CSP (`default-src 'none'`) でスクリプトや外部読み込みも止める。色は CSS のシステムカラーだけを使う。
 * 画面の文言は呼び出し側 (i18n) から `NotebookExportText` で受け取り、この中は純関数にしている。
 */
import { buildMarkdownTable } from "./components/exportPreview";
import { escapeHtml, markdownToHtml, parseMarkdown } from "./markdownLite";
import {
  MAX_SNAPSHOT_CELL_CHARS,
  type NotebookCell,
  type NotebookDoc,
  type NotebookSnapshot,
} from "./notebook";
import type { CellValue } from "./api/tauri";

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

const HTML_STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; background: Canvas; color: CanvasText; }
h1 { font-size: 1.6rem; }
.meta, .note { color: GrayText; font-size: 0.85rem; }
pre { background: color-mix(in srgb, CanvasText 6%, transparent); padding: 0.75rem 1rem; border-radius: 0.4rem; overflow-x: auto; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
blockquote { margin-left: 0; padding-left: 1rem; border-left: 0.2rem solid color-mix(in srgb, CanvasText 25%, transparent); color: GrayText; }
table { border-collapse: collapse; font-size: 0.85rem; }
.result { overflow-x: auto; margin-bottom: 1rem; }
th, td { border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); padding: 0.25rem 0.6rem; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, CanvasText 8%, transparent); }
td.null { color: GrayText; font-style: italic; }
.error { font-weight: 600; border-left: 0.2rem solid GrayText; padding-left: 0.6rem; }
`;

function snapshotToHtml(cell: Extract<NotebookCell, { kind: "sql" }>, text: NotebookExportText): string {
  const s = cell.snapshot;
  if (!s) return `<p class="note">${escapeHtml(text.notRun)}</p>`;
  const out = [`<p class="meta">${escapeHtml(text.snapshotMeta(s, formatSnapshotTime(s.executedAt)))}</p>`];
  if (s.error) {
    out.push(`<p class="error">${escapeHtml(text.error(s.error))}</p>`);
  } else if (s.hasColumns) {
    const head = s.columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("");
    const body = s.rows
      .map(
        (r) =>
          `<tr>${s.columns
            .map((_, i) => {
              const v = r[i] ?? null;
              return v === null ? `<td class="null">NULL</td>` : `<td>${escapeHtml(cellText(v))}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("\n");
    out.push(
      `<div class="result"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`,
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
): string {
  const title = doc.title.trim() || text.untitled;
  const meta = [text.exportedAt(formatSnapshotTime(now.toISOString()))];
  if (doc.connection) meta.push(text.connection(doc.connection.name));
  const body: string[] = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${escapeHtml(meta.join(" / "))}</p>`,
  ];
  for (const cell of doc.cells) {
    if (cell.kind === "markdown") {
      if (cell.text.trim()) body.push(`<section>\n${markdownToHtml(parseMarkdown(cell.text))}\n</section>`);
    } else {
      body.push(
        `<section>\n<pre><code>${escapeHtml(cell.sql.trimEnd())}</code></pre>\n${snapshotToHtml(cell, text)}\n</section>`,
      );
    }
  }
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
