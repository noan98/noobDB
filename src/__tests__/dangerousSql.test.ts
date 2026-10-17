import { describe, it, expect } from "vitest";
import {
  analyzeDangerousSql,
  appendWhereTemplate,
  buildPkWhereTemplate,
  isReadOnlySql,
  MASK_SPLIT_PAIRS,
} from "../dangerousSql";

describe("analyzeDangerousSql", () => {
  it("flags DELETE without a top-level WHERE", () => {
    expect(analyzeDangerousSql("DELETE FROM users")).toEqual([{ kind: "deleteNoWhere", target: "users" }]);
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
    expect(analyzeDangerousSql("UPDATE users SET active = 0 WHERE id = 1")).toEqual([]);
  });

  it("does not treat a WHERE inside a sub-select as the statement's guard", () => {
    expect(analyzeDangerousSql("UPDATE t SET c = (SELECT x FROM y WHERE y.id = 1)")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
  });

  it("does not treat a WHERE inside a string literal as a guard", () => {
    expect(analyzeDangerousSql("UPDATE t SET note = 'delete where all rows'")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
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
    expect(analyzeDangerousSql("DROP TABLE foo")).toEqual([{ kind: "drop", target: "foo" }]);
    expect(analyzeDangerousSql("DROP TABLE IF EXISTS foo")).toEqual([{ kind: "drop", target: "foo" }]);
  });

  it("flags TRUNCATE with and without the optional TABLE keyword", () => {
    expect(analyzeDangerousSql("TRUNCATE foo")).toEqual([{ kind: "truncate", target: "foo" }]);
    expect(analyzeDangerousSql("TRUNCATE TABLE foo")).toEqual([{ kind: "truncate", target: "foo" }]);
  });

  it("strips quoting from the parsed target identifier", () => {
    expect(analyzeDangerousSql("DROP TABLE `my table`")).toEqual([{ kind: "drop", target: "my table" }]);
    expect(analyzeDangerousSql('DELETE FROM "my tbl"')).toEqual([
      { kind: "deleteNoWhere", target: "my tbl" },
    ]);
  });

  it("returns a null target when it cannot be parsed", () => {
    expect(analyzeDangerousSql("DELETE")).toEqual([{ kind: "deleteNoWhere", target: null }]);
  });

  it("reports one finding per dangerous statement", () => {
    expect(analyzeDangerousSql("DELETE FROM a; UPDATE b SET x = 1")).toEqual([
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
    expect(analyzeDangerousSql("/* cleanup */ DELETE FROM sessions")).toEqual([
      { kind: "deleteNoWhere", target: "sessions" },
    ]);
  });

  it("does not treat a WHERE inside a dollar-quoted string as a guard", () => {
    // PostgreSQL: $$…$$ / $tag$…$tag$ are string literals; a `where` inside
    // must not make an unguarded UPDATE look safe.
    expect(analyzeDangerousSql("UPDATE t SET c = $$ where id = 1 $$")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("UPDATE t SET c = $tag$ where id = 1 $tag$")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
  });

  it("does not split statements on a semicolon inside a dollar-quoted string", () => {
    expect(analyzeDangerousSql("UPDATE t SET c = $$a; b$$ WHERE id = 1")).toEqual([]);
  });

  it("does not mistake parameter placeholders or $-identifiers for dollar quotes", () => {
    // `$1 … $1` must not be swallowed as a string: the DELETE stays visible.
    expect(analyzeDangerousSql("DELETE FROM t; SELECT $1 WHERE x = $1")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
    // `a$b` is a MySQL-legal identifier, not an opening tag.
    expect(analyzeDangerousSql("DELETE FROM a$b")).toEqual([{ kind: "deleteNoWhere", target: "a$b" }]);
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
      expect(analyzeDangerousSql(sql, "mysql")).toEqual([{ kind: "updateNoWhere", target: "t" }]);
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
    expect(isReadOnlySql("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toBe(false);
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
    expect(isReadOnlySql("SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','UPDATE t SET a=1') AS r")).toBe(
      false,
    );
    expect(isReadOnlySql("SELECT * FROM OPENQUERY(linked_srv, 'DELETE FROM accounts')")).toBe(false);
    expect(isReadOnlySql("SELECT dblink_exec('dbname=other','DELETE FROM accounts')")).toBe(false);
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
    expect(isReadOnlySql("SELECT 1 /*! UNION SELECT password FROM users */")).toBe(true);
    expect(isReadOnlySql("SELECT 1 /*!50000 , (SELECT DELETE FROM users) */")).toBe(false);
    // An ordinary block comment (no `!`) is unaffected.
    expect(isReadOnlySql("SELECT 1 /* normal comment with DELETE inside */")).toBe(true);
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
    expect(analyzeDangerousSql("UPDATE t SET c = (SELECT 1) WHERE id = 1")).toEqual([]);
    expect(analyzeDangerousSql("DELETE FROM t WHERE id IN (SELECT 1)")).toEqual([]);
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
    expect(analyzeDangerousSql("UPDATE t SET xwhere = 1")).toEqual([{ kind: "updateNoWhere", target: "t" }]);
  });

  it("引用符付きのスキーマ修飾名は修飾名全体を対象にする (#1517)", () => {
    expect(analyzeDangerousSql("DROP TABLE `shop`.`orders`")).toEqual([
      { kind: "drop", target: "shop.orders" },
    ]);
    expect(analyzeDangerousSql('DELETE FROM "public"."users"')).toEqual([
      { kind: "deleteNoWhere", target: "public.users" },
    ]);
    expect(analyzeDangerousSql('DELETE FROM public."users"')).toEqual([
      { kind: "deleteNoWhere", target: "public.users" },
    ]);
    expect(analyzeDangerousSql("TRUNCATE TABLE [dbo].[t]")).toEqual([{ kind: "truncate", target: "dbo.t" }]);
  });

  it('対象テーブル名の引用符 (` " []) を外し、空白の多い構文も解釈する', () => {
    expect(analyzeDangerousSql("DELETE   FROM   `my db`.x")).toEqual([
      { kind: "deleteNoWhere", target: "my db.x" },
    ]);
    expect(analyzeDangerousSql('DELETE FROM "Users"')).toEqual([{ kind: "deleteNoWhere", target: "Users" }]);
    expect(analyzeDangerousSql("DELETE FROM [dbo]")).toEqual([{ kind: "deleteNoWhere", target: "dbo" }]);
    expect(analyzeDangerousSql("UPDATE   `t` SET a = 1")).toEqual([{ kind: "updateNoWhere", target: "t" }]);
    expect(analyzeDangerousSql("TRUNCATE   TABLE   t")).toEqual([{ kind: "truncate", target: "t" }]);
    expect(analyzeDangerousSql("TRUNCATE   t")).toEqual([{ kind: "truncate", target: "t" }]);
    expect(analyzeDangerousSql("DROP   TABLE   IF   EXISTS   t")).toEqual([{ kind: "drop", target: "t" }]);
    expect(analyzeDangerousSql("DROP   DATABASE   d")).toEqual([{ kind: "drop", target: "d" }]);
  });

  it("対象が読み取れないときは target が null になる", () => {
    expect(analyzeDangerousSql("DELETE FROM ")).toEqual([{ kind: "deleteNoWhere", target: null }]);
    expect(analyzeDangerousSql("TRUNCATE ``")).toEqual([{ kind: "truncate", target: null }]);
  });

  it("コメント・文字列内の WHERE は守りにならず、target は元のリテラルから取る", () => {
    expect(analyzeDangerousSql("DELETE FROM t -- WHERE id = 1")).toEqual([
      { kind: "deleteNoWhere", target: "t" },
    ]);
    expect(analyzeDangerousSql("UPDATE t SET c = 'WHERE'")).toEqual([{ kind: "updateNoWhere", target: "t" }]);
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

describe("# は MySQL だけ行コメント (#1517)", () => {
  it("PostgreSQL の # 演算子の後ろに隠れた DELETE を検出する", () => {
    expect(analyzeDangerousSql("SELECT 1 # 2; DELETE FROM orders", "postgres")).toEqual([
      { kind: "deleteNoWhere", target: "orders" },
    ]);
    expect(analyzeDangerousSql("SELECT 1 # 2; DELETE FROM orders", "mysql")).toEqual([]);
  });

  it("PostgreSQL の #>> の後ろの FOR UPDATE を読み取り専用と誤判定しない", () => {
    const sql = "SELECT data #>> '{a}' FROM t WHERE id = 1 FOR UPDATE";
    expect(isReadOnlySql(sql, "postgres")).toBe(false);
  });
});

describe("ドライバ別リテラル (#1601)", () => {
  it("PostgreSQL の E'…' 内の \\' で閉じず、後続の DELETE を見逃さない", () => {
    const sql = "SELECT E'\\'' ; DELETE FROM t;";
    expect(analyzeDangerousSql(sql, "postgres").map((d) => d.kind)).toEqual(["deleteNoWhere"]);
    expect(isReadOnlySql(sql, "postgres")).toBe(false);
  });

  it("E'…' 内の \\' で WHERE を見失って updateNoWhere と誤判定しない", () => {
    expect(analyzeDangerousSql("UPDATE t SET name = E'O\\'Brien' WHERE id = 1;", "postgres")).toEqual([]);
  });

  it("SQLite の [角括弧] 識別子内の ' が後続の DELETE を隠さない", () => {
    const sql = "SELECT [a'] ; DELETE FROM t;";
    expect(analyzeDangerousSql(sql, "sqlite").map((d) => d.kind)).toEqual(["deleteNoWhere"]);
    expect(isReadOnlySql(sql, "sqlite")).toBe(false);
  });
});

describe("主キーで絞る WHERE の雛形 (#1626)", () => {
  const q = (n: string) => n;
  it("主キー列から雛形を作り、無ければ null", () => {
    expect(buildPkWhereTemplate(["id"], q)).toBe("WHERE id = ");
    expect(buildPkWhereTemplate(["a", "b"], q)).toBe("WHERE a = AND b = ");
    expect(buildPkWhereTemplate(["id"], (n) => `\`${n}\``)).toBe("WHERE `id` = ");
    expect(buildPkWhereTemplate([], q)).toBeNull();
  });

  it("WHERE なしの単純な UPDATE / DELETE の末尾にだけ足す", () => {
    expect(appendWhereTemplate("DELETE FROM t;", "WHERE id = ")).toBe("DELETE FROM t\nWHERE id = ");
    expect(appendWhereTemplate("UPDATE t SET a = 'where' ", "WHERE id = ")).toBe(
      "UPDATE t SET a = 'where'\nWHERE id = ",
    );
  });

  it("複数文・RETURNING / ORDER BY / LIMIT / JOIN・SELECT は提案しない", () => {
    expect(appendWhereTemplate("DELETE FROM t; DELETE FROM u", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("DELETE FROM t RETURNING id", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("UPDATE t SET a = 1 LIMIT 5", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("UPDATE t JOIN u ON 1 SET a = 1", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("SELECT * FROM t", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("", "WHERE id = ")).toBeNull();
  });
});

// --- #1663: Stryker 生存変異の補強 -------------------------------------------------

describe("maskLiterals — 境界・オプション・キャッシュキー (#1663)", () => {
  it("改行はリテラル/ブロックコメントの内側でも保たれ、行コメントは改行の手前で止まる", () => {
    expect(maskLiterals("SELECT 'a\nb'")).toBe("SELECT ' \n '");
    expect(maskLiterals("/* a\nb */SELECT 1")).toBe("    \n    SELECT 1");
    expect(maskLiterals("SELECT 1 -- x\nSELECT 2")).toBe("SELECT 1     \nSELECT 2");
  });

  it("`-` 1 文字は行コメントにならない (算術のマイナス)", () => {
    expect(maskLiterals("SELECT 5-3 FROM t")).toBe("SELECT 5-3 FROM t");
    expect(maskLiterals("SELECT a - b, 1--1")).toBe("SELECT a - b, 1   ");
  });

  it("行頭の # コメントでも前進する (直前が改行でも無限ループしない)", () => {
    expect(maskLiterals("SELECT 1\n# DROP\nSELECT 2", "mysql")).toBe("SELECT 1\n      \nSELECT 2");
    // PostgreSQL / SQLite の # は演算子。
    expect(maskLiterals("SELECT 1\n# DROP", "postgres")).toBe("SELECT 1\n# DROP");
  });

  it("`/*/` は閉じコメントではない (開始の `/*` と終端の `*/` で `*` を共有しない)", () => {
    expect(maskLiterals("SELECT 1 /*/ ; DROP TABLE t */ ;")).toBe("SELECT 1                       ;");
  });

  it("文字列の先頭が `$$` のドル引用でも伏せる (i === 0)", () => {
    expect(maskLiterals("$$ x ; y $$ SELECT 1", "postgres")).toBe("$$       $$ SELECT 1");
  });

  it("ドル引用を閉じた後は閉じタグの先頭から再走査せず、本文末尾の引用符で新たな文字列を開かない", () => {
    // 本文が `'a` で終わる。閉じタグより手前へ戻ると `'` が文字列を開き、後続の DROP を隠してしまう。
    expect(maskLiterals("SELECT $$'a$$; DROP TABLE t; --'", "postgres")).toBe(
      "SELECT $$  $$; DROP TABLE t;    ",
    );
  });

  it("`$1$` のように数字で始まるタグはドル引用ではない", () => {
    expect(maskLiterals("SELECT $1$ ; DROP TABLE t $1$", "postgres")).toBe("SELECT $1$ ; DROP TABLE t $1$");
  });

  it("末尾が `$tag` で閉じない入力でも停止し、タグ文字列の再出現をドル引用と誤認しない", () => {
    expect(maskLiterals("SELECT $abc", "postgres")).toBe("SELECT $abc");
    expect(maskLiterals("SELECT $a FROM t WHERE x = $a AND 1", "postgres")).toBe(
      "SELECT $a FROM t WHERE x = $a AND 1",
    );
  });

  it("SQLite の角括弧識別子: 直前の `]` へ戻らず前進し、keepQuotedIdentifiers で中身を残す", () => {
    expect(maskLiterals("SELECT a][b] FROM t", "sqlite")).toBe("SELECT a][ ] FROM t");
    expect(maskLiterals("SELECT [name] FROM t", "sqlite")).toBe("SELECT [    ] FROM t");
    expect(maskLiterals("SELECT [name] FROM t", "sqlite", { keepQuotedIdentifiers: true })).toBe(
      "SELECT [name] FROM t",
    );
    // keepBrackets なら角括弧を特別扱いしない (中の `'` が文字列を開く従来の読み方)。
    expect(maskLiterals("SELECT [a'b] FROM t", "sqlite", { keepBrackets: true })).toBe("SELECT [a'         ");
    expect(maskLiterals("SELECT [a'b] FROM t", "sqlite")).toBe("SELECT [   ] FROM t");
  });

  it("PostgreSQL の E'…' だけが \\ をエスケープとして読む", () => {
    // 先頭 (i === 1) の E'。
    expect(maskLiterals("E'a\\'b'; DROP TABLE t", "postgres")).toBe("E'    '; DROP TABLE t");
    expect(maskLiterals("e'a\\'b'; DROP TABLE t", "postgres")).toBe("e'    '; DROP TABLE t");
    // 途中の E'。
    expect(maskLiterals("SELECT E'a\\'b'; DROP TABLE t", "postgres")).toBe("SELECT E'    '; DROP TABLE t");
    // 直前が識別子文字 (ASCII / U+0080 以上) なら E 接頭辞ではない。
    expect(maskLiterals("SELECT tE'a\\'; DROP TABLE t", "postgres")).toBe("SELECT tE'  '; DROP TABLE t");
    expect(maskLiterals("\u0080E'a\\'; DROP TABLE t", "postgres")).toBe("\u0080E'  '; DROP TABLE t");
    // `'` 以外の引用符 (識別子) は E 接頭辞でも \\ をエスケープにしない。
    expect(maskLiterals('SELECT e"a\\" , 1; DROP TABLE t', "postgres")).toBe(
      'SELECT e"  " , 1; DROP TABLE t',
    );
  });

  it("オプション違いはキャッシュキーを共有しない (同じ SQL・同じ driver でも結果が変わる)", () => {
    const sql = "SELECT `col_a`, [col_b] FROM t";
    // 同じ入力を先にオプション無しで、次にオプション付きで、さらに逆順で呼ぶ。
    const plain = maskLiterals(sql, "sqlite");
    const keepIdent = maskLiterals(sql, "sqlite", { keepQuotedIdentifiers: true });
    const keepBr = maskLiterals(sql, "sqlite", { keepBrackets: true });
    expect(plain).not.toBe(keepIdent);
    expect(plain).not.toBe(keepBr);
    expect(keepIdent).not.toBe(keepBr);
    expect(maskLiterals(sql, "sqlite")).toBe(plain);
    expect(maskLiterals(sql, "sqlite", { keepQuotedIdentifiers: true })).toBe(keepIdent);
    expect(maskLiterals(sql, "sqlite", { keepBrackets: true })).toBe(keepBr);
    // driver 違いも別キー: MySQL だけ \\ をエスケープと読む。
    const bs = "SELECT 'a\\' ; DROP TABLE t; --'";
    const my = maskLiterals(bs, "mysql");
    const pg = maskLiterals(bs, "postgres");
    expect(my).not.toBe(pg);
    expect(maskLiterals(bs, "mysql")).toBe(my);
    expect(maskLiterals(bs)).toBe(pg);
  });

  it("MASK_SPLIT_PAIRS は補完が割ってはならない 2 文字の組を過不足なく持つ", () => {
    expect([...MASK_SPLIT_PAIRS].sort()).toEqual(["--", "/*", "*/", "''", '""', "``"].sort());
  });
});

describe("analyzeDangerousSql — 文ごとの対象・WHERE 判定 (#1663)", () => {
  it("2 文目の対象は 2 文目の表名 (文全体ではなく当該文の原文から取る)", () => {
    expect(analyzeDangerousSql("DELETE FROM a WHERE x = 1; DELETE FROM b")).toEqual([
      { kind: "deleteNoWhere", target: "b" },
    ]);
    expect(analyzeDangerousSql("UPDATE a SET x = 1 WHERE y = 1; UPDATE b SET x = 1")).toEqual([
      { kind: "updateNoWhere", target: "b" },
    ]);
  });

  it("`w` で始まる別の語・列名を WHERE と誤認しない", () => {
    expect(analyzeDangerousSql("UPDATE t SET w = 1")).toEqual([{ kind: "updateNoWhere", target: "t" }]);
    expect(analyzeDangerousSql("UPDATE t SET word = 1, whereabouts = 2")).toEqual([
      { kind: "updateNoWhere", target: "t" },
    ]);
  });

  it("対象表の読み取り: 先頭アンカー・括弧つき識別子・修飾名の各パート", () => {
    // 表名が読めない形は null (途中の語を拾わない)。
    expect(analyzeDangerousSql("DELETE FROM (t)")).toEqual([{ kind: "deleteNoWhere", target: null }]);
    expect(analyzeDangerousSql("DROP TABLE (x)")).toEqual([{ kind: "drop", target: null }]);
    // 2 パート目以降が複数文字でも丸ごと読む (角括弧 / 裸の識別子)。
    expect(analyzeDangerousSql("DELETE FROM dbo.[ab]")).toEqual([
      { kind: "deleteNoWhere", target: "dbo.ab" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM [ab].[cd]")).toEqual([
      { kind: "deleteNoWhere", target: "ab.cd" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM [ab]")).toEqual([{ kind: "deleteNoWhere", target: "ab" }]);
    expect(analyzeDangerousSql("DELETE FROM shop.orders")).toEqual([
      { kind: "deleteNoWhere", target: "shop.orders" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM `shop`.`orders`")).toEqual([
      { kind: "deleteNoWhere", target: "shop.orders" },
    ]);
    expect(analyzeDangerousSql('TRUNCATE TABLE "s"."tt"')).toEqual([{ kind: "truncate", target: "s.tt" }]);
  });

  it("ALTER ... DROP の対象表: 語間の複数空白・ONLY / IF EXISTS を読み飛ばす", () => {
    expect(analyzeDangerousSql("ALTER  TABLE  t  DROP COLUMN c")).toEqual([
      { kind: "dropColumn", target: "t" },
    ]);
    expect(analyzeDangerousSql("ALTER TABLE ONLY IF EXISTS s.t DROP CONSTRAINT k")).toEqual([
      { kind: "dropConstraint", target: "s.t" },
    ]);
    expect(analyzeDangerousSql("ALTER TABLE t ADD COLUMN c INT")).toEqual([]);
  });
});

describe("appendWhereTemplate — 対象の先頭アンカー (#1663)", () => {
  it("文の先頭が UPDATE / DELETE でなければ提案しない (語の途中・文中の語を拾わない)", () => {
    expect(appendWhereTemplate("xupdate t SET a = 1", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("SELECT delete FROM t", "WHERE id = ")).toBeNull();
    expect(appendWhereTemplate("UPDATE t SET w = 1", "WHERE id = ")).toBe("UPDATE t SET w = 1\nWHERE id = ");
  });
});

describe("isReadOnlySql — WITH (...) ロックヒントの範囲 (#1663)", () => {
  it("ヒントの括弧を閉じた後ろの語はヒントとして数えない", () => {
    expect(isReadOnlySql("SELECT * FROM t WITH (NOLOCK) WHERE updlock = 1")).toBe(true);
    expect(isReadOnlySql("SELECT * FROM t WITH (INDEX(0)) WHERE holdlock = 1")).toBe(true);
  });

  it("入れ子の括弧に包まれたヒントも検出する", () => {
    expect(isReadOnlySql("SELECT * FROM t WITH (UPDLOCK(1))")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t WITH (INDEX(0)UPDLOCK)")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t WITH (NOLOCK) JOIN u WITH (HOLDLOCK) ON 1")).toBe(false);
  });
});

describe("変異テスト補強 その 2 (#1663)", () => {
  it("MySQL バージョンコメント `/*!` の判定は `/` `*` `!` が揃ったときだけ", () => {
    // `/` の 2 つ後ろが `!` でも、間が `*` でなければバージョンコメントではない。
    expect(maskLiterals("SELECT 4/2!=3")).toBe("SELECT 4/2!=3");
    expect(maskLiterals("SELECT a*!b")).toBe("SELECT a*!b");
    expect(maskLiterals("SELECT 1 /*!40000 , 2 */", "mysql")).toBe("SELECT 1          , 2 */");
  });

  it("ALTER TABLE 以外の ALTER ... DROP は危険文として数えない", () => {
    expect(analyzeDangerousSql("ALTER VIEW v DROP COLUMN c")).toEqual([]);
    expect(analyzeDangerousSql("ALTER INDEX i DROP CONSTRAINT k")).toEqual([]);
  });

  it("IF と EXISTS の間の複数空白でも ALTER TABLE の対象表を読む", () => {
    expect(analyzeDangerousSql("ALTER TABLE IF  EXISTS t DROP COLUMN c")).toEqual([
      { kind: "dropColumn", target: "t" },
    ]);
  });

  it("角括弧で囲んだ識別子は記号・空白を含んでも 1 つの名前として読む", () => {
    expect(analyzeDangerousSql("DELETE FROM [my table]")).toEqual([
      { kind: "deleteNoWhere", target: "my table" },
    ]);
    expect(analyzeDangerousSql("DELETE FROM dbo.[my table]")).toEqual([
      { kind: "deleteNoWhere", target: "dbo.my table" },
    ]);
  });
});
