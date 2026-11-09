import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { t } from "../i18n";
import { SqlPreview } from "../components/SqlPreview";
import {
  SQL_HIGHLIGHT_MAX_CHARS,
  SQL_HIGHLIGHT_MAX_LINES,
  SQL_TOKEN_STYLE,
  shouldHighlightSql,
} from "../components/sqlHighlight";

// SQL プレビューの色分け (#2157)。エディタと同じ `--syntax-*` 変数で着色し、大きな SQL は単色にする。

describe("shouldHighlightSql (閾値)", () => {
  it("上限ちょうどは色分けし、超えたら単色", () => {
    expect(shouldHighlightSql("SELECT 1")).toBe(true);
    expect(shouldHighlightSql(Array(SQL_HIGHLIGHT_MAX_LINES).fill("a").join("\n"))).toBe(true);
    expect(
      shouldHighlightSql(
        Array(SQL_HIGHLIGHT_MAX_LINES + 1)
          .fill("a")
          .join("\n"),
      ),
    ).toBe(false);
    expect(shouldHighlightSql("a".repeat(SQL_HIGHLIGHT_MAX_CHARS))).toBe(true);
    expect(shouldHighlightSql("a".repeat(SQL_HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
  });
});

describe("SqlPreview", () => {
  it("キーワード・文字列・数値をエディタと同じ配色の CSS 変数で着色し、全文は保つ", () => {
    renderWithProviders(<SqlPreview sql={"SELECT 'x', 42\nFROM t"} driver="mysql" data-testid="p" />);
    const pre = screen.getByTestId("p");
    expect(pre).toHaveAttribute("data-sql-highlight", "on");
    expect(pre.textContent).toBe("SELECT 'x', 42\nFROM t");
    const colored = [...pre.querySelectorAll("span")].map((e) => [e.textContent, e.style.color]);
    expect(colored).toContainEqual(["SELECT", SQL_TOKEN_STYLE.keyword.color]);
    expect(colored).toContainEqual(["'x'", SQL_TOKEN_STYLE.string.color]);
    expect(colored).toContainEqual(["42", SQL_TOKEN_STYLE.number.color]);
    // 色リテラルは使わず、テーマ追従の変数だけ。
    for (const [, color] of colored) expect(color).toMatch(/^var\(--syntax-/);
  });

  it("空のときは empty の文言を単色で出す", () => {
    renderWithProviders(<SqlPreview sql="" driver="postgres" empty="(empty)" data-testid="p" />);
    const pre = screen.getByTestId("p");
    expect(pre).toHaveAttribute("data-sql-highlight", "off");
    expect(pre).toHaveTextContent("(empty)");
    expect(pre.querySelector("span")).toBeNull();
  });

  it("閾値を超える SQL は単色にフォールバックする", () => {
    const big = Array(SQL_HIGHLIGHT_MAX_LINES + 1)
      .fill("SELECT 1;")
      .join("\n");
    renderWithProviders(<SqlPreview sql={big} driver="mysql" data-testid="p" />);
    const pre = screen.getByTestId("p");
    expect(pre).toHaveAttribute("data-sql-highlight", "off");
    expect(pre.querySelector("span")).toBeNull();
    expect(pre.textContent).toBe(big);
  });
});

describe("SqlPreview maskCredentials (#2175)", () => {
  const SQL = "ALTER USER 'app'@'%' IDENTIFIED BY 'S3cret!'";

  it("既定は伏せ字で、平文は DOM に出ない", () => {
    renderWithProviders(<SqlPreview sql={SQL} driver="mysql" maskCredentials />);
    const pre = screen.getByTestId("sql-preview");
    expect(pre).toHaveTextContent("ALTER USER 'app'@'%' IDENTIFIED BY '••••••••'");
    expect(pre.textContent).not.toContain("S3cret!");
    expect(screen.getByRole("img", { name: t("sqlPreviewMaskedCredential") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formPasswordShow") })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("「表示」で平文になり、もう一度押すと伏せ字に戻る", () => {
    renderWithProviders(<SqlPreview sql={SQL} driver="mysql" maskCredentials />);
    fireEvent.click(screen.getByRole("button", { name: t("formPasswordShow") }));
    expect(screen.getByTestId("sql-preview").textContent).toBe(SQL);
    const hide = screen.getByRole("button", { name: t("formPasswordShow") });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    expect(hide).toHaveAccessibleName(t("formPasswordShow"));
    fireEvent.click(hide);
    expect(screen.getByTestId("sql-preview").textContent).not.toContain("S3cret!");
  });

  it("資格情報が無い SQL や maskCredentials なしでは切り替えを出さず、そのまま表示する", () => {
    renderWithProviders(<SqlPreview sql="SELECT 1" driver="mysql" maskCredentials />);
    expect(screen.queryByTestId("sql-preview-reveal")).toBeNull();
    expect(screen.getByTestId("sql-preview")).toHaveTextContent("SELECT 1");
  });

  it("色分けしても全文・複数箇所の資格情報を伏せる", () => {
    const sql = "CREATE USER 'a'@'%' IDENTIFIED BY 'one'; ALTER USER 'b'@'%' IDENTIFIED BY 'two'";
    renderWithProviders(<SqlPreview sql={sql} driver="mysql" maskCredentials />);
    const pre = screen.getByTestId("sql-preview");
    expect(pre).toHaveAttribute("data-sql-highlight", "on");
    expect(pre.querySelectorAll("[data-credential=masked]")).toHaveLength(2);
    expect(pre.textContent).not.toMatch(/one|two/);
    fireEvent.click(screen.getByTestId("sql-preview-reveal"));
    expect(screen.getByTestId("sql-preview").textContent).toBe(sql);
  });

  it("大きな SQL の単色フォールバックでも伏せる", () => {
    const big = `${Array(SQL_HIGHLIGHT_MAX_LINES + 1)
      .fill("SELECT 1;")
      .join("\n")}\n${SQL}`;
    renderWithProviders(<SqlPreview sql={big} driver="mysql" maskCredentials />);
    const pre = screen.getByTestId("sql-preview");
    expect(pre).toHaveAttribute("data-sql-highlight", "off");
    expect(pre.textContent).not.toContain("S3cret!");
    fireEvent.click(screen.getByTestId("sql-preview-reveal"));
    expect(screen.getByTestId("sql-preview").textContent).toBe(big);
  });
});

describe("SqlPreview maskCredentials のレイアウト props (#2175)", () => {
  const SQL = "ALTER USER 'a'@'%' IDENTIFIED BY 'x'";
  const preClass = (props: object) => {
    const { unmount } = renderWithProviders(
      <SqlPreview sql={SQL} driver="mysql" maskCredentials {...props} />,
    );
    const c = screen.getByTestId("sql-preview").className;
    unmount();
    return c;
  };

  it("余白 (mt) は <pre> に載らず、wrap は <pre> に載る", () => {
    expect(preClass({ mt: "2" })).toBe(preClass({}));
    expect(preClass({ wrap: true })).not.toBe(preClass({}));
  });
});
