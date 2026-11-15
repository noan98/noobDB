// @vitest-environment jsdom
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_STATEMENT_DEBOUNCE_MS,
  activeStatementHighlight,
  refreshActiveStatement,
  visibleLineStarts,
} from "../components/activeStatement";
import { highlightedStatementAtOffset, statementAtOffset } from "../sqlScript";

describe("highlightedStatementAtOffset (#2354)", () => {
  it("文が 1 つ以下なら null (帯を出さない)", () => {
    expect(highlightedStatementAtOffset("SELECT 1", 3)).toBeNull();
    expect(highlightedStatementAtOffset("SELECT 1;", 3)).toBeNull();
    expect(highlightedStatementAtOffset("-- note only", 3)).toBeNull();
    expect(highlightedStatementAtOffset("", 0)).toBeNull();
  });

  it("2 文以上では実行 (statementAtOffset) と同じ範囲を返す", () => {
    const cases: { sql: string; driver?: string }[] = [
      { sql: "SELECT 1;\nSELECT 2;\nSELECT 3" },
      { sql: "SELECT ';' AS a; SELECT 2" },
      { sql: "SELECT 1 -- a; b\n; SELECT 2" },
      { sql: "SELECT 1 /* ; */ ; SELECT 2" },
      { sql: "SELECT 'a\\'; b'; SELECT 2", driver: "mysql" },
      { sql: "SELECT 'a\\'; SELECT 2", driver: "postgres" },
      { sql: "SELECT $$a;b$$; SELECT 2", driver: "postgres" },
      { sql: "UPDATE t SET a = 1\nDELETE FROM t;\nSELECT 2" },
    ];
    for (const { sql, driver } of cases) {
      for (let off = 0; off <= sql.length; off++) {
        const expected = statementAtOffset(sql, off, driver);
        const got = highlightedStatementAtOffset(sql, off, driver);
        if (got === null) {
          // 1 文だけに分割されたケース (MySQL の \' など) は帯を出さない。
          expect(statementAtOffset(sql, 0, driver)).toEqual(statementAtOffset(sql, sql.length, driver));
        } else {
          expect(got).toEqual(expected);
        }
      }
    }
  });

  it("文字列・コメント内の ; では区切らない", () => {
    const sql = "SELECT ';' AS a; SELECT 2";
    expect(highlightedStatementAtOffset(sql, 3)?.text).toBe("SELECT ';' AS a");
    expect(highlightedStatementAtOffset(sql, 20)?.text).toBe("SELECT 2");
  });

  it("MySQL ではバックスラッシュエスケープした引用符の中の ; で区切らない", () => {
    const sql = "SELECT 'it\\'s; ok' AS a; SELECT 2";
    expect(highlightedStatementAtOffset(sql, 5, "mysql")?.text).toBe("SELECT 'it\\'s; ok' AS a");
    // PostgreSQL ではバックスラッシュはエスケープでないので `'it\\'` で文字列が閉じ、`;` で区切る。
    expect(highlightedStatementAtOffset(sql, 5, "postgres")?.text).toBe("SELECT 'it\\'s");
  });
});

describe("visibleLineStarts", () => {
  const doc = Text.of(["aaa", "bbb", "ccc", "ddd", "eee"]); // 行頭: 0,4,8,12,16

  it("範囲にかかる全行の行頭を返す", () => {
    expect(visibleLineStarts(doc, { from: 5, to: 9 }, [{ from: 0, to: doc.length }])).toEqual([4, 8]);
  });

  it("可視範囲の外の行は含めない", () => {
    expect(visibleLineStarts(doc, { from: 0, to: doc.length }, [{ from: 8, to: 14 }])).toEqual([8, 12]);
    expect(visibleLineStarts(doc, { from: 0, to: 3 }, [{ from: 12, to: 19 }])).toEqual([]);
  });

  it("可視範囲が複数でも行を重複させない", () => {
    expect(
      visibleLineStarts(doc, { from: 0, to: doc.length }, [
        { from: 0, to: 5 },
        { from: 4, to: 9 },
      ]),
    ).toEqual([0, 4, 8]);
  });
});

describe("activeStatementHighlight 拡張", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    vi.useRealTimers();
  });

  const mount = (doc: string, enabled = { on: true }) => {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      doc,
      parent,
      extensions: [
        activeStatementHighlight(
          () => "mysql",
          () => enabled.on,
        ),
      ],
    });
    return { v: view, parent, enabled };
  };
  const bandLines = (v: EditorView) =>
    Array.from(v.dom.querySelectorAll(".cm-line")).flatMap((el, i) =>
      el.classList.contains("cm-active-stmt") ? [i] : [],
    );

  it("2 文以上ならカーソルの文の行だけに付き、別の文へ移ると追従する", () => {
    const { v } = mount("SELECT 1;\nSELECT 2;\nSELECT 3");
    v.dispatch({ selection: { anchor: 2 } });
    vi.advanceTimersByTime(ACTIVE_STATEMENT_DEBOUNCE_MS + 1);
    expect(bandLines(v)).toEqual([0]);
    v.dispatch({ selection: { anchor: 15 } });
    vi.advanceTimersByTime(ACTIVE_STATEMENT_DEBOUNCE_MS + 1);
    expect(bandLines(v)).toEqual([1]);
  });

  it("1 文だけのときは付かない", () => {
    const { v } = mount("SELECT 1;\n-- メモ");
    vi.advanceTimersByTime(ACTIVE_STATEMENT_DEBOUNCE_MS + 1);
    expect(bandLines(v)).toEqual([]);
  });

  it("選択範囲があるときは即座に消え、解除すると戻る", () => {
    const { v } = mount("SELECT 1;\nSELECT 2");
    v.dispatch({ selection: { anchor: 2 } });
    vi.advanceTimersByTime(ACTIVE_STATEMENT_DEBOUNCE_MS + 1);
    expect(bandLines(v)).toEqual([0]);
    v.dispatch({ selection: { anchor: 0, head: 4 } });
    expect(bandLines(v)).toEqual([]);
    v.dispatch({ selection: { anchor: 3 } });
    vi.advanceTimersByTime(ACTIVE_STATEMENT_DEBOUNCE_MS + 1);
    expect(bandLines(v)).toEqual([0]);
  });

  it("設定オフでは付かず、オンに戻して refresh すると付く", () => {
    const { v, enabled } = mount("SELECT 1;\nSELECT 2");
    enabled.on = false;
    v.dispatch({ effects: refreshActiveStatement.of(null) });
    vi.advanceTimersByTime(1);
    expect(bandLines(v)).toEqual([]);
    enabled.on = true;
    v.dispatch({ effects: refreshActiveStatement.of(null) });
    vi.advanceTimersByTime(1);
    expect(bandLines(v)).toEqual([0]);
  });

  it("入力中は範囲が編集に追従する", () => {
    const { v } = mount("SELECT 1;\nSELECT 2");
    vi.advanceTimersByTime(1);
    v.dispatch({ changes: { from: 0, insert: "-- c\n" }, selection: { anchor: 6 } });
    vi.advanceTimersByTime(ACTIVE_STATEMENT_DEBOUNCE_MS + 1);
    expect(bandLines(v)).toEqual([0, 1]);
  });
});
