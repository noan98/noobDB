import { describe, expect, it } from "vitest";
import { buildCteRun, supportsCte } from "../cteRun";

/** `|` をカーソル位置として、その印を除いた本文でビルドする。 */
function run(src: string, driver = "postgres", limit: number | null = null) {
  const offset = src.indexOf("|");
  const text = src.replace("|", "");
  return buildCteRun({ text, offset, driver, limit });
}

function sqlOf(src: string, driver = "postgres", limit: number | null = null): string {
  const r = run(src, driver, limit);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  return r.sql;
}

describe("buildCteRun", () => {
  it("単一の CTE: 本体の SELECT を `SELECT * FROM cte` に置き換える", () => {
    const r = run("WITH a AS (SELECT |1 AS n) SELECT * FROM a WHERE n > 0");
    expect(r).toMatchObject({ ok: true, name: "a", title: "CTE: a", recursive: false });
    expect(sqlOf("WITH a AS (SELECT |1 AS n) SELECT * FROM a WHERE n > 0")).toBe(
      "WITH a AS (SELECT 1 AS n)\nSELECT * FROM a",
    );
  });

  it("後段の CTE を選ぶと、参照される前段だけが残る (未使用の CTE は落とす)", () => {
    const sql = sqlOf(
      "WITH a AS (SELECT 1 AS n), unused AS (SELECT 2 AS m), b AS (SELECT n FROM a WHERE |n > 0), c AS (SELECT 3) SELECT * FROM b",
    );
    expect(sql).toBe("WITH a AS (SELECT 1 AS n),\nb AS (SELECT n FROM a WHERE n > 0)\nSELECT * FROM b");
  });

  it("推移的な依存 (c -> b -> a) をたどり、元の順序で並べる", () => {
    const r = run(
      "WITH a AS (SELECT 1 AS n), x AS (SELECT 9), b AS (SELECT * FROM a), c AS (SELECT * FROM |b) SELECT 1",
    );
    expect(r).toMatchObject({ ok: true, keptNames: ["a", "b", "c"] });
  });

  it("先頭の CTE を選ぶと後段は含まれない", () => {
    const r = run("WITH a AS (SELECT |1), b AS (SELECT * FROM a) SELECT * FROM b");
    expect(r).toMatchObject({ ok: true, keptNames: ["a"] });
  });

  it("MySQL / PG の非 RECURSIVE では後段の同名は参照元にしない (実テーブルを指す)", () => {
    for (const d of ["postgres", "mysql"]) {
      const r = run("WITH a AS (SELECT * FROM |b), b AS (SELECT 1) SELECT 1", d);
      expect(r).toMatchObject({ ok: true, keptNames: ["a"] });
    }
  });

  it("SQLite は RECURSIVE なしでも前方参照できるので後段の CTE を残す", () => {
    const r = run("WITH a AS (SELECT * FROM |b), b AS (SELECT 7) SELECT * FROM a", "sqlite");
    expect(r).toMatchObject({ ok: true, keptNames: ["a", "b"] });
  });

  it("末尾の参照は元の綴りのまま (PG で WITH MyCte → SELECT * FROM MyCte)", () => {
    expect(sqlOf("WITH MyCte AS (SELECT |1) SELECT * FROM MyCte")).toBe(
      "WITH MyCte AS (SELECT 1)\nSELECT * FROM MyCte",
    );
  });

  it("SELECT ... FOR UPDATE はデータ変更扱いにしない (ロックは読み取り専用ガードが判定する)", () => {
    const r = run("WITH a AS (SELECT |1 FROM t FOR UPDATE) SELECT * FROM a", "mysql");
    expect(r).not.toMatchObject({ reason: "writes" });
  });

  it("複数文で 2 文目にも WITH があり、カーソルが `)` の直後なら前の CTE が対象", () => {
    const r = run(
      "WITH x AS (SELECT 0) SELECT * FROM x; WITH a AS (SELECT 1)| , b AS (SELECT 2) SELECT * FROM b",
    );
    expect(r).toMatchObject({ ok: true, keptNames: ["a"] });
  });

  it("引用符つきの名前・列リスト・MATERIALIZED を扱う", () => {
    const sql = sqlOf(
      'WITH "My CTE" (x, y) AS MATERIALIZED (SELECT 1, 2), t2 AS NOT MATERIALIZED (SELECT x FROM "My CTE" WHERE |x = 1) SELECT * FROM t2',
    );
    expect(sql).toBe(
      'WITH "My CTE" (x, y) AS MATERIALIZED (SELECT 1, 2),\nt2 AS NOT MATERIALIZED (SELECT x FROM "My CTE" WHERE x = 1)\nSELECT * FROM t2',
    );
  });

  it("MySQL ではバッククォート名で終端の SELECT を引用する", () => {
    const sql = sqlOf("WITH `a b` AS (SELECT |1) SELECT * FROM `a b`", "mysql");
    expect(sql).toBe("WITH `a b` AS (SELECT 1)\nSELECT * FROM `a b`");
  });

  it("コメントや文字列中の括弧・識別子に惑わされない", () => {
    const sql = sqlOf(
      "WITH a AS (SELECT ')' AS p /* ) */ -- )\n), b AS (SELECT 'a' AS s FROM x WHERE |1=1) SELECT * FROM b",
    );
    // 文字列 'a' やコメントの `a` は参照ではないので a は残らない。
    expect(sql).toBe("WITH b AS (SELECT 'a' AS s FROM x WHERE 1=1)\nSELECT * FROM b");
  });

  it("コメントを含む定義は本文のまま切り出す", () => {
    const sql = sqlOf("WITH a AS (\n  -- 注釈\n  SELECT |1\n) SELECT * FROM a");
    expect(sql).toBe("WITH a AS (\n  -- 注釈\n  SELECT 1\n)\nSELECT * FROM a");
  });

  it("入れ子の括弧・サブクエリを含む本体", () => {
    const sql = sqlOf(
      "WITH a AS (SELECT (SELECT max(((1+2))) ) AS m), b AS (SELECT * FROM (SELECT * FROM a) s WHERE |(1)) SELECT * FROM b",
    );
    expect(sql).toContain("WITH a AS (SELECT (SELECT max(((1+2))) ) AS m),\nb AS (");
    expect(sql.endsWith("\nSELECT * FROM b")).toBe(true);
  });

  it("名前の位置にカーソルがあっても対象になる / 大文字小文字は区別しない", () => {
    const r = run("WITH A AS (SELECT 1), |B AS (SELECT * FROM a) SELECT 1");
    expect(r).toMatchObject({ ok: true, keptNames: ["A", "B"] });
  });

  it("複数文のスクリプトではカーソルのある文だけを見る", () => {
    const sql = sqlOf("SELECT 1; WITH a AS (SELECT |2) SELECT * FROM a; SELECT 3");
    expect(sql).toBe("WITH a AS (SELECT 2)\nSELECT * FROM a");
  });

  it("WITH 句の外 / WITH が無い文では実行できない", () => {
    expect(run("WITH a AS (SELECT 1) SELECT * FROM a WHERE |1=1")).toEqual({
      ok: false,
      reason: "notInCte",
    });
    expect(run("SELECT |1")).toEqual({ ok: false, reason: "noCte" });
    expect(run("")).toEqual({ ok: false, reason: "noCte" });
  });

  describe("書き込みを含む CTE", () => {
    it("対象が書き込み CTE なら拒否する", () => {
      expect(run("WITH d AS (DELETE FROM t WHERE |id = 1 RETURNING *) SELECT * FROM d")).toEqual({
        ok: false,
        reason: "writes",
      });
      expect(run("WITH i AS (|INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i")).toEqual({
        ok: false,
        reason: "writes",
      });
    });

    it("依存先に書き込み CTE が含まれるなら拒否する", () => {
      expect(
        run("WITH u AS (UPDATE t SET a = 1 RETURNING *), r AS (SELECT * FROM u WHERE |1=1) SELECT * FROM r"),
      ).toEqual({ ok: false, reason: "writes" });
    });

    it("無関係な書き込み CTE は落ちるので、読み取りの CTE は実行できる", () => {
      const r = run("WITH d AS (DELETE FROM t RETURNING *), r AS (SELECT |1) SELECT * FROM r");
      expect(r).toMatchObject({ ok: true, keptNames: ["r"] });
    });

    it("文字列中の語は書き込み扱いにしない / 関数 INSERT() は読み取り専用ガードが安全側で拒否する", () => {
      expect(run("WITH a AS (SELECT |'delete me' AS s) SELECT * FROM a")).toMatchObject({ ok: true });
      expect(run("WITH a AS (SELECT |INSERT('abc', 1, 1, 'x') AS s) SELECT * FROM a", "mysql")).toEqual({
        ok: false,
        reason: "notReadOnly",
      });
    });
  });

  describe("RECURSIVE", () => {
    const rec =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE |i < 5) SELECT * FROM n";

    it("再帰 CTE は recursive: true で、limit があれば末尾に LIMIT を付ける", () => {
      expect(run(rec, "postgres", 100)).toMatchObject({ ok: true, recursive: true });
      expect(sqlOf(rec, "postgres", 100)).toBe(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)\nSELECT * FROM n\nLIMIT 100",
      );
    });

    it("limit が無ければ付けない (通常の自動 LIMIT に任せる)", () => {
      expect(sqlOf(rec)).not.toMatch(/LIMIT/);
    });

    it("SQLite は RECURSIVE なしでも再帰するので LIMIT を付ける", () => {
      const src = "WITH n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE |i < 5) SELECT * FROM n";
      expect(run(src, "sqlite", 100)).toMatchObject({ ok: true, recursive: true });
      expect(sqlOf(src, "sqlite", 100)).toMatch(/\nLIMIT 100$/);
      // MySQL / PG は RECURSIVE なしなら再帰ではない。
      expect(run(src, "postgres", 100)).toMatchObject({ ok: true, recursive: false });
    });

    it("再帰でない CTE には明示の LIMIT を付けない (RECURSIVE 宣言があっても)", () => {
      const r = run("WITH RECURSIVE a AS (SELECT |1), n AS (SELECT * FROM a) SELECT 1", "sqlite", 50);
      expect(r).toMatchObject({ ok: true, recursive: false });
      expect(sqlOf("WITH RECURSIVE a AS (SELECT |1) SELECT 1", "sqlite", 50)).not.toMatch(/LIMIT/);
    });

    it("RECURSIVE では前方参照 (PostgreSQL) の CTE も残す", () => {
      const r = run("WITH RECURSIVE a AS (SELECT * FROM |b), b AS (SELECT 1) SELECT 1", "postgres");
      expect(r).toMatchObject({ ok: true, keptNames: ["a", "b"] });
    });
  });
});

describe("supportsCte", () => {
  it("MySQL 5.7 は不可、8.0 以降は可", () => {
    expect(supportsCte("mysql", "5.7.44")).toBe(false);
    expect(supportsCte("mysql", "8.0.34")).toBe(true);
    expect(supportsCte("mysql", "8.4.0")).toBe(true);
  });
  it("MariaDB は 10.2 以降が可", () => {
    expect(supportsCte("mysql", "10.1.48-MariaDB")).toBe(false);
    expect(supportsCte("mysql", "10.6.12-MariaDB")).toBe(true);
  });
  it("版が不明なら塞がない / PG・SQLite は常に可", () => {
    expect(supportsCte("mysql", null)).toBe(true);
    expect(supportsCte("postgres", "90600")).toBe(true);
    expect(supportsCte("sqlite", null)).toBe(true);
  });
});
