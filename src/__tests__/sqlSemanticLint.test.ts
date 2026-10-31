import { describe, expect, it } from "vitest";
import { MySQL, PostgreSQL, SQLite, type SQLDialect } from "@codemirror/lang-sql";
import { parseSqlTree } from "../components/sqlLint";
import {
  buildSemanticSchema,
  semanticDiagnostics,
  type SqlSemanticMessages,
} from "../components/sqlSemanticLint";

const MSG: SqlSemanticMessages = { unknownTable: "table:{name}", unknownColumn: "column:{name}" };

const OVERVIEW = [
  { name: "users", columns: ["id", "name", "email", "created_at"] },
  { name: "orders", columns: ["id", "user_id", "total", "status"] },
  { name: "empty_cols", columns: [] },
];

function run(
  sql: string,
  opts: { dialect?: SQLDialect; driver?: string; cursor?: number; extra?: string[] } = {},
) {
  const dialect = opts.dialect ?? MySQL;
  const driver = opts.driver ?? "mysql";
  const schema = buildSemanticSchema({
    driver,
    databaseSchema: OVERVIEW,
    defaultDatabase: "app",
    extraTableNames: opts.extra,
  });
  return semanticDiagnostics(parseSqlTree(sql, dialect), sql, schema, MSG, { cursor: opts.cursor }).map(
    (d) => `${d.severity}:${d.message}@${sql.slice(d.from, d.to)}`,
  );
}

describe("semanticDiagnostics — 未知のテーブル", () => {
  it("FROM の未知テーブルを警告する", () => {
    expect(run("SELECT * FROM userz")).toEqual(["warning:table:userz@userz"]);
  });
  it("JOIN / UPDATE / INSERT / DELETE の対象も検査する", () => {
    expect(run("SELECT * FROM users u JOIN ordrs o ON o.user_id = u.id")).toEqual([
      "warning:table:ordrs@ordrs",
    ]);
    expect(run("UPDATE usrs SET name = 'a'")).toEqual(["warning:table:usrs@usrs"]);
    expect(run("INSERT INTO usrs (a) VALUES (1)")).toEqual(["warning:table:usrs@usrs"]);
    expect(run("DELETE FROM usrs WHERE id = 1")).toEqual(["warning:table:usrs@usrs"]);
  });
  it("大文字小文字・引用符・DB 修飾の既定 DB は一致扱い", () => {
    expect(run("SELECT * FROM USERS")).toEqual([]);
    expect(run("SELECT * FROM `users`")).toEqual([]);
    expect(run("SELECT * FROM app.users")).toEqual([]);
    expect(run("SELECT * FROM app.userz")).toEqual(["warning:table:userz@userz"]);
  });
  it("他 DB 修飾・3 部修飾・テーブル関数は検証しない", () => {
    expect(run("SELECT * FROM other.nothing")).toEqual([]);
    expect(run("SELECT * FROM a.b.c")).toEqual([]);
    expect(run("SELECT * FROM generate_series(1, 3) g", { dialect: PostgreSQL, driver: "postgres" })).toEqual(
      [],
    );
  });
  it("スキーマ未取得・空なら何も出さない", () => {
    const sql = "SELECT * FROM nothing";
    const tree = parseSqlTree(sql, MySQL);
    expect(semanticDiagnostics(tree, sql, null, MSG)).toEqual([]);
    expect(buildSemanticSchema({ driver: "mysql", databaseSchema: [] })).toBeNull();
    expect(buildSemanticSchema({ driver: "mysql", databaseSchema: null })).toBeNull();
  });
  it("同じスクリプトで CREATE / RENAME した表・system 表・extra は未知扱いしない", () => {
    expect(run("CREATE TABLE tmp (a int); SELECT * FROM tmp")).toEqual([]);
    expect(run("CREATE TEMPORARY TABLE IF NOT EXISTS tmp2 AS SELECT 1; SELECT x FROM tmp2")).toEqual([]);
    expect(run("ALTER TABLE users RENAME TO people; SELECT * FROM people")).toEqual([]);
    expect(run("SELECT * FROM sqlite_master", { dialect: SQLite, driver: "sqlite" })).toEqual([]);
    expect(run("SELECT * FROM mv", { dialect: PostgreSQL, driver: "postgres", extra: ["MV"] })).toEqual([]);
  });
  it("入力中 (カーソルが識別子上) は警告しない", () => {
    const sql = "SELECT * FROM us";
    expect(run(sql, { cursor: sql.length })).toEqual([]);
    expect(run(sql, { cursor: 0 })).toEqual(["warning:table:us@us"]);
  });
});

describe("semanticDiagnostics — 未知の列", () => {
  it("未知の列を警告し、既知の列は警告しない", () => {
    expect(run("SELECT id, nme FROM users")).toEqual(["warning:column:nme@nme"]);
    expect(run("SELECT id, name FROM users WHERE email = 'x' ORDER BY created_at")).toEqual([]);
    expect(run("SELECT * FROM users WHERE emial = 'x'")).toEqual(["warning:column:emial@emial"]);
  });
  it("修飾列 (エイリアス) を検証する", () => {
    expect(run("SELECT u.nme FROM users u")).toEqual(["warning:column:nme@nme"]);
    expect(run("SELECT u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id")).toEqual([]);
    expect(run("SELECT users.nme FROM users")).toEqual(["warning:column:nme@nme"]);
    // 別名を付けたら元のテーブル名では修飾できないが、曖昧なので警告しない
    expect(run("SELECT users.name FROM users u")).toEqual([]);
  });
  it("複数テーブルでは和集合で解決する", () => {
    expect(run("SELECT total, name FROM users, orders")).toEqual([]);
    expect(run("SELECT total, zzz FROM users, orders")).toEqual(["warning:column:zzz@zzz"]);
  });
  it("* / t.* / 関数 / 別名参照は警告しない", () => {
    expect(run("SELECT *, u.* FROM users u")).toEqual([]);
    expect(run("SELECT count(*), max(id), coalesce(name, 'x') FROM users")).toEqual([]);
    expect(run("SELECT total * 2 AS dbl FROM orders ORDER BY dbl")).toEqual([]);
    expect(run("SELECT status s, count(*) c FROM orders GROUP BY s HAVING c > 1")).toEqual([]);
    expect(run("SELECT myfunc(zzz) FROM users")).toEqual(["warning:column:zzz@zzz"]);
  });
  it("暗黙の別名・型名・日時要素・NULLS FIRST・変数は列とみなさない", () => {
    expect(run("SELECT name nm FROM users")).toEqual([]);
    expect(run("SELECT CAST(id AS signed) FROM users")).toEqual([]);
    expect(run("SELECT id::int FROM users", { dialect: PostgreSQL, driver: "postgres" })).toEqual([]);
    expect(
      run("SELECT EXTRACT(year FROM created_at) FROM users", { dialect: PostgreSQL, driver: "postgres" }),
    ).toEqual([]);
    expect(
      run("SELECT id FROM users ORDER BY name DESC NULLS LAST", { dialect: PostgreSQL, driver: "postgres" }),
    ).toEqual([]);
    expect(run("SELECT id FROM users WHERE name = @who AND id = :id")).toEqual([]);
    expect(run("SELECT id FROM users WHERE created_at > now() - INTERVAL 1 DAY")).toEqual([]);
  });
  it("未知テーブルの列は連鎖して警告しない", () => {
    expect(run("SELECT a, b FROM nothing")).toEqual(["warning:table:nothing@nothing"]);
    expect(run("SELECT n.x, u.id FROM nothing n JOIN users u ON u.id = n.x")).toEqual([
      "warning:table:nothing@nothing",
    ]);
  });
  it("列が未取得 (空) のテーブルは列を検証しない", () => {
    expect(run("SELECT anything FROM empty_cols")).toEqual([]);
  });
  it("FROM 無しの SELECT は列を検証しない", () => {
    expect(run("SELECT abc")).toEqual([]);
    expect(run("SELECT 1 + zzz")).toEqual([]);
  });
});

describe("semanticDiagnostics — CTE / サブクエリ / 集合演算", () => {
  it("CTE を解決する (列は定義から)", () => {
    expect(run("WITH t AS (SELECT id, name FROM users) SELECT id, name FROM t")).toEqual([]);
    expect(run("WITH t AS (SELECT id AS uid FROM users) SELECT uid FROM t")).toEqual([]);
    expect(run("WITH t AS (SELECT id AS uid FROM users) SELECT id FROM t")).toEqual(["warning:column:id@id"]);
    expect(run("WITH t(a, b) AS (SELECT id, name FROM users) SELECT a, b FROM t")).toEqual([]);
    expect(run("WITH t AS (SELECT * FROM users) SELECT whatever FROM t")).toEqual([]);
  });
  it("CTE 内の未知テーブル/列も検査し、CTE 名は未知テーブルにならない", () => {
    expect(run("WITH t AS (SELECT idd FROM users) SELECT * FROM t")).toEqual(["warning:column:idd@idd"]);
    expect(run("WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b")).toEqual([]);
    expect(
      run("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT n FROM r"),
    ).toEqual([]);
  });
  it("派生テーブルの出力列だけが外側から見える", () => {
    expect(run("SELECT s.total FROM (SELECT total FROM orders) s")).toEqual([]);
    expect(run("SELECT s.id FROM (SELECT total FROM orders) s")).toEqual(["warning:column:id@id"]);
    expect(run("SELECT s.anything FROM (SELECT * FROM orders) s")).toEqual([]);
    expect(run("SELECT x FROM (SELECT count(*) FROM orders) s")).toEqual([]);
  });
  it("相関サブクエリは外側のテーブルを参照できる", () => {
    expect(
      run(
        "SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total > 0)",
      ),
    ).toEqual([]);
    expect(run("SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 1)")).toEqual([]);
    expect(run("SELECT id FROM users WHERE id IN (SELECT user_idd FROM orders)")).toEqual([
      "warning:column:user_idd@user_idd",
    ]);
  });
  it("UNION の各 SELECT を別個に検査し、末尾の ORDER BY は検証しない", () => {
    expect(run("SELECT id FROM users UNION SELECT user_id FROM orders ORDER BY id")).toEqual([]);
    expect(run("SELECT id FROM users UNION SELECT zzz FROM orders")).toEqual(["warning:column:zzz@zzz"]);
  });
});

describe("semanticDiagnostics — DML", () => {
  it("UPDATE の SET / WHERE の列を検証する", () => {
    expect(run("UPDATE users SET name = 'a' WHERE id = 1")).toEqual([]);
    expect(run("UPDATE users SET nme = 'a' WHERE id = 1")).toEqual(["warning:column:nme@nme"]);
    expect(run("UPDATE users u JOIN orders o ON o.user_id = u.id SET u.name = o.status")).toEqual([]);
  });
  it("DELETE の WHERE の列を検証する", () => {
    expect(run("DELETE FROM users WHERE idd = 1")).toEqual(["warning:column:idd@idd"]);
    expect(run("DELETE FROM users WHERE id = 1")).toEqual([]);
  });
  it("INSERT の列リストを検証し、SELECT 部分も検査する", () => {
    expect(run("INSERT INTO users (id, nme) VALUES (1, 'a')")).toEqual(["warning:column:nme@nme"]);
    expect(run("INSERT INTO users (id, name) VALUES (1, 'a')")).toEqual([]);
    expect(run("INSERT INTO users (id) SELECT user_id FROM orders")).toEqual([]);
    expect(run("INSERT INTO users (id) SELECT zzz FROM orders")).toEqual(["warning:column:zzz@zzz"]);
    expect(
      run("INSERT INTO users (id, name) VALUES (1, 'a') ON DUPLICATE KEY UPDATE name = VALUES(name)"),
    ).toEqual([]);
  });
});

describe("semanticDiagnostics — ドライバ差・保守性", () => {
  it("SQLite の二重引用符は未知名でも文字列扱いで警告しない", () => {
    expect(run('SELECT "abc" FROM users', { dialect: SQLite, driver: "sqlite" })).toEqual([]);
    // SQLite は生成列・FTS5 の rank などがあるので列の警告は出さない (未知テーブルは出す)。
    expect(run("SELECT abc FROM users", { dialect: SQLite, driver: "sqlite" })).toEqual([]);
    expect(run("SELECT rank FROM userz", { dialect: SQLite, driver: "sqlite" })).toEqual([
      "warning:table:userz@userz",
    ]);
  });
  it("MySQL の二重引用符は文字列、Postgres では識別子", () => {
    expect(run('SELECT id FROM users WHERE name = "x"')).toEqual([]);
    expect(run('SELECT "nme" FROM users', { dialect: PostgreSQL, driver: "postgres" })).toEqual([
      'warning:column:nme@"nme"',
    ]);
  });
  it("Postgres の schema 修飾・ドルクオート・E'' 文字列で壊れない", () => {
    expect(run("SELECT id FROM public.users", { dialect: PostgreSQL, driver: "postgres" })).toEqual([]);
    expect(run("SELECT $$a b$$, E'x\\'y' FROM users", { dialect: PostgreSQL, driver: "postgres" })).toEqual(
      [],
    );
  });
  it("入れ子 JOIN・LATERAL・FOR UPDATE・ウィンドウ定義は黙る", () => {
    expect(run("SELECT x FROM (users u JOIN orders o ON o.user_id = u.id)")).toEqual([]);
    expect(
      run("SELECT q FROM users u, LATERAL (SELECT 1 AS q) l", { dialect: PostgreSQL, driver: "postgres" }),
    ).toEqual([]);
    expect(run("SELECT id FROM users WHERE id = 1 FOR UPDATE")).toEqual([]);
    expect(
      run("SELECT id, rank() OVER w FROM users WINDOW w AS (ORDER BY zzz)", {
        dialect: PostgreSQL,
        driver: "postgres",
      }),
    ).toEqual([]);
  });
  it("括弧が釣り合わない・文字列が閉じない文は解析しない", () => {
    expect(run("SELECT zzz FROM users WHERE (a = 1")).toEqual([]);
    expect(run("SELECT zzz FROM users WHERE a = 'oops")).toEqual([]);
    expect(run("SELECT zzz FROM users /* oops")).toEqual([]);
  });
  it("コメント内・文字列内の語は見ない", () => {
    expect(run("SELECT id /* zzz */ FROM users -- qqq\n WHERE name = 'zzz'")).toEqual([]);
  });
  it("複数文は文ごとに検査する", () => {
    expect(run("SELECT id FROM users; SELECT zzz FROM orders;")).toEqual(["warning:column:zzz@zzz"]);
  });
  it("DDL・EXPLAIN・SHOW などは対象外", () => {
    expect(run("CREATE TABLE t (id int, zzz int)")).toEqual([]);
    expect(run("SHOW COLUMNS FROM nothing")).toEqual([]);
    expect(run("EXPLAIN SELECT 1")).toEqual([]);
  });
});

describe("semanticDiagnostics — 正当な SQL に偽陽性を出さない", () => {
  const valid = [
    "SELECT u.id, u.name, COUNT(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.name HAVING COUNT(o.id) > 0 ORDER BY n DESC LIMIT 10",
    "SELECT DISTINCT status FROM orders ORDER BY status",
    "SELECT CASE WHEN total > 100 THEN 'big' ELSE 'small' END AS size FROM orders",
    "SELECT CASE WHEN total > 100 THEN 'big' ELSE 'small' END size FROM orders",
    "SELECT id FROM users WHERE name LIKE 'a%' AND email IS NOT NULL AND id BETWEEN 1 AND 9",
    "SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.user_id = u.id)",
    "SELECT o.* FROM orders o NATURAL JOIN users",
    "SELECT a.id FROM users a CROSS JOIN orders b WHERE a.id = b.user_id",
    "SELECT id FROM users a INNER JOIN orders b USING (id)",
    "SELECT sum(total) OVER (PARTITION BY user_id ORDER BY id) AS running FROM orders",
    "SELECT id FROM users FOR UPDATE",
    "UPDATE orders o SET o.total = o.total + 1 WHERE o.status = 'x'",
    "SELECT * FROM users LIMIT 5 OFFSET 10",
    "SELECT id, (SELECT max(total) FROM orders o WHERE o.user_id = u.id) AS mx FROM users u",
    "SELECT x.n FROM (SELECT count(*) AS n FROM users) AS x",
    "SELECT 'a' AS lit, 1 AS one FROM users",
    "SELECT `id`, `name` FROM `users` WHERE `email` <> ''",
  ];
  for (const sql of valid) {
    it(`警告しない: ${sql.slice(0, 60)}`, () => {
      expect(run(sql)).toEqual([]);
    });
  }
  it("Postgres の構文", () => {
    const pg = (sql: string) => run(sql, { dialect: PostgreSQL, driver: "postgres" });
    expect(
      pg("SELECT DISTINCT ON (user_id) user_id, total FROM orders ORDER BY user_id, total DESC"),
    ).toEqual([]);
    expect(
      pg(
        "INSERT INTO users (id, name) VALUES (1, 'a') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      ),
    ).toEqual([]);
    expect(pg("UPDATE orders o SET total = u.id FROM users u WHERE u.id = o.user_id")).toEqual([]);
    expect(pg("DELETE FROM orders o USING users u WHERE u.id = o.user_id")).toEqual([]);
    expect(pg("SELECT users FROM users")).toEqual([]);
    expect(pg("SELECT name::text, created_at::date FROM users")).toEqual([]);
  });
});

describe("semanticDiagnostics — レビュー指摘の偽陽性", () => {
  const pg = (sql: string) => run(sql, { dialect: PostgreSQL, driver: "postgres" });
  it("PARTITION / OVER を列とみなさない (SQLite 方言)", () => {
    expect(
      run("SELECT row_number() OVER (PARTITION BY name) FROM users", { dialect: SQLite, driver: "sqlite" }),
    ).toEqual([]);
    expect(pg("SELECT row_number() OVER (PARTITION BY name) FROM users")).toEqual([]);
    expect(pg("SELECT row_number() OVER (PARTITION BY nme) FROM users")).toEqual(["warning:column:nme@nme"]);
  });
  it("文字セット名・EXTRACT の要素・名前付き引数を列とみなさない", () => {
    expect(run("SELECT CONVERT(name USING utf8mb4), CHAR(65 USING utf8mb4) FROM users")).toEqual([]);
    expect(run("SELECT CAST(name AS CHAR CHARACTER SET utf8mb4) FROM users")).toEqual([]);
    expect(
      pg(
        "SELECT EXTRACT(CENTURY FROM created_at), EXTRACT(julian FROM created_at), EXTRACT(decade FROM created_at) FROM users",
      ),
    ).toEqual([]);
    expect(pg("SELECT EXTRACT(year FROM nme) FROM users")).toEqual(["warning:column:nme@nme"]);
    expect(pg("SELECT make_interval(days => 1), make_interval(days := 1) FROM users")).toEqual([]);
  });
  it("列別名リストが一部だけでも元の列を失わない", () => {
    expect(pg("SELECT email FROM users AS u(nm)")).toEqual([]);
    expect(pg("SELECT x.b FROM (SELECT id, name AS b FROM users) AS x(a)")).toEqual([]);
    expect(pg("WITH t(a) AS (SELECT id, name FROM users) SELECT t.name FROM t")).toEqual([]);
    expect(pg("SELECT u.a FROM users AS u(a, b)")).toEqual([]);
  });
  it("ストアド/トリガー本体を含むスクリプトは解析しない", () => {
    expect(run("CREATE PROCEDURE p(uid INT) BEGIN SELECT name FROM users WHERE id = uid; END")).toEqual([]);
    expect(
      run(
        "CREATE TRIGGER tr AFTER INSERT ON users FOR EACH ROW BEGIN UPDATE orders SET total = v WHERE id = 1; END",
        { dialect: SQLite, driver: "sqlite" },
      ),
    ).toEqual([]);
    expect(
      run("CREATE FUNCTION f() RETURNS INT BEGIN DECLARE v INT; RETURN v; END; SELECT * FROM nothing"),
    ).toEqual([]);
  });
  it("大文字小文字だけ違う表名が衝突したら列を和集合にする", () => {
    const schema = buildSemanticSchema({
      driver: "mysql",
      databaseSchema: [
        { name: "T", columns: ["a"] },
        { name: "t", columns: ["b"] },
      ],
    });
    const sql = "SELECT a, b FROM t";
    expect(semanticDiagnostics(parseSqlTree(sql, MySQL), sql, schema, MSG)).toEqual([]);
  });
});
