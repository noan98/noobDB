import { describe, expect, it } from "vitest";
import {
  applyServerBrowse,
  buildServerFilterClause,
  buildServerSortClause,
  escapeLikeValue,
  type ServerFilter,
  type ServerSort,
} from "../components/serverBrowse";

// テーブル閲覧グリッドのサーバ側ソート/フィルタ (#792)。identifier クオートは
// sqlDialect.ts、リテラルエスケープは cellEdit.ts の quoteString を再利用するため、
// ここでは注入結果 (WHERE/ORDER BY の組み立て) と方言差 (バックスラッシュの扱い) を
// 中心に検証する。

describe("escapeLikeValue", () => {
  it("% と _ をバックスラッシュでエスケープする", () => {
    expect(escapeLikeValue("50%")).toBe("50\\%");
    expect(escapeLikeValue("a_b")).toBe("a\\_b");
  });

  it("値中の生バックスラッシュも二重化する (エスケープ文字自身)", () => {
    expect(escapeLikeValue("a\\b")).toBe("a\\\\b");
  });

  it("ワイルドカードを含まない値はそのまま", () => {
    expect(escapeLikeValue("hello")).toBe("hello");
  });
});

describe("buildServerFilterClause", () => {
  const drivers = ["mysql", "postgres", "sqlite"] as const;

  it("isNull / isNotNull はドライバ非依存で値を無視する", () => {
    for (const driver of drivers) {
      const f: ServerFilter = { column: "email", op: "isNull", value: "ignored", numeric: false };
      expect(buildServerFilterClause(driver, f)).toBe(`${quoteFor(driver, "email")} IS NULL`);
      const f2: ServerFilter = { column: "email", op: "isNotNull", value: "", numeric: false };
      expect(buildServerFilterClause(driver, f2)).toBe(`${quoteFor(driver, "email")} IS NOT NULL`);
    }
  });

  it("eq: 数値カラム + 数値リテラルは裸の数値で埋め込む", () => {
    const f: ServerFilter = { column: "id", op: "eq", value: "42", numeric: true };
    expect(buildServerFilterClause("mysql", f)).toBe("`id` = 42");
    expect(buildServerFilterClause("postgres", f)).toBe('"id" = 42');
    expect(buildServerFilterClause("sqlite", f)).toBe('"id" = 42');
  });

  it("eq: 数値カラムでも非数値リテラルはクオートしてフォールバックする", () => {
    const f: ServerFilter = { column: "id", op: "eq", value: "1 OR 1=1", numeric: true };
    expect(buildServerFilterClause("mysql", f)).toBe("`id` = '1 OR 1=1'");
  });

  it("eq: 非数値カラムは常にクオートされた文字列", () => {
    const f: ServerFilter = { column: "name", op: "eq", value: "alice", numeric: false };
    expect(buildServerFilterClause("mysql", f)).toBe("`name` = 'alice'");
    expect(buildServerFilterClause("postgres", f)).toBe("\"name\" = 'alice'");
  });

  it("eq: シングルクオートを含む値は二重化してインジェクションを無害化する", () => {
    const f: ServerFilter = { column: "name", op: "eq", value: "x'; DROP TABLE t; --", numeric: false };
    const out = buildServerFilterClause("mysql", f);
    expect(out).toBe("`name` = 'x''; DROP TABLE t; --'");
  });

  it("contains: LIKE パターンをワイルドカードエスケープ付きで組み立てる (MySQL はバックスラッシュを二重化)", () => {
    const f: ServerFilter = { column: "name", op: "contains", value: "50%", numeric: false };
    expect(buildServerFilterClause("mysql", f)).toBe("`name` LIKE '%50\\\\%%' ESCAPE '\\'");
    expect(buildServerFilterClause("postgres", f)).toBe("\"name\" LIKE '%50\\%%' ESCAPE '\\'");
    expect(buildServerFilterClause("sqlite", f)).toBe("\"name\" LIKE '%50\\%%' ESCAPE '\\'");
  });

  it("contains: プレーンな値は %value% で囲む", () => {
    const f: ServerFilter = { column: "name", op: "contains", value: "ali", numeric: false };
    expect(buildServerFilterClause("postgres", f)).toBe("\"name\" LIKE '%ali%' ESCAPE '\\'");
  });

  // 非等価 (#914 のセル右クリック「この値を除外する」で使う)。eq と同じ
  // クオート/数値判定を共有し、比較演算子だけが `<>` になる。
  it("ne: eq と同じクオート規則で <> を組み立てる", () => {
    expect(
      buildServerFilterClause("mysql", { column: "name", op: "ne", value: "alice", numeric: false }),
    ).toBe("`name` <> 'alice'");
    expect(
      buildServerFilterClause("postgres", { column: "id", op: "ne", value: "42", numeric: true }),
    ).toBe('"id" <> 42');
  });

  it("ne: 数値カラムでも非数値リテラルはクオートしてフォールバックする", () => {
    expect(
      buildServerFilterClause("mysql", { column: "id", op: "ne", value: "1 OR 1=1", numeric: true }),
    ).toBe("`id` <> '1 OR 1=1'");
  });
});

describe("buildServerSortClause", () => {
  it("asc/desc をドライバ別クオートで組み立てる", () => {
    const asc: ServerSort = { column: "created_at", direction: "asc" };
    const desc: ServerSort = { column: "created_at", direction: "desc" };
    expect(buildServerSortClause("mysql", asc)).toBe("`created_at` ASC");
    expect(buildServerSortClause("mysql", desc)).toBe("`created_at` DESC");
    expect(buildServerSortClause("postgres", asc)).toBe('"created_at" ASC');
    expect(buildServerSortClause("sqlite", desc)).toBe('"created_at" DESC');
  });
});

describe("applyServerBrowse", () => {
  const base = "SELECT * FROM `db`.`users`";

  it("filter/sort が両方 null なら base をそのまま返す", () => {
    expect(applyServerBrowse(base, "mysql", null, null)).toBe(base);
    expect(applyServerBrowse(base, "mysql", undefined, undefined)).toBe(base);
  });

  it("filter のみ: WHERE を付与する", () => {
    const f: ServerFilter = { column: "status", op: "eq", value: "active", numeric: false };
    expect(applyServerBrowse(base, "mysql", f, null)).toBe(
      "SELECT * FROM `db`.`users` WHERE `status` = 'active'",
    );
  });

  it("sort のみ: ORDER BY を付与する", () => {
    const s: ServerSort = { column: "id", direction: "desc" };
    expect(applyServerBrowse(base, "mysql", null, s)).toBe(
      "SELECT * FROM `db`.`users` ORDER BY `id` DESC",
    );
  });

  it("filter + sort: WHERE の後に ORDER BY が続く (LIMIT/OFFSET は buildPageSql が別途付与)", () => {
    const f: ServerFilter = { column: "status", op: "eq", value: "active", numeric: false };
    const s: ServerSort = { column: "id", direction: "asc" };
    expect(applyServerBrowse(base, "postgres", f, s)).toBe(
      "SELECT * FROM `db`.`users` WHERE \"status\" = 'active' ORDER BY \"id\" ASC",
    );
  });
});

function quoteFor(driver: string, name: string): string {
  if (driver === "postgres" || driver === "sqlite") return `"${name}"`;
  return `\`${name}\``;
}
