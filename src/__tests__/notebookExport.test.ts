import { describe, expect, it } from "vitest";
import { buildSnapshot, createEmptyNotebook, newMarkdownCell, newSqlCell } from "../notebook";
import { buildChartFigure } from "../notebookChartSvg";
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
  stale: (r) => `古い結果: ${r.join("+")}`,
  cellLabel: (n) => `セル ${n}`,
  toc: "目次",
  chartTable: "表で表示",
  chartMore: (n) => `ほか ${n} 件`,
  chartAria: "チャート",
  chartNotExported: "チャート (書き出し非対応) — 表で表示",
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

  it("HTML にも自動 LIMIT と値の切り詰めの警告が出る (Markdown と同じ)", () => {
    const d = build();
    const cell = d.cells[1] as { snapshot: NonNullable<ReturnType<typeof newSqlCell>["snapshot"]> };
    cell.snapshot = { ...cell.snapshot, appliedAutoLimit: 1000, valuesTruncated: true };
    const html = notebookToHtml(d, text, "ja", new Date("2026-01-02T03:04:05Z"));
    expect(html).toContain("自動 LIMIT 1000");
    expect(html).toContain("2000 文字で切り詰め");
    const md = notebookToMarkdown(d, text, new Date("2026-01-02T03:04:05Z"));
    expect(md).toContain("自動 LIMIT 1000");
    // 警告が無いスナップショットでは出さない
    const plain = notebookToHtml(build(), text, "ja", new Date("2026-01-02T03:04:05Z"));
    expect(plain).not.toContain("自動 LIMIT");
    expect(plain).not.toContain("文字で切り詰め");
  });
});

describe("古い結果の注記 (#2420)", () => {
  function withStale(executed: string, current: string) {
    const d = createEmptyNotebook(null);
    const c = newSqlCell(current);
    c.snapshot = buildSnapshot(
      {
        columns: [{ name: "n", type_name: "int" }],
        rows: [[1]],
        totalRows: 1,
        rowsAffected: 0,
        hasColumns: true,
        elapsedMs: 1,
      },
      10,
      { enabled: false, patterns: [] },
      new Date("2026-01-02T03:04:05Z"),
      { sql: executed, connection: null, database: null },
    );
    d.cells = [c];
    return d;
  }

  it("SQL を変えた後の結果は Markdown / HTML の両方で古いと読み取れる", () => {
    const d = withStale("SELECT 1", "SELECT 2");
    expect(notebookToMarkdown(d, text)).toContain("古い結果: sql");
    expect(notebookToHtml(d, text, "ja")).toContain('<p class="stale">古い結果: sql</p>');
  });

  it("同じ SQL (空白・末尾セミコロンの違いだけ) や実行時の SQL が不明な結果には注記しない", () => {
    expect(notebookToMarkdown(withStale("SELECT 1", "SELECT 1;"), text)).not.toContain("古い結果");
    expect(notebookToHtml(build(), text, "ja")).not.toContain("古い結果");
  });
});

describe("レポート仕上げ (#2421)", () => {
  const NOW = new Date("2026-01-02T03:04:05Z");
  function chartDoc(
    type: "bar" | "pie" | "line" | "area" | "stackedBar" | "scatter" | "histogram" | "combo",
  ) {
    const d = createEmptyNotebook(null);
    const c = newSqlCell("SELECT name, total, cnt FROM t");
    c.snapshot = buildSnapshot(
      {
        columns: [
          { name: "<name>", type_name: "text" },
          { name: "total", type_name: "int" },
          { name: "cnt", type_name: "int" },
        ],
        rows: [
          ["<script>x</script>", 10, 1],
          ["b", 20, 2],
          ["c", null, 3],
        ],
        totalRows: 3,
        rowsAffected: 0,
        hasColumns: true,
        elapsedMs: 7,
      },
      10,
      { enabled: false, patterns: [] },
      NOW,
    );
    c.view = "chart";
    c.chart = {
      type,
      xCol: type === "scatter" || type === "histogram" ? 1 : 0,
      yCols: type === "combo" ? [1, 2] : [type === "scatter" ? 2 : 1],
      aggregation: "none",
    };
    d.cells = [newMarkdownCell("# 概要\n\n## 集計 <b>"), c];
    return d;
  }

  it.each(["bar", "pie", "line", "area", "stackedBar", "scatter", "histogram", "combo"] as const)(
    "チャートセル (%s) はインライン SVG になり、表が <details> で併記される",
    (type) => {
      const html = notebookToHtml(chartDoc(type), text, "ja", NOW);
      expect(html).toContain("<svg");
      expect(html).toContain("<details><summary>表で表示</summary>");
      expect(html).not.toMatch(
        /<(link|script|img|iframe|object|embed|image|use|foreignObject)\b|@import|url\(|https?:\/\//i,
      );
      expect(html).not.toContain("<script>");
    },
  );

  it("SVG 内のラベル・系列名はエスケープされ、ライト/ダーク両方の色を持つ", () => {
    const html = notebookToHtml(chartDoc("bar"), text, "ja", NOW);
    const svg = html.slice(html.indexOf("<figure"), html.indexOf("</figure>"));
    expect(svg).toContain("&lt;script&gt;x");
    expect(svg).not.toContain("<script");
    expect(svg).toContain("@media (prefers-color-scheme: dark)");
    const fig = buildChartFigure(
      [
        { name: '"><svg onload=1>', type_name: "text" },
        { name: "v", type_name: "int" },
      ],
      [['"><svg onload=1>', 1]],
      { type: "pie", xCol: 0, yCols: [1], aggregation: "none" },
      "chX",
      '"><b>',
    );
    expect(fig?.html).not.toContain("<svg onload");
    expect(fig?.html).not.toContain('"><b>');
  });

  it("描けないチャート (系列なし) は null で、表だけになる", () => {
    expect(
      buildChartFigure(
        [{ name: "a", type_name: "text" }],
        [],
        { type: "bar", xCol: 0, yCols: [], aggregation: "none" },
        "ch1",
        "x",
      ),
    ).toBeNull();
  });

  it("SQL はトークンごとに色分けされ、ライト/ダーク両方の配色変数を持つ", () => {
    const html = notebookToHtml(chartDoc("bar"), text, "ja", NOW, () => "postgres");
    expect(html).toContain('<span class="t-keyword">SELECT</span>');
    expect(html).toContain("--syn-keyword:");
    expect(html).toMatch(/prefers-color-scheme: dark\)\{:root\{--syn-keyword/);
  });

  it("数値列は右寄せ、NULL はバッジ、目次は Markdown の見出しから作る", () => {
    const html = notebookToHtml(chartDoc("bar"), text, "ja", NOW);
    expect(html).toContain('<th class="num">total</th>');
    expect(html).toContain('<span class="nullbadge">NULL</span>');
    expect(html).toContain('<nav class="toc">');
    expect(html).toContain('<h1 id="nb-h-1">');
    expect(html).toContain('<a href="#nb-h-2">集計 &lt;b&gt;</a>');
    expect(html).toContain("セル 1");
    expect(html).toContain("@media print");
    expect(html).toContain("position: sticky");
  });

  it("Markdown 書き出しのチャートセルは表で出し、非対応と明記する", () => {
    const md = notebookToMarkdown(chartDoc("bar"), text, NOW);
    expect(md).toContain("チャート (書き出し非対応) — 表で表示");
    expect(md).toContain("| <name>");
    expect(notebookToMarkdown(build(), text, NOW)).not.toContain("書き出し非対応");
  });

  it.each([
    ["pie", '<path class="f0 slice"'],
    ["line", "<polyline"],
    ["scatter", "<circle"],
    ["area", "<polygon"],
    ["bar", "<rect"],
  ] as const)("%s は図形要素を持ち、NaN / undefined を出さない", (type, shape) => {
    const html = notebookToHtml(chartDoc(type), text, "ja", NOW);
    const fig = html.slice(html.indexOf("<figure"), html.indexOf("</figure>"));
    expect(fig).toContain(shape);
    expect(fig).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("combo の右軸の目盛りは viewBox 内 (右余白に収まる位置) に置く", () => {
    const html = notebookToHtml(chartDoc("combo"), text, "ja", NOW);
    const fig = html.slice(html.indexOf("<figure"), html.indexOf("</figure>"));
    const xs = [...fig.matchAll(/<text class="tick" x="([\d.]+)"[^>]*text-anchor="start"/g)].map((m) =>
      Number(m[1]),
    );
    expect(xs.length).toBeGreaterThan(0);
    // viewBox 幅 640 のうち、始点から右端まで 30px 以上残る (2 文字以上のラベルが切れない)。
    for (const x of xs) expect(640 - x).toBeGreaterThanOrEqual(30);
  });

  it("円の凡例が 20 件を超えたら「ほか N 件」を付ける。負値は 0 に丸めて描く", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [`k${i}`, i - 3] as [string, number]);
    const fig = buildChartFigure(
      [
        { name: "k", type_name: "text" },
        { name: "v", type_name: "int" },
      ],
      rows,
      { type: "pie", xCol: 0, yCols: [1], aggregation: "none", palette: "blue" },
      "chP",
      "x",
      (n) => `ほか ${n} 件`,
    );
    expect(fig?.html).toContain("ほか 5 件");
    expect(fig?.html).not.toMatch(/NaN|undefined/);
  });

  it("行数上限で切り詰めたスナップショットは、図の前にも注記する", () => {
    const d = chartDoc("bar");
    const c = d.cells[1] as { snapshot: { truncated: boolean; totalRows: number } };
    c.snapshot.truncated = true;
    c.snapshot.totalRows = 99;
    const html = notebookToHtml(d, text, "ja", NOW);
    const note = html.indexOf("先頭 3 / 全 99");
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(html.indexOf("<figure"));
    expect(html.split("先頭 3 / 全 99")).toHaveLength(2);
  });
});
