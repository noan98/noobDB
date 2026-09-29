import { describe, expect, it } from "vitest";
import {
  applyServerBrowse,
  buildServerFilterClause,
  buildServerSortClause,
  escapeLikeValue,
  isServerFilterInputValid,
  serverFilterOpNeedsValue,
  splitInValues,
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

describe("比較・範囲・IN 演算子 (#1149)", () => {
  const drivers = ["mysql", "postgres", "sqlite"] as const;
  const mk = (
    op: ServerFilter["op"],
    value: string,
    numeric: boolean,
    value2?: string,
  ): ServerFilter => ({ column: "price", op, value, value2, numeric });

  it("gt / gte / lt / lte: 数値カラムは裸の数値、全方言で識別子だけ異なる", () => {
    const cases = [
      ["gt", ">"],
      ["gte", ">="],
      ["lt", "<"],
      ["lte", "<="],
    ] as const;
    for (const driver of drivers) {
      for (const [op, sym] of cases) {
        expect(buildServerFilterClause(driver, mk(op, " 10.5 ", true))).toBe(
          `${quoteFor(driver, "price")} ${sym} 10.5`,
        );
      }
    }
  });

  it("比較: 文字列/日付カラムはクオート、数値カラムでも非数値はクオートにフォールバック", () => {
    for (const driver of drivers) {
      expect(buildServerFilterClause(driver, mk("gt", "2024-01-01", false))).toBe(
        `${quoteFor(driver, "price")} > '2024-01-01'`,
      );
      expect(buildServerFilterClause(driver, mk("lte", "1; DROP TABLE t", true))).toBe(
        `${quoteFor(driver, "price")} <= '1; DROP TABLE t'`,
      );
    }
  });

  it("比較: シングルクオートはエスケープされ、MySQL のみバックスラッシュも二重化する", () => {
    expect(buildServerFilterClause("postgres", mk("gte", "o'x\\y", false))).toBe(`"price" >= 'o''x\\y'`);
    expect(buildServerFilterClause("sqlite", mk("gte", "o'x\\y", false))).toBe(`"price" >= 'o''x\\y'`);
    expect(buildServerFilterClause("mysql", mk("gte", "o'x\\y", false))).toBe("`price` >= 'o''x\\\\y'");
  });

  it("between: 数値は裸、文字列はクオート、両端を含む BETWEEN", () => {
    for (const driver of drivers) {
      expect(buildServerFilterClause(driver, mk("between", "1", true, "99"))).toBe(
        `${quoteFor(driver, "price")} BETWEEN 1 AND 99`,
      );
      expect(buildServerFilterClause(driver, mk("between", "2024-01-01", false, "2024-12-31"))).toBe(
        `${quoteFor(driver, "price")} BETWEEN '2024-01-01' AND '2024-12-31'`,
      );
    }
  });

  it("between: 端ごとに数値判定し、インジェクション文字列はクオートされる", () => {
    expect(buildServerFilterClause("sqlite", mk("between", "1", true, "9' OR '1'='1"))).toBe(
      `"price" BETWEEN 1 AND '9'' OR ''1''=''1'`,
    );
  });

  it("in: カンマ/改行区切りを分割し、各要素を個別にリテラル化する", () => {
    for (const driver of drivers) {
      expect(buildServerFilterClause(driver, mk("in", "1, 2,\n3,, x", true))).toBe(
        `${quoteFor(driver, "price")} IN (1, 2, 3, 'x')`,
      );
      expect(buildServerFilterClause(driver, mk("in", "a,b", false))).toBe(
        `${quoteFor(driver, "price")} IN ('a', 'b')`,
      );
    }
  });

  it("in: 空リストは何にもマッチしない条件になる (IN () を出さない)", () => {
    for (const driver of drivers) {
      expect(buildServerFilterClause(driver, mk("in", " , ,\n", false))).toBe("1 = 0");
    }
  });

  it("in: 値中のクオートはエスケープされる", () => {
    expect(buildServerFilterClause("postgres", mk("in", "a'b,c", false))).toBe(`"price" IN ('a''b', 'c')`);
  });

  it("applyServerBrowse: between/in も WHERE に注入される", () => {
    expect(applyServerBrowse("SELECT * FROM t", "mysql", mk("between", "1", true, "5"), null)).toBe(
      "SELECT * FROM t WHERE `price` BETWEEN 1 AND 5",
    );
    expect(applyServerBrowse("SELECT * FROM t", "sqlite", mk("in", "1,2", true), { column: "id", direction: "asc" })).toBe(
      'SELECT * FROM t WHERE "price" IN (1, 2) ORDER BY "id" ASC',
    );
  });

  it("splitInValues / isServerFilterInputValid / serverFilterOpNeedsValue", () => {
    expect(splitInValues("a, b\n c ,")).toEqual(["a", "b", "c"]);
    expect(isServerFilterInputValid("between", "1", "")).toBe(false);
    expect(isServerFilterInputValid("between", "1", "2")).toBe(true);
    expect(isServerFilterInputValid("in", " , ")).toBe(false);
    expect(isServerFilterInputValid("in", "1")).toBe(true);
    expect(isServerFilterInputValid("gt", "")).toBe(true);
    expect(serverFilterOpNeedsValue("between")).toBe(true);
    expect(serverFilterOpNeedsValue("isNull")).toBe(false);
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
