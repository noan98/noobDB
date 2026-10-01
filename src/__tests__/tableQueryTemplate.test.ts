import { describe, expect, it } from "vitest";
import { applyServerBrowse } from "../components/serverBrowse";
import {
  isPrimaryKeyAscOrder,
  planTableOpenQuery,
  resolveTableOpenTemplate,
  sanitizeTableOpenQueryOverrides,
  templateUsesPlaceholder,
  upsertTableOpenQueryOverride,
  validateTableQueryTemplate,
  type TableOpenContext,
  type TableOpenQueryOverride,
} from "../tableQueryTemplate";

const mysql = (over: Partial<TableOpenContext> = {}): TableOpenContext => ({
  driver: "mysql",
  database: "shop",
  table: "users",
  limit: 100,
  pkColumns: ["id"],
  hiddenColumn: null,
  ...over,
});

describe("validateTableQueryTemplate", () => {
  it("空は未設定として有効", () => {
    expect(validateTableQueryTemplate("")).toBeNull();
    expect(validateTableQueryTemplate("   \n")).toBeNull();
  });

  it("既知のプレースホルダだけの SELECT は有効", () => {
    expect(
      validateTableQueryTemplate("SELECT * FROM {table} ORDER BY {pk} DESC LIMIT {limit}"),
    ).toBeNull();
    expect(validateTableQueryTemplate("select {pk}, name from {database}.{table_name};")).toBeNull();
  });

  it("未知のプレースホルダを拒否する", () => {
    expect(validateTableQueryTemplate("SELECT * FROM {tbl}")).toEqual({
      kind: "unknownPlaceholder",
      name: "tbl",
    });
  });

  it("文字列リテラル内の波括弧はプレースホルダとみなさない", () => {
    expect(
      validateTableQueryTemplate("SELECT * FROM {table} WHERE meta = '{foo}' LIMIT {limit}"),
    ).toBeNull();
  });

  it("複数文を拒否する (末尾の ; 1 つは許容)", () => {
    expect(validateTableQueryTemplate("SELECT * FROM {table}; SELECT 1")).toEqual({
      kind: "multipleStatements",
    });
    expect(validateTableQueryTemplate("SELECT * FROM {table};")).toBeNull();
  });

  it("更新系・DDL・ロック句を拒否する", () => {
    for (const t of [
      "DELETE FROM {table}",
      "UPDATE {table} SET a = 1",
      "DROP TABLE {table}",
      "WITH x AS (DELETE FROM {table} RETURNING *) SELECT * FROM x",
      "SELECT * FROM {table} FOR UPDATE",
    ]) {
      expect(validateTableQueryTemplate(t)?.kind).toBe("notSelect");
    }
  });

  it("構文として成立しないものを拒否する", () => {
    expect(validateTableQueryTemplate("SELECT * FROM {table} WHERE a = 'x")?.kind).toBe("syntax");
    expect(validateTableQueryTemplate("SELECT count(* FROM {table}")?.kind).toBe("syntax");
    expect(validateTableQueryTemplate("SELECT 1")?.kind).toBe("syntax");
  });

  it("長すぎるテンプレートを拒否する", () => {
    expect(validateTableQueryTemplate(`SELECT * FROM {table} -- ${"x".repeat(5000)}`)?.kind).toBe(
      "tooLong",
    );
  });
});

describe("resolveTableOpenTemplate", () => {
  const overrides: TableOpenQueryOverride[] = [
    { profileId: "p1", profileName: "dev", database: "shop", table: "users", template: "SELECT {pk} FROM {table}" },
    { profileId: "p1", profileName: "dev", database: "shop", table: "empty", template: "  " },
  ];

  it("テーブル別の上書き > 全体 > 従来", () => {
    expect(resolveTableOpenTemplate("G", overrides, "p1", "shop", "users")).toEqual({
      template: "SELECT {pk} FROM {table}",
      source: "override",
    });
    expect(resolveTableOpenTemplate("G", overrides, "p2", "shop", "users")).toEqual({
      template: "G",
      source: "global",
    });
    expect(resolveTableOpenTemplate("", overrides, "p2", "shop", "users")).toBeNull();
  });

  it("空の上書きは未設定扱いで全体へ進む", () => {
    expect(resolveTableOpenTemplate("G", overrides, "p1", "shop", "empty")?.source).toBe("global");
  });

  it("upsert は同じキーを置き換え、空テンプレートは削除する", () => {
    const next = upsertTableOpenQueryOverride(overrides, { ...overrides[0], template: " X " });
    expect(next.filter((o) => o.table === "users")).toEqual([{ ...overrides[0], template: "X" }]);
    const removed = upsertTableOpenQueryOverride(overrides, { ...overrides[0], template: "" });
    expect(removed.some((o) => o.table === "users")).toBe(false);
    expect(overrides).toHaveLength(2);
  });
});

describe("isPrimaryKeyAscOrder", () => {
  it("主キー列をその順に昇順で並べるだけなら真", () => {
    expect(isPrimaryKeyAscOrder(" `id`", ["id"])).toBe(true);
    expect(isPrimaryKeyAscOrder(' "a" ASC, b', ["a", "b"])).toBe(true);
    expect(isPrimaryKeyAscOrder(" t.id asc", ["id"])).toBe(true);
  });

  it("降順・順序違い・余分な列・主キー無しは偽", () => {
    expect(isPrimaryKeyAscOrder(" id DESC", ["id"])).toBe(false);
    expect(isPrimaryKeyAscOrder(" b, a", ["a", "b"])).toBe(false);
    expect(isPrimaryKeyAscOrder(" id, name", ["id"])).toBe(false);
    expect(isPrimaryKeyAscOrder(" id", [])).toBe(false);
    expect(isPrimaryKeyAscOrder(" lower(id)", ["id"])).toBe(false);
  });
});

describe("planTableOpenQuery", () => {
  it("テンプレート無し・不正は従来クエリ", () => {
    expect(planTableOpenQuery(null, mysql())).toEqual({ kind: "legacy" });
    expect(planTableOpenQuery("", mysql())).toEqual({ kind: "legacy" });
    expect(planTableOpenQuery("DELETE FROM {table}", mysql())).toEqual({ kind: "legacy" });
  });

  it("主キー降順: 識別子をドライバ別にクォートし、LIMIT を外した土台で OFFSET 方式", () => {
    const plan = planTableOpenQuery("SELECT * FROM {table} ORDER BY {pk} DESC LIMIT {limit}", mysql());
    expect(plan).toEqual({
      kind: "template",
      sql: "SELECT * FROM `shop`.`users` ORDER BY `id` DESC LIMIT 100",
      base: "SELECT * FROM `shop`.`users` ORDER BY `id` DESC",
      editable: true,
      keyset: false,
      wrapBrowse: true,
    });
  });

  it("3 ドライバで {table} の修飾とクォートが揃う", () => {
    const t = "SELECT * FROM {table}";
    const pg = planTableOpenQuery(t, mysql({ driver: "postgres", database: "public" }));
    const lite = planTableOpenQuery(t, mysql({ driver: "sqlite", database: "main" }));
    expect(pg.kind === "template" && pg.sql).toBe('SELECT * FROM "public"."users" LIMIT 100');
    expect(lite.kind === "template" && lite.sql).toBe('SELECT * FROM "users" LIMIT 100');
  });

  it("LIMIT が無ければ {limit} 件の LIMIT を付け足し、キーセットを使える", () => {
    const plan = planTableOpenQuery("SELECT * FROM {table}", mysql({ limit: 50 }));
    expect(plan).toMatchObject({
      sql: "SELECT * FROM `shop`.`users` LIMIT 50",
      base: "SELECT * FROM `shop`.`users`",
      editable: true,
      keyset: true,
      wrapBrowse: false,
    });
  });

  it("ORDER BY が主キー昇順だけならキーセット可 (土台から ORDER BY を外す)", () => {
    const plan = planTableOpenQuery(
      "SELECT * FROM {table} ORDER BY {pk} LIMIT {limit}",
      mysql({ pkColumns: ["a", "b"] }),
    );
    expect(plan).toMatchObject({
      sql: "SELECT * FROM `shop`.`users` ORDER BY `a`, `b` LIMIT 100",
      base: "SELECT * FROM `shop`.`users`",
      keyset: true,
      wrapBrowse: false,
    });
  });

  it("WHERE があるとキーセット不可・ブラウズ時は包む (編集は可)", () => {
    const plan = planTableOpenQuery("SELECT * FROM {table} WHERE deleted = 0", mysql());
    expect(plan).toMatchObject({ editable: true, keyset: false, wrapBrowse: true });
  });

  it("主キーを含まない列指定・結合・集計は読み取り専用", () => {
    expect(planTableOpenQuery("SELECT name FROM {table}", mysql())).toMatchObject({ editable: false });
    expect(planTableOpenQuery("SELECT id, name FROM {table}", mysql())).toMatchObject({ editable: true });
    expect(
      planTableOpenQuery("SELECT * FROM {table} JOIN shop.orders o ON o.user_id = id", mysql()),
    ).toMatchObject({ editable: false });
    expect(planTableOpenQuery("SELECT * FROM {table}, other", mysql())).toMatchObject({ editable: false });
    expect(planTableOpenQuery("SELECT id, count(*) FROM {table} GROUP BY id", mysql())).toMatchObject({
      editable: false,
    });
    expect(planTableOpenQuery("SELECT DISTINCT * FROM {table}", mysql())).toMatchObject({
      editable: false,
      wrapBrowse: true,
    });
    expect(planTableOpenQuery("SELECT * FROM shop.other", mysql())).toMatchObject({ editable: false });
  });

  it("クォートの無い db.table 表記でも開くテーブル自身なら編集可", () => {
    expect(planTableOpenQuery("SELECT * FROM shop.users", mysql())).toMatchObject({ editable: true });
    expect(planTableOpenQuery("SELECT * FROM users", mysql())).toMatchObject({ editable: true });
  });

  it("複合主キーの {pk} はカンマ連結", () => {
    const plan = planTableOpenQuery(
      "SELECT {pk}, note FROM {table}",
      mysql({ driver: "postgres", pkColumns: ["a", "b"] }),
    );
    expect(plan).toMatchObject({ sql: 'SELECT "a", "b", note FROM "shop"."users" LIMIT 100', editable: true });
  });

  it("主キー無し: SQLite / PostgreSQL は rowid / ctid、MySQL は従来へフォールバック", () => {
    const lite = planTableOpenQuery(
      "SELECT {pk}, * FROM {table} ORDER BY {pk} DESC",
      mysql({ driver: "sqlite", pkColumns: [], hiddenColumn: "rowid" }),
    );
    expect(lite).toMatchObject({
      sql: 'SELECT rowid, * FROM "users" ORDER BY rowid DESC LIMIT 100',
      editable: true,
      keyset: false,
    });
    const pg = planTableOpenQuery(
      "SELECT * FROM {table}",
      mysql({ driver: "postgres", pkColumns: [], hiddenColumn: "ctid" }),
    );
    // rowid / ctid を選択していないので行を特定できない → 読み取り専用。
    expect(pg).toMatchObject({ editable: false });
    expect(
      planTableOpenQuery("SELECT * FROM {table} ORDER BY {pk}", mysql({ pkColumns: [], hiddenColumn: null })),
    ).toEqual({ kind: "legacy" });
    // {pk} を使わないテンプレートは主キーが無くても使える (読み取り専用)。
    expect(planTableOpenQuery("SELECT * FROM {table}", mysql({ pkColumns: [] }))).toMatchObject({
      kind: "template",
      editable: false,
    });
  });

  it("OFFSET / LIMIT の手前で土台を切る", () => {
    const plan = planTableOpenQuery(
      "SELECT * FROM {table} ORDER BY created_at DESC LIMIT {limit} OFFSET 0",
      mysql(),
    );
    expect(plan).toMatchObject({
      base: "SELECT * FROM `shop`.`users` ORDER BY created_at DESC",
      sql: "SELECT * FROM `shop`.`users` ORDER BY created_at DESC LIMIT 100 OFFSET 0",
    });
  });

  it("サブクエリ内の LIMIT / ORDER BY はトップレベルの句とみなさない", () => {
    const plan = planTableOpenQuery(
      "SELECT * FROM {table} WHERE id IN (SELECT id FROM shop.users ORDER BY id LIMIT 5)",
      mysql(),
    );
    expect(plan).toMatchObject({
      sql: "SELECT * FROM `shop`.`users` WHERE id IN (SELECT id FROM shop.users ORDER BY id LIMIT 5) LIMIT 100",
      editable: true,
    });
  });

  it("テーブル名のクォート文字はエスケープして展開する", () => {
    const plan = planTableOpenQuery("SELECT * FROM {table}", mysql({ table: "we`ird" }));
    expect(plan).toMatchObject({ sql: "SELECT * FROM `shop`.`we``ird` LIMIT 100", editable: true });
  });

  it("templateUsesPlaceholder はリテラル外だけを見る", () => {
    expect(templateUsesPlaceholder("SELECT '{pk}' FROM {table}", "pk")).toBe(false);
    expect(templateUsesPlaceholder("SELECT {pk} FROM {table}", "pk")).toBe(true);
  });
});

describe("applyServerBrowse の wrap", () => {
  it("wrap 時は派生テーブルで包んでから WHERE / ORDER BY を足す", () => {
    expect(
      applyServerBrowse(
        "SELECT * FROM t ORDER BY id DESC",
        "mysql",
        null,
        { column: "name", direction: "asc" },
        true,
      ),
    ).toBe("SELECT * FROM (SELECT * FROM t ORDER BY id DESC) AS noobdb_src ORDER BY `name` ASC");
  });

  it("ソート/フィルタが無ければ包まない", () => {
    expect(applyServerBrowse("SELECT * FROM t WHERE a = 1", "mysql", null, null, true)).toBe(
      "SELECT * FROM t WHERE a = 1",
    );
  });
});

describe("sanitizeTableOpenQueryOverrides", () => {
  it("壊れた要素・検証に通らないテンプレート・重複キーを捨てる", () => {
    const ok = { profileId: "p", profileName: "dev", database: "d", table: "t", template: "SELECT * FROM {table}" };
    expect(
      sanitizeTableOpenQueryOverrides([
        ok,
        null,
        { ...ok, table: "x", template: "DELETE FROM {table}" },
        { ...ok, table: "y", template: "   " },
        { ...ok, profileId: 1 },
        { ...ok, template: "SELECT {pk} FROM {table}" },
        { ...ok, table: "z", profileName: undefined },
      ]),
    ).toEqual([
      { ...ok, template: "SELECT {pk} FROM {table}" },
      { ...ok, table: "z", profileName: "" },
    ]);
    expect(sanitizeTableOpenQueryOverrides("nope")).toEqual([]);
  });
});
