import { describe, expect, it } from "vitest";
import { buildSnapshot, createEmptyNotebook, newMarkdownCell, newSqlCell } from "../notebook";
import { notebookToHtml, notebookToMarkdown, type NotebookExportText } from "../notebookExport";

const text: NotebookExportText = {
  untitled: "無題",
  snapshotMeta: (s) => `実行 ${s.totalRows} 行`,
  truncated: (a, b) => `先頭 ${a} / 全 ${b}`,
  error: (m) => `エラー: ${m}`,
  affected: (n) => `${n} 行に影響`,
  notRun: "未実行",
  masked: (c) => `伏せ字: ${c}`,
  exportedAt: (t) => `書き出し ${t}`,
  connection: (n) => `接続: ${n}`,
  autoLimit: (n) => `自動 LIMIT ${n}`,
  valuesTruncated: (n) => `${n} 文字で切り詰め`,
};

function build() {
  const d = createEmptyNotebook({ profileId: "p", name: "dev" });
  d.title = "<b>調査</b>";
  const sql = newSqlCell("SELECT '<img src=x onerror=alert(1)>' AS c, 1 AS n");
  sql.snapshot = buildSnapshot(
    {
      columns: [
        { name: "c", type_name: "text" },
        { name: "n", type_name: "int" },
      ],
      rows: [["<script>alert(1)</script>", null]],
      totalRows: 5,
      rowsAffected: 0,
      hasColumns: true,
      elapsedMs: 2,
    },
    1,
    { enabled: false, patterns: [] },
    new Date("2026-01-02T03:04:05Z"),
  );
  d.cells = [newMarkdownCell("## 手順\n\n- 確認"), sql, newSqlCell("SELECT 2")];
  return d;
}

describe("書き出し (#2380)", () => {
  it("Markdown は 説明 → SQL → 結果表 の順に並ぶ", () => {
    const md = notebookToMarkdown(build(), text, new Date("2026-01-02T03:04:05Z"));
    const iNote = md.indexOf("## 手順");
    const iSql = md.indexOf("```sql");
    const iTable = md.indexOf("| c | n |");
    expect(iNote).toBeGreaterThan(0);
    expect(iSql).toBeGreaterThan(iNote);
    expect(iTable).toBeGreaterThan(iSql);
    expect(md).toContain("先頭 1 / 全 5");
    expect(md).toContain("未実行");
  });

  it("HTML はユーザ由来の文字列をすべてエスケープし、外部リソースを読まない", () => {
    const html = notebookToHtml(build(), text, "ja", new Date("2026-01-02T03:04:05Z"));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>調査");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;調査&lt;/b&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(link|script|img|iframe|object|embed)\b|@import|url\(/i);
    expect(html).toContain("NULL");
    // 説明 → SQL → 結果の順
    expect(html.indexOf("手順")).toBeLessThan(html.indexOf("<pre>"));
    expect(html.indexOf("<pre>")).toBeLessThan(html.indexOf("<table>"));
  });

  it("SQL に ``` が含まれても Markdown のフェンスが壊れない", () => {
    const d = createEmptyNotebook(null);
    d.cells = [newSqlCell("SELECT '```' ")];
    expect(notebookToMarkdown(d, text)).toContain("````sql");
  });

  it("Markdown の NULL 表記は画面と同じ NULL で、エラーは 1 行の引用に収まる", () => {
    const d = build();
    const err = newSqlCell("SELECT bad");
    err.snapshot = {
      ...(d.cells[1] as { snapshot: NonNullable<ReturnType<typeof newSqlCell>["snapshot"]> }).snapshot,
      error: "line1\nline2\n```\n| x |",
      rows: [],
      columns: [],
    };
    d.cells = [err, d.cells[1]];
    const md = notebookToMarkdown(d, text, new Date("2026-01-02T03:04:05Z"));
    expect(md).toContain("NULL");
    const errLine = md.split("\n").filter((l) => l.startsWith("> ") && l.includes("エラー"));
    expect(errLine).toHaveLength(1);
    expect(errLine[0]).toContain("line1 line2");
  });
});
