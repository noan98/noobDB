import { describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "./testUtils";
import { CellValueViewer } from "../components/CellValueViewer";
import {
  expandKeysToDepth,
  formatJsonPointer,
  jsonArrayRowsSql,
  parseJsonLossless,
  pathKey,
  type JsonNode,
} from "../components/jsonTree";
import { t } from "../i18n";

function parse(text: string): JsonNode {
  const n = parseJsonLossless(text);
  if (!n) throw new Error("parse failed");
  return n;
}

describe("formatJsonPointer (#1628)", () => {
  it("ルートは空文字、添字とキーを / で連ねる", () => {
    expect(formatJsonPointer([])).toBe("");
    expect(formatJsonPointer(["a", 0, "b"])).toBe("/a/0/b");
  });
  it("~ と / を RFC 6901 どおりエスケープする", () => {
    expect(formatJsonPointer(["a/b", "m~n", ""])).toBe("/a~1b/m~0n/");
  });
});

describe("expandKeysToDepth (#1628)", () => {
  const doc = parse('{"a":{"b":{"c":[1]}},"d":[{"e":1}],"s":1}');
  it("depth=1 はルートだけ", () => {
    expect([...expandKeysToDepth(doc, 1).keys]).toEqual([pathKey([])]);
  });
  it("depth=2 は 1 段下のコンテナまで", () => {
    const keys = expandKeysToDepth(doc, 2).keys;
    expect(keys.has(pathKey([]))).toBe(true);
    expect(keys.has(pathKey(["a"]))).toBe(true);
    expect(keys.has(pathKey(["d"]))).toBe(true);
    expect(keys.has(pathKey(["a", "b"]))).toBe(false);
  });
  it("Infinity は全コンテナ、スカラは含めない", () => {
    const keys = expandKeysToDepth(doc, Number.POSITIVE_INFINITY).keys;
    expect(keys.size).toBe(6);
    expect(keys.has(pathKey(["s"]))).toBe(false);
  });
  it("上限を超えたら打ち切って truncated を立てる", () => {
    const big = parse(JSON.stringify(Array.from({ length: 20 }, () => [1])));
    const r = expandKeysToDepth(big, Number.POSITIVE_INFINITY, 5);
    expect(r.keys.size).toBe(5);
    expect(r.truncated).toBe(true);
  });
});

describe("jsonArrayRowsSql (#1628)", () => {
  const objs = parse('{"items":[{"id":1,"name":"a","ok":true},{"id":2,"name":"b","extra":{"x":1}}]}');
  const items = (() => {
    if (objs.kind !== "object") throw new Error("object");
    return objs.entries[0].value;
  })();

  it("配列以外は null", () => {
    expect(jsonArrayRowsSql("mysql", "`t`", "doc", [], parse("{}"), null)).toBeNull();
  });

  it("MySQL: JSON_TABLE で列と型を推定し、WHERE は副問い合わせへ入れる", () => {
    const sql = jsonArrayRowsSql("mysql", "`app`.`t`", "doc", ["items"], items, "`pk` = 1") ?? "";
    expect(sql).toContain("FROM `app`.`t` AS t,");
    expect(sql).toMatch(/\) AS jt WHERE `pk` = 1;$/);
    expect(sql).toContain("JSON_TABLE(t.`doc`, '$.items[*]' COLUMNS (");
    expect(sql).toContain("`id` DOUBLE PATH '$.id'");
    expect(sql).toContain("`name` TEXT PATH '$.name'");
    expect(sql).toContain("`ok` JSON PATH '$.ok'");
    expect(sql).toContain("`extra` JSON PATH '$.extra'");
  });

  it("MySQL: WHERE の列名と衝突する展開列は出力名を変えて曖昧さを避ける", () => {
    const sql = jsonArrayRowsSql("mysql", "`t`", "doc", ["items"], items, "`id` = 1") ?? "";
    expect(sql).toContain("`id_` DOUBLE PATH '$.id'");
    expect(sql).toContain("`name` TEXT PATH '$.name'");
  });

  it("PostgreSQL: jsonb_to_recordset に列定義を付ける", () => {
    const sql = jsonArrayRowsSql("postgres", '"app"."t"', "doc", ["items"], items, null) ?? "";
    expect(sql).toContain('FROM (SELECT "doc" FROM "app"."t") AS t');
    expect(sql).toContain('jsonb_to_recordset((t."doc"::jsonb #> \'{"items"}\'))');
    expect(sql).toContain('"id" numeric, "name" text, "ok" boolean, "extra" jsonb');
  });

  it("SQLite: json_each + json_extract", () => {
    const sql = jsonArrayRowsSql("sqlite", '"t"', "doc", ["items"], items, null) ?? "";
    expect(sql).toContain("json_each(t.\"doc\", '$.items') AS j");
    expect(sql).toContain("json_extract(j.value, '$.id') AS \"id\"");
  });

  it("スカラ配列は value 1 列に展開する (ルート配列はパスなし)", () => {
    const arr = parse("[1,2,3]");
    expect(jsonArrayRowsSql("postgres", '"t"', "doc", [], arr, null)).toContain(
      'jsonb_array_elements(t."doc"::jsonb) AS x(value)',
    );
    expect(jsonArrayRowsSql("sqlite", '"t"', "doc", [], arr, null)).toContain('json_each(t."doc") AS j');
    expect(jsonArrayRowsSql("mysql", "`t`", "doc", [], arr, null)).toContain("`value` DOUBLE PATH '$'");
  });

  it("引用符を含むキーは SQL へ漏らさず列から外す", () => {
    const arr = parse('[{"a\\"b":1,"ok":2}]');
    const sql = jsonArrayRowsSql("sqlite", '"t"', "doc", [], arr, null) ?? "";
    expect(sql).not.toContain('a"b');
    expect(sql).toContain('AS "ok"');
  });
});

describe("JSON ツリーの一括展開と Pointer コピー (#1628)", () => {
  const DOC = '{"user":{"name":"Alice","tags":["admin","dev"]},"n":null}';

  it("すべて展開で深い値まで見える", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    const tree = screen.getByRole("tree");
    expect(within(tree).queryByText('"Alice"')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("jsonTreeExpandAll") }));
    expect(within(tree).getByText('"Alice"')).toBeInTheDocument();
    expect(within(tree).getByText('"dev"')).toBeInTheDocument();
  });

  it("閉じるでルートだけに戻る", async () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    const tree = screen.getByRole("tree");
    fireEvent.click(screen.getByRole("button", { name: t("jsonTreeExpandAll") }));
    fireEvent.click(screen.getByRole("button", { name: t("jsonTreeCollapseAll") }));
    // 閉じるアニメーション (TreeCollapse) の完了を待つ。
    await waitFor(() => expect(within(tree).queryByText('"Alice"')).toBeNull());
  });

  it("深さ指定で必要な段だけ展開する", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    const tree = screen.getByRole("tree");
    fireEvent.change(screen.getByLabelText(t("jsonTreeExpandDepthAria")), { target: { value: "1" } });
    expect(within(tree).getByText('"Alice"')).toBeInTheDocument();
    expect(within(tree).queryByText('"dev"')).toBeNull();
  });

  it("選択ノードの JSON Pointer をコピーするボタンが出る", () => {
    renderWithProviders(<CellValueViewer columnName="doc" value={DOC} isJson onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("jsonTreeExpandAll") }));
    fireEvent.click(within(screen.getByRole("tree")).getByText('"dev"'));
    expect(screen.getByRole("button", { name: t("jsonTreeCopyPointer") })).toBeInTheDocument();
  });

  it("行展開 SQL のボタンは配列ノードを選んだときだけ出る", () => {
    renderWithProviders(
      <CellValueViewer
        columnName="doc"
        value={DOC}
        isJson
        driver="sqlite"
        jsonUpdate={{ tableRef: '"t"', where: '"id" = 1' }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("jsonTreeExpandAll") }));
    const tree = screen.getByRole("tree");
    fireEvent.click(within(tree).getByText('"name"'));
    expect(screen.queryByRole("button", { name: t("jsonTreeCopySqlRows") })).toBeNull();
    fireEvent.click(within(tree).getByText('"tags"'));
    expect(screen.getByRole("button", { name: t("jsonTreeCopySqlRows") })).toBeInTheDocument();
  });
});
