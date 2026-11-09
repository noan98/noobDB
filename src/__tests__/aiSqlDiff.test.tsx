import { describe, expect, it } from "vitest";
import type { DiffLine } from "../ai/sqlAssist";
import { DiffView } from "../components/AiSqlDiff";
import { SQL_HIGHLIGHT_MAX_CHARS } from "../components/sqlHighlight";
import { renderWithProviders, screen } from "./testUtils";

const lines: DiffLine[] = [
  { type: "same", text: "SELECT id" },
  { type: "del", text: "FROM old_t WHERE n = 'abc" },
  { type: "add", text: "FROM new_t WHERE n = 1" },
];

describe("DiffView (#2178)", () => {
  it("SQL として色分けし、各行の文字列は元に戻る", () => {
    renderWithProviders(<DiffView lines={lines} driver="mysql" />);
    const root = screen.getByTestId("ai-sql-diff");
    expect(root).toHaveAttribute("data-sql-highlight", "on");
    const rows = Array.from(root.querySelectorAll("[data-diff]"));
    expect(rows.map((r) => r.lastElementChild?.textContent)).toEqual(lines.map((l) => l.text));
    // 先頭行のキーワードに構文色 (--syntax-keyword) が付く。
    expect(rows[0]?.querySelector('span[style*="--syntax-keyword"]')).not.toBeNull();
  });

  it("削除行の閉じていない引用符が、後ろの追加行の色に流れ込まない", () => {
    renderWithProviders(<DiffView lines={lines} driver="mysql" />);
    const addRow = screen.getByTestId("ai-sql-diff").querySelector('[data-diff="add"]');
    // 追加行の `1` は文字列ではなく数値として色分けされる。
    expect(addRow?.querySelector('span[style*="--syntax-number"]')?.textContent).toBe("1");
    expect(addRow?.querySelector('span[style*="--syntax-string"]')).toBeNull();
  });

  it("大きすぎる SQL は単色 (data-sql-highlight=off)", () => {
    // 行数の上限 (10,001 行) で作ると jsdom の描画だけで 5 秒近くかかり、CI でタイムアウトした。
    // 文字数の上限を 1 行で超えて、DOM を 1 行に抑える (行数の境界は sqlPreview.test.tsx で見る)。
    const big: DiffLine[] = [{ type: "same", text: "x".repeat(SQL_HIGHLIGHT_MAX_CHARS + 1) }];
    renderWithProviders(<DiffView lines={big} driver="mysql" />);
    expect(screen.getByTestId("ai-sql-diff")).toHaveAttribute("data-sql-highlight", "off");
  });
});
