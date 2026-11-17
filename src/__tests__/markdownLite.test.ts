import { describe, expect, it } from "vitest";
import { escapeHtml, isSafeHref, markdownToHtml, parseInline, parseMarkdown } from "../markdownLite";

const html = (src: string) => markdownToHtml(parseMarkdown(src));

describe("markdownLite (#2380)", () => {
  it("見出し・段落・リスト・コード・引用・水平線を構文木にする", () => {
    const blocks = parseMarkdown(
      "# 題\n\n本文 1\n本文 2\n\n- a\n- b\n\n1. x\n2. y\n\n> 引用\n\n---\n\n```sql\nSELECT 1;\n```",
    );
    expect(blocks.map((b) => b.t)).toEqual(["heading", "p", "ul", "ol", "quote", "hr", "code"]);
    expect(blocks[1]).toMatchObject({ t: "p" });
    expect((blocks[1] as { lines: unknown[] }).lines).toHaveLength(2);
    expect(blocks[6]).toMatchObject({ t: "code", lang: "sql", v: "SELECT 1;" });
  });

  it("強調・コード・リンクを行内で解釈する", () => {
    expect(markdownToHtml([{ t: "p", lines: [parseInline("**太** *斜* `c` [x](https://e.com)")] }])).toBe(
      '<p><strong>太</strong> <em>斜</em> <code>c</code> <a href="https://e.com" rel="noopener noreferrer">x</a></p>',
    );
  });

  it("HTML は常にエスケープされ、タグとして解釈されない", () => {
    const out = html('<script>alert("x")</script> & <img src=x onerror=1>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&amp;");
  });

  it("コードブロック内もエスケープする", () => {
    expect(html("```\n<b>&</b>\n```")).toBe("<pre><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>");
  });

  it("安全でない URL はリンクにしない (javascript: / data: / 相対)", () => {
    expect(isSafeHref("https://a.b/c")).toBe(true);
    expect(isSafeHref("mailto:a@b.c")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/etc/passwd", "//evil.example"]) {
      expect(isSafeHref(bad)).toBe(false);
      const out = html(`[click](${bad})`);
      expect(out).not.toContain("<a ");
      expect(out).toContain("click");
    }
  });

  it("画像は解釈せず外部リソースを読み込む要素を作らない", () => {
    expect(html("![alt](https://e.com/x.png)")).not.toContain("<img");
  });

  it("属性値の引用符をエスケープする", () => {
    expect(escapeHtml(`a"b'c`)).toBe("a&quot;b&#39;c");
    expect(html('[x](https://e.com/"onmouseover="alert(1))')).not.toContain('"onmouseover');
  });

  it("snake_case は強調にしない", () => {
    expect(html("user_id and order_id")).toBe("<p>user_id and order_id</p>");
  });

  it("閉じていないフェンスや空文字でも壊れない", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(html("```\nSELECT 1")).toBe("<pre><code>SELECT 1</code></pre>");
  });
});
