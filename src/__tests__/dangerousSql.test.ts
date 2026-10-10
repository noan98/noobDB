import { describe, it, expect } from "vitest";
import {
  analyzeDangerousSql,
  isReadOnlySql,
} from "../dangerousSql";

describe("analyzeDangerousSql", () => {
  it("flags DELETE without a top-level WHERE", () => {
    expect(analyzeDangerousSql("DELETE FROM users")).toEqual([
      { kind: "deleteNoWhere", target: "users" },
    ]);
  });

  it("ignores DELETE guarded by a top-level WHERE", () => {
    expect(analyzeDangerousSql("DELETE FROM users WHERE id = 1")).toEqual([]);
  });

  it("flags UPDATE without a top-level WHERE", () => {
    expect(analyzeDangerousSql("UPDATE users SET active = 0")).toEqual([
      { kind: "updateNoWhere", target: "users" },
    ]);
  });

  it("ignores UPDATE guarded by a top-level WHERE", () => {
    expect(
      analyzeDangerousSql("UPDATE users SET active = 0 WHERE id = 1"),
    ).toEqual([]);
  });

  it("does not treat a WHERE inside a sub-select as the statement's guard", () => {
    expect(
      analyzeDangerousSql(
        "UPDATE t SET c = (SELECT x FROM y WHERE y.id = 1)",
      ),
    ).toEqual([{ kind: "updateNoWhere", target: "t" }]);
  });

  it("does not treat a WHERE inside a string literal as a guard", () => {
    expect(
      analyzeDangerousSql("UPDATE t SET note = 'delete where all rows'"),
    ).toEqual([{ kind: "updateNoWhere", target: "t" }]);
  });

  it("does not treat a WHERE inside a comment as a guard", () => {
    expect(analyzeDangerousSql("DELETE FROM t -- where id = 1")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM t /* where id = 1 */")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
  });

  it("flags DROP and reads the object name past IF EXISTS", () => {
    expect(analyzeDangerousSql("DROP TABLE foo")).toEqual([
      { kind: "drop", target: "foo" },
    ]);
    expect(analyzeDangerousSql("DROP TABLE IF EXISTS foo")).toEqual([
      { kind: "drop", target: "foo" },
    ]);
  });

  it("flags TRUNCATE with and without the optional TABLE keyword", () => {
    expect(analyzeDangerousSql("TRUNCATE foo")).toEqual([
      { kind: "truncate", target: "foo" },
    ]);
    expect(analyzeDangerousSql("TRUNCATE TABLE foo")).toEqual([
      { kind: "truncate", target: "foo" },
    ]);
  });

  it("strips quoting from the parsed target identifier", () => {
    expect(analyzeDangerousSql("DROP TABLE `my table`")).toEqual([
      { kind: "drop", target: "my table" },
    ]);
    expect(analyzeDangerousSql('DELETE FROM "my tbl"')).toEqual([
      { kind: "deleteNoWhere", target: "my tbl" },
    ]);
  });

  it("returns a null target when it cannot be parsed", () => {
    expect(analyzeDangerousSql("DELETE")).toEqual([
      { kind: "deleteNoWhere", target: null },
    ]);
  });

  it("reports one finding per dangerous statement", () => {
    expect(
      analyzeDangerousSql("DELETE FROM a; UPDATE b SET x = 1"),
    ).toEqual([
      { kind: "deleteNoWhere", target: "a" },
      { kind: "updateNoWhere", target: "b" },
    ]);
  });

  it("ignores benign and non-destructive statements", () => {
    expect(analyzeDangerousSql("SELECT * FROM users")).toEqual([]);
    expect(analyzeDangerousSql("INSERT INTO t (x) VALUES (1)")).toEqual([]);
    expect(analyzeDangerousSql("")).toEqual([]);
  });

  it("still detects a dangerous statement preceded by a comment", () => {
    expect(
      analyzeDangerousSql("/* cleanup */ DELETE FROM sessions"),
    ).toEqual([{ kind: "deleteNoWhere", target: "sessions" }]);
  });

  it("does not treat a WHERE inside a dollar-quoted string as a guard", () => {
    // PostgreSQL: $$…$$ / $tag$…$tag$ are string literals; a `where` inside
    // must not make an unguarded UPDATE look safe.
    expect(analyzeDangerousSql("UPDATE t SET c = $$ where id = 1 $$")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
    expect(
      analyzeDangerousSql("UPDATE t SET c = $tag$ where id = 1 $tag$"),
    ).toEqual([{ kind: "updateNoWhere", target: "t" }]);
  });

  it("does not split statements on a semicolon inside a dollar-quoted string", () => {
    expect(
      analyzeDangerousSql("UPDATE t SET c = $$a; b$$ WHERE id = 1"),
    ).toEqual([]);
  });

  it("does not mistake parameter placeholders or $-identifiers for dollar quotes", () => {
    // `$1 … $1` must not be swallowed as a string: the DELETE stays visible.
    expect(
      analyzeDangerousSql("DELETE FROM t; SELECT $1 WHERE x = $1"),
    ).toEqual([{ kind: "deleteNoWhere", target: "t" }]);
    // `a$b` is a MySQL-legal identifier, not an opening tag.
    expect(analyzeDangerousSql("DELETE FROM a$b")).toEqual([
      { kind: "deleteNoWhere", target: "a$b" },
    ]);
  });

  describe("driver-aware backslash escaping (#852, #1004)", () => {
    // `note = '\'` — a `'` string containing a single backslash, followed by
    // a real ` WHERE id = 1` clause. Only MySQL/MariaDB reads `\` as an
    // escape character inside `'...'` (`driverBackslashEscapes`); on every
    // other supported driver the backslash is an ordinary character, so the
    // `'` right after it closes the string and the WHERE that follows is a
    // real top-level guard. On MySQL the same `'` is escaped away, the
    // string never closes, and the WHERE keyword is swallowed as (masked)
    // string content — so the UPDATE looks unguarded.
    const sql = "UPDATE t SET note = '\\' WHERE id = 1";

    it("finds no finding on non-MySQL drivers (WHERE is a real top-level guard)", () => {
      for (const driver of ["postgres", "sqlite"]) {
        expect(analyzeDangerousSql(sql, driver)).toEqual([]);
      }
    });

    it("finds no finding when the driver is omitted (conservative fallback)", () => {
      expect(analyzeDangerousSql(sql)).toEqual([]);
    });

    it("flags updateNoWhere on mysql (the trailing WHERE is masked into the unterminated string)", () => {
      expect(analyzeDangerousSql(sql, "mysql")).toEqual([
        { kind: "updateNoWhere", target: "t" },
      ]);
    });
  });
});

describe("isReadOnlySql", () => {
  it("accepts statements that begin with an allowed read-only keyword", () => {
    expect(isReadOnlySql("SELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("  select 1")).toBe(true);
    expect(isReadOnlySql("SHOW TABLES")).toBe(true);
    expect(isReadOnlySql("DESCRIBE users")).toBe(true);
    expect(isReadOnlySql("DESC users")).toBe(true);
    expect(isReadOnlySql("EXPLAIN SELECT 1")).toBe(true);
    expect(isReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
  });

  it("tolerates trailing semicolons, whitespace, and comments", () => {
    expect(isReadOnlySql("SELECT 1;")).toBe(true);
    expect(isReadOnlySql("SELECT 1;   ")).toBe(true);
    expect(isReadOnlySql("SELECT 1 -- trailing")).toBe(true);
  });

  it("rejects write and DDL statements", () => {
    expect(isReadOnlySql("INSERT INTO t (x) VALUES (1)")).toBe(false);
    expect(isReadOnlySql("UPDATE t SET x = 1 WHERE id = 2")).toBe(false);
    expect(isReadOnlySql("DELETE FROM t WHERE id = 1")).toBe(false);
    expect(isReadOnlySql("DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("TRUNCATE t")).toBe(false);
    expect(isReadOnlySql("CREATE TABLE t (id int)")).toBe(false);
    expect(isReadOnlySql("CALL do_thing()")).toBe(false);
  });

  it("rejects a write/DDL keyword hiding inside a SELECT-prefixed body", () => {
    // Data-modifying CTE and SELECT ... INTO both begin with allowed keywords.
    expect(
      isReadOnlySql("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"),
    ).toBe(false);
    expect(isReadOnlySql("SELECT * INTO backup FROM t")).toBe(false);
  });

  it("rejects a hidden second statement", () => {
    expect(isReadOnlySql("SELECT 1; DELETE FROM t")).toBe(false);
  });

  it("rejects row-locking SELECTs", () => {
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR SHARE")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t LOCK IN SHARE MODE")).toBe(false);
  });

  it("rejects row-locking SELECT variants with suffixes (#J1)", () => {
    // The old check was a strict `endsWith("for update"/"for share"/...)`, so
    // it missed every suffixed PostgreSQL variant and the two PostgreSQL-only
    // phrases — all of which still acquire row locks.
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE NOWAIT")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE SKIP LOCKED")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE OF t")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR NO KEY UPDATE")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR KEY SHARE")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR SHARE OF t")).toBe(false);
    // A column merely named `updated_at` must not be mistaken for the clause.
    expect(isReadOnlySql("SELECT updated_at FROM t")).toBe(true);
  });

  it("is not fooled by keywords inside strings or comments", () => {
    expect(isReadOnlySql("SELECT 'delete from t' AS note")).toBe(true);
    expect(isReadOnlySql("SELECT 1 /* drop table t */")).toBe(true);
  });

  it("treats empty or unrecognized input as not read-only", () => {
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("   ")).toBe(false);
    expect(isReadOnlySql("(SELECT 1)")).toBe(false);
  });

  it("rejects cross-engine write passthrough functions hidden in a SELECT", () => {
    // The statement itself is a plain top-level SELECT, so it passes the
    // prefix check; the actual write lives inside a string-literal argument
    // that maskLiterals blanks, so only the function name being on the
    // WRITE_KEYWORDS list catches it. Mirrors backend
    // `is_read_only_sql_masked` (src-tauri/src/db/mod.rs).
    expect(
      isReadOnlySql(
        "SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','UPDATE t SET a=1') AS r",
      ),
    ).toBe(false);
    expect(
      isReadOnlySql("SELECT * FROM OPENQUERY(linked_srv, 'DELETE FROM accounts')"),
    ).toBe(false);
    expect(
      isReadOnlySql("SELECT dblink_exec('dbname=other','DELETE FROM accounts')"),
    ).toBe(false);
    expect(isReadOnlySql("SELECT dblink('dbname=other','SELECT 1')")).toBe(false);
    expect(isReadOnlySql("SELECT load_extension('/tmp/evil.so')")).toBe(false);
    // Fail-closed: a column merely named after one of these functions is also
    // rejected (over-detection is cheap, under-detection is not).
    expect(isReadOnlySql("SELECT openrowset FROM t")).toBe(false);
  });

  it("reveals the contents of a MySQL versioned comment (/*! ... */) instead of masking it", () => {
    // `/*! ... */` is not a comment on MySQL — its body executes on servers
    // new enough to satisfy the optional version gate — so it must not be
    // blanked the way a plain `/* ... */` block comment is.
    expect(isReadOnlySql("SELECT /*!50000 * FROM users */ ")).toBe(true);
    expect(
      isReadOnlySql("SELECT 1 /*! UNION SELECT password FROM users */"),
    ).toBe(true);
    expect(
      isReadOnlySql("SELECT 1 /*!50000 , (SELECT DELETE FROM users) */"),
    ).toBe(false);
    // An ordinary block comment (no `!`) is unaffected.
    expect(
      isReadOnlySql("SELECT 1 /* normal comment with DELETE inside */"),
    ).toBe(true);
  });
});

// read-only の CTE 判定コーパスは共有ゴールデン `fixtures/readOnlySqlVectors.json`
// (`readOnlyGolden.test.ts` が検証) に一本化した (#1151)。ここに手コピーを置かない。

// isSchemaMutatingSql の判定は共有ゴールデン (fixtures/schemaMutatingVectors.json) を
// schemaMutatingGolden.test.ts で検証する (#1221)。ここに手コピーのコーパスは持たない。

// --- #1256: マスクの使い回しと、バックエンド判定値のヒント ---------------------

import { maskLiterals, readOnlyWithHint } from "../dangerousSql";

describe("maskLiterals のキャッシュ (#1256)", () => {
  it("同じ (driver, sql) は同じ結果を返し、driver が違えば別々に計算する", () => {
    // MySQL は `'...'` 内のバックスラッシュをエスケープとして読む。`\'` の扱いが違うので
    // driver ごとにマスク結果が変わるケースで、キャッシュが driver を区別することを確かめる。
    const sql = "SELECT 'a\\' ; DROP TABLE t -- '";
    const mysql1 = maskLiterals(sql, "mysql");
    const pg1 = maskLiterals(sql, "postgres");
    expect(mysql1).not.toBe(pg1);
    // 2 回目以降 (キャッシュヒット) も同じ値。
    expect(maskLiterals(sql, "mysql")).toBe(mysql1);
    expect(maskLiterals(sql, "postgres")).toBe(pg1);
    expect(maskLiterals(sql, "mysql")).toHaveLength(sql.length);
  });

  it("多数の異なる SQL を通したあとでも結果は変わらない (古いエントリの追い出し)", () => {
    const first = "DELETE FROM t WHERE note = 'x;y'";
    const before = maskLiterals(first, "sqlite");
    for (let i = 0; i < 50; i++) maskLiterals(`SELECT ${i} /* c${i} */`, "sqlite");
    expect(maskLiterals(first, "sqlite")).toBe(before);
  });

  it("キャッシュ上限を超える巨大な SQL でも正しくマスクする", () => {
    const big = `SELECT '${"a;".repeat(200 * 1024)}'`;
    const masked = maskLiterals(big, "sqlite");
    expect(masked).toHaveLength(big.length);
    expect(masked.includes(";")).toBe(false);
  });
});

describe("readOnlyWithHint (#1256)", () => {
  it("同じ SQL のヒントがあれば再計算せずその値を使う", () => {
    // ヒントの値をわざと実際の判定と逆にして、ヒントが使われていることを確かめる。
    expect(readOnlyWithHint({ sql: "SELECT 1", readOnly: false }, "SELECT 1", "mysql")).toBe(false);
    expect(readOnlyWithHint({ sql: "DELETE FROM t", readOnly: true }, "DELETE FROM t", "mysql")).toBe(true);
  });

  it("ヒントが無い / 別の SQL のものなら isReadOnlySql で求める", () => {
    expect(readOnlyWithHint(undefined, "SELECT 1", "mysql")).toBe(true);
    expect(readOnlyWithHint(null, "DELETE FROM t", "mysql")).toBe(false);
    expect(readOnlyWithHint({ sql: "SELECT 1", readOnly: true }, "DELETE FROM t", "mysql")).toBe(false);
  });
});

// Stryker (#1358) の生存変異を潰す境界ケース。
describe("analyzeDangerousSql: 変異テストで補強した境界ケース", () => {
  it("括弧が閉じたあとのトップレベル WHERE は守りとして認める", () => {
    // 閉じ括弧で depth が戻らないと WHERE を見落とす (depth-- の変異)
    expect(
      analyzeDangerousSql("UPDATE t SET c = (SELECT 1) WHERE id = 1"),
    ).toEqual([]);
    expect(
      analyzeDangerousSql("DELETE FROM t WHERE id IN (SELECT 1)"),
    ).toEqual([]);
  });

  it("括弧が深くなる前の余分な ) があっても depth が負にならない", () => {
    expect(analyzeDangerousSql("UPDATE t SET c = 1) WHERE id = 1")).toEqual([]);
  });

  it("WHERE が文頭・文末ぎりぎりでも単語境界で判定する", () => {
    expect(analyzeDangerousSql("UPDATE t SET c = 1 WHERE")).toEqual([]);
    expect(analyzeDangerousSql("UPDATE t SET somewhere = 1")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("UPDATE t SET c = 1 WHEREx")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("UPDATE t SET xwhere = 1")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
  });

  it("対象テーブル名の引用符 (` \" []) を外し、空白の多い構文も解釈する", () => {
    expect(analyzeDangerousSql("DELETE   FROM   `my db`.x")).toEqual([
      { kind: "deleteNoWhere", target: "my db" },
    ]);
    expect(analyzeDangerousSql('DELETE FROM "Users"')).toEqual([
      { kind: "deleteNoWhere", target: "Users" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM [dbo]")).toEqual([
      { kind: "deleteNoWhere", target: "dbo" },
    ]);
    expect(analyzeDangerousSql("UPDATE   `t` SET a = 1")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("TRUNCATE   TABLE   t")).toEqual([
      { kind: "truncate", target: "t" },
    ]);
    expect(analyzeDangerousSql("TRUNCATE   t")).toEqual([
      { kind: "truncate", target: "t" },
    ]);
    expect(analyzeDangerousSql("DROP   TABLE   IF   EXISTS   t")).toEqual([
      { kind: "drop", target: "t" },
    ]);
    expect(analyzeDangerousSql("DROP   DATABASE   d")).toEqual([
      { kind: "drop", target: "d" },
    ]);
  });

  it("対象が読み取れないときは target が null になる", () => {
    expect(analyzeDangerousSql("DELETE FROM ")).toEqual([
      { kind: "deleteNoWhere", target: null },
    ]);
    expect(analyzeDangerousSql("TRUNCATE ``")).toEqual([
      { kind: "truncate", target: null },
    ]);
  });

  it("コメント・文字列内の WHERE は守りにならず、target は元のリテラルから取る", () => {
    expect(analyzeDangerousSql("DELETE FROM t -- WHERE id = 1")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("UPDATE t SET c = 'WHERE'")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
  });
});

describe("isReadOnlySql: 変異テストで補強した境界ケース", () => {
  it("READCOMMITTEDLOCK ヒントは読み取りではない", () => {
    expect(isReadOnlySql("SELECT * FROM t WITH (READCOMMITTEDLOCK)")).toBe(false);
  });

  it("空・コメントのみ・区切りだけの文は読み取り専用ではない", () => {
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("   ")).toBe(false);
    expect(isReadOnlySql(";;; ")).toBe(false);
    expect(isReadOnlySql("-- only comment")).toBe(false);
  });

  it("ヒント群の外側にあるロックヒント名は無視し、群内は必ず見る", () => {
    expect(isReadOnlySql("SELECT updlock FROM t")).toBe(true);
    expect(isReadOnlySql("SELECT * FROM t WITH (INDEX(1) , UPDLOCK)")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t WITH (NOLOCK) JOIN u WITH (XLOCK) ON 1=1")).toBe(false);
  });
});
