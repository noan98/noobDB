import { describe, it, expect } from "vitest";
import {
  buildPreflightPlan,
  preflightTone,
  PREFLIGHT_LARGE_THRESHOLD,
  PREFLIGHT_MAX_CHARS,
} from "../components/preflight";

describe("buildPreflightPlan — 対象外は null (バッジを出さない)", () => {
  it("SELECT は null", () => {
    expect(buildPreflightPlan("SELECT * FROM users")).toBeNull();
  });
  it("INSERT は null", () => {
    expect(buildPreflightPlan("INSERT INTO users (id) VALUES (1)")).toBeNull();
  });
  it("DDL (DROP/TRUNCATE) は null", () => {
    expect(buildPreflightPlan("DROP TABLE users")).toBeNull();
    expect(buildPreflightPlan("TRUNCATE TABLE users")).toBeNull();
  });
  it("空文字/空白のみは null", () => {
    expect(buildPreflightPlan("")).toBeNull();
    expect(buildPreflightPlan("   \n  ")).toBeNull();
    expect(buildPreflightPlan("-- just a comment")).toBeNull();
  });
  it("複数文 (末尾以外に ;) は null", () => {
    expect(buildPreflightPlan("SELECT 1; DELETE FROM users WHERE id = 1")).toBeNull();
    expect(buildPreflightPlan("UPDATE t SET a = 1 WHERE b = 2; DELETE FROM u")).toBeNull();
  });
});

describe("buildPreflightPlan — 単純な DELETE", () => {
  it("WHERE 付き DELETE を COUNT へ変換する", () => {
    const plan = buildPreflightPlan("DELETE FROM users WHERE age < 18");
    expect(plan).toEqual({
      verb: "delete",
      table: "users",
      allRows: false,
      countSql: "SELECT COUNT(*) FROM users WHERE age < 18",
    });
  });

  it("WHERE なし DELETE は全行 (allRows) で全件 COUNT", () => {
    const plan = buildPreflightPlan("DELETE FROM users");
    expect(plan).toEqual({
      verb: "delete",
      table: "users",
      allRows: true,
      countSql: "SELECT COUNT(*) FROM users",
    });
  });

  it("末尾セミコロンと余白を許容する", () => {
    const plan = buildPreflightPlan("DELETE FROM users WHERE id = 1 ;  \n");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM users WHERE id = 1");
    expect(plan?.allRows).toBe(false);
  });
});

describe("buildPreflightPlan — 単純な UPDATE", () => {
  it("WHERE 付き UPDATE を COUNT へ変換する", () => {
    const plan = buildPreflightPlan("UPDATE users SET active = 0 WHERE last_login < '2020-01-01'");
    expect(plan).toEqual({
      verb: "update",
      table: "users",
      allRows: false,
      countSql: "SELECT COUNT(*) FROM users WHERE last_login < '2020-01-01'",
    });
  });

  it("WHERE なし UPDATE は全行 (allRows)", () => {
    const plan = buildPreflightPlan("UPDATE users SET active = 0");
    expect(plan).toEqual({
      verb: "update",
      table: "users",
      allRows: true,
      countSql: "SELECT COUNT(*) FROM users",
    });
  });

  it("複数代入 (カンマ) があっても WHERE を正しく取り出す", () => {
    const plan = buildPreflightPlan("UPDATE t SET a = 1, b = 2 WHERE id = 5");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t WHERE id = 5");
  });
});

describe("buildPreflightPlan — 引用符付き識別子 (方言差)", () => {
  it("MySQL バッククオートのテーブル名を原文のまま保持する", () => {
    const plan = buildPreflightPlan("DELETE FROM `my order` WHERE `status` = 'x'");
    expect(plan?.table).toBe("`my order`");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM `my order` WHERE `status` = 'x'");
  });

  it("PostgreSQL ダブルクオートのテーブル名を原文のまま保持する", () => {
    const plan = buildPreflightPlan('UPDATE "Users" SET flag = true WHERE "id" = 3');
    expect(plan?.table).toBe('"Users"');
    expect(plan?.countSql).toBe('SELECT COUNT(*) FROM "Users" WHERE "id" = 3');
  });

  it("スキーマ修飾テーブル (db.table) を保持する", () => {
    const plan = buildPreflightPlan("DELETE FROM app.sessions WHERE expired = 1");
    expect(plan?.table).toBe("app.sessions");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM app.sessions WHERE expired = 1");
  });
});

// #1075 の退行固定。以前は `` `[^`]+` `` の交替が先頭パートだけを貪欲にマッチし、
// `` `mydb`.`orders` `` の対象テーブルを `` `mydb` `` と誤認 → 全く無関係な
// テーブルの COUNT を「影響: 約 N 行」として表示していた。
describe("buildPreflightPlan — 複合クオート + スキーマ修飾 (#1075)", () => {
  it("UPDATE `db`.`table` の全パートを対象テーブルとして読む", () => {
    const plan = buildPreflightPlan("UPDATE `mydb`.`orders` SET status = 1 WHERE id = 7", "mysql");
    expect(plan).toEqual({
      verb: "update",
      table: "`mydb`.`orders`",
      allRows: false,
      countSql: "SELECT COUNT(*) FROM `mydb`.`orders` WHERE id = 7",
    });
  });

  it("DELETE FROM `db`.`table` の全パートを対象テーブルとして読む", () => {
    const plan = buildPreflightPlan("DELETE FROM `mydb`.`orders` WHERE id = 7", "mysql");
    expect(plan).toEqual({
      verb: "delete",
      table: "`mydb`.`orders`",
      allRows: false,
      countSql: "SELECT COUNT(*) FROM `mydb`.`orders` WHERE id = 7",
    });
  });

  it("WHERE なしの複合クオートも先頭パートではなく全体で全件 COUNT する", () => {
    const plan = buildPreflightPlan("UPDATE `mydb`.`orders` SET status = 1", "mysql");
    expect(plan?.allRows).toBe(true);
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM `mydb`.`orders`");
  });

  it('PostgreSQL のダブルクオート複合形 ("s"."t") も読み切る', () => {
    const plan = buildPreflightPlan('DELETE FROM "public"."Users" WHERE "id" = 3');
    expect(plan?.table).toBe('"public"."Users"');
    expect(plan?.countSql).toBe('SELECT COUNT(*) FROM "public"."Users" WHERE "id" = 3');
  });

  it("クオートと裸識別子の混在 (db.\"t\" / `db`.t) も読み切る", () => {
    expect(buildPreflightPlan('UPDATE app."Users" SET a = 1 WHERE id = 2')?.countSql).toBe(
      'SELECT COUNT(*) FROM app."Users" WHERE id = 2',
    );
    expect(buildPreflightPlan("DELETE FROM `app`.sessions WHERE id = 2", "mysql")?.countSql).toBe(
      "SELECT COUNT(*) FROM `app`.sessions WHERE id = 2",
    );
  });

  it("3 パート修飾 (db.schema.table) も読み切る", () => {
    const plan = buildPreflightPlan('UPDATE "d"."s"."t" SET a = 1 WHERE id = 4');
    expect(plan?.table).toBe('"d"."s"."t"');
    expect(plan?.countSql).toBe('SELECT COUNT(*) FROM "d"."s"."t" WHERE id = 4');
  });

  it("ドット前後の空白を許容し原文のまま保持する", () => {
    const plan = buildPreflightPlan("DELETE FROM `db` . `t` WHERE id = 1", "mysql");
    expect(plan?.table).toBe("`db` . `t`");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM `db` . `t` WHERE id = 1");
  });

  it("クオート内のドットはパート区切りではない (`my.table` は 1 パート)", () => {
    const plan = buildPreflightPlan("DELETE FROM `my.table` WHERE id = 1", "mysql");
    expect(plan?.table).toBe("`my.table`");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM `my.table` WHERE id = 1");
  });

  it("二重化でエスケープしたクオート識別子でも終端をマスクと一致させる", () => {
    // `"a""b"` はダブルクオート 1 つ分の識別子。終端を誤ると先頭 `"a"` だけを
    // テーブルとみなして別テーブルの COUNT を出してしまう。
    const plan = buildPreflightPlan('DELETE FROM "a""b" WHERE id = 1');
    expect(plan?.table).toBe('"a""b"');
    expect(plan?.countSql).toBe('SELECT COUNT(*) FROM "a""b" WHERE id = 1');
  });

  it("複合クオート + 別名は従来どおり推定不可のまま", () => {
    expect(buildPreflightPlan("DELETE FROM `db`.`t` AS x WHERE x.id = 1", "mysql")?.countSql).toBe(
      null,
    );
    expect(buildPreflightPlan("UPDATE `db`.`t` x SET x.a = 1 WHERE x.id = 2", "mysql")?.countSql).toBe(
      null,
    );
  });

  it("ドットの後にパートが無い打ちかけは推定不可 (先頭パートを採らない)", () => {
    expect(buildPreflightPlan("DELETE FROM `db`. WHERE id = 1", "mysql")?.countSql).toBeNull();
    expect(buildPreflightPlan("UPDATE app. SET a = 1", "mysql")?.countSql).toBeNull();
  });

  it("未終端クオートのテーブル名は推定不可", () => {
    expect(buildPreflightPlan("DELETE FROM `db WHERE id = 1", "mysql")?.countSql).toBeNull();
    expect(buildPreflightPlan('UPDATE "db SET a = 1')?.countSql).toBeNull();
  });

  it("MSSQL の角括弧修飾は (マスク非対応のため) 推定不可へ縮退する", () => {
    expect(buildPreflightPlan("UPDATE [db].[dbo].[orders] SET a = 1 WHERE id = 1")?.countSql).toBe(
      null,
    );
  });
});

describe("buildPreflightPlan — マスク境界 (文字列/コメント内キーワード)", () => {
  it("文字列リテラル内の 'where' を句と誤認しない (全行判定)", () => {
    const plan = buildPreflightPlan("UPDATE t SET note = 'delete where now'");
    expect(plan?.allRows).toBe(true);
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t");
  });

  it("文字列リテラル内のセミコロンを文境界と誤認しない", () => {
    const plan = buildPreflightPlan("DELETE FROM t WHERE label = 'a;b;c'");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t WHERE label = 'a;b;c'");
  });

  it("引用符付き列名 `order` を ORDER 句と誤認しない", () => {
    const plan = buildPreflightPlan("UPDATE t SET x = 1 WHERE `order` = 5");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t WHERE `order` = 5");
    expect(plan?.allRows).toBe(false);
  });

  it("行コメントで隠した句を無視する", () => {
    const plan = buildPreflightPlan("DELETE FROM t -- WHERE keep_me\nWHERE id = 9");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t WHERE id = 9");
  });
});

describe("buildPreflightPlan — サブクエリはトップレベル句を汚さない", () => {
  it("WHERE 内のサブクエリの ORDER BY / FROM を誤検出しない", () => {
    const plan = buildPreflightPlan(
      "DELETE FROM t WHERE id IN (SELECT id FROM s ORDER BY id LIMIT 3)",
    );
    expect(plan?.countSql).toBe(
      "SELECT COUNT(*) FROM t WHERE id IN (SELECT id FROM s ORDER BY id LIMIT 3)",
    );
  });

  it("SET 内のサブクエリは影響行を変えない (WHERE のみで数える)", () => {
    const plan = buildPreflightPlan(
      "UPDATE t SET total = (SELECT SUM(amount) FROM lines WHERE lines.tid = t.id) WHERE t.open = 1",
    );
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t WHERE t.open = 1");
  });
});

describe("buildPreflightPlan — 推定不可へ降格する形状", () => {
  it("多表 UPDATE (JOIN) は推定不可", () => {
    const plan = buildPreflightPlan("UPDATE a JOIN b ON a.id = b.aid SET a.x = b.y");
    expect(plan).toEqual({ verb: "update", table: null, allRows: false, countSql: null });
  });

  it("カンマ多表 UPDATE は推定不可", () => {
    const plan = buildPreflightPlan("UPDATE a, b SET a.x = b.y WHERE a.id = b.aid");
    expect(plan?.countSql).toBeNull();
  });

  it("PostgreSQL の UPDATE ... FROM は推定不可", () => {
    const plan = buildPreflightPlan("UPDATE t SET x = o.x FROM other o WHERE t.id = o.id");
    expect(plan?.countSql).toBeNull();
  });

  it("DELETE ... USING は推定不可", () => {
    const plan = buildPreflightPlan("DELETE FROM t USING other WHERE t.id = other.id");
    expect(plan?.countSql).toBeNull();
  });

  it("MySQL 多表 DELETE (DELETE t FROM ...) は推定不可", () => {
    const plan = buildPreflightPlan("DELETE t FROM t JOIN u ON t.id = u.tid");
    expect(plan?.countSql).toBeNull();
  });

  it("ORDER BY / LIMIT 付きは推定不可", () => {
    expect(buildPreflightPlan("DELETE FROM t ORDER BY created LIMIT 100")?.countSql).toBeNull();
    expect(buildPreflightPlan("UPDATE t SET x = 1 LIMIT 10")?.countSql).toBeNull();
  });

  it("テーブル別名付きは推定不可 (保守側)", () => {
    expect(buildPreflightPlan("DELETE FROM t AS x WHERE x.id = 1")?.countSql).toBeNull();
    expect(buildPreflightPlan("UPDATE t x SET x.a = 1 WHERE x.id = 2")?.countSql).toBeNull();
  });

  it("WHERE 条件が空 (打ちかけ) は推定不可", () => {
    expect(buildPreflightPlan("DELETE FROM t WHERE")?.countSql).toBeNull();
    expect(buildPreflightPlan("UPDATE t SET x = 1 WHERE  ")?.countSql).toBeNull();
  });
});

describe("buildPreflightPlan — RETURNING の切り落とし", () => {
  it("PostgreSQL DELETE ... RETURNING は条件から RETURNING を除く", () => {
    const plan = buildPreflightPlan("DELETE FROM t WHERE id = 1 RETURNING *");
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t WHERE id = 1");
  });

  it("WHERE なし + RETURNING は全行", () => {
    const plan = buildPreflightPlan("DELETE FROM t RETURNING id");
    expect(plan?.allRows).toBe(true);
    expect(plan?.countSql).toBe("SELECT COUNT(*) FROM t");
  });
});

describe("preflightTone", () => {
  it("全行は常に危険", () => {
    expect(preflightTone(true, 0)).toBe("danger");
    expect(preflightTone(true, 5)).toBe("danger");
    expect(preflightTone(true, null)).toBe("danger");
  });
  it("閾値以上は警告", () => {
    expect(preflightTone(false, PREFLIGHT_LARGE_THRESHOLD)).toBe("warning");
    expect(preflightTone(false, PREFLIGHT_LARGE_THRESHOLD + 1)).toBe("warning");
  });
  it("少数・件数不明は中立", () => {
    expect(preflightTone(false, 0)).toBe("neutral");
    expect(preflightTone(false, PREFLIGHT_LARGE_THRESHOLD - 1)).toBe("neutral");
    expect(preflightTone(false, null)).toBe("neutral");
  });
});

describe("buildPreflightPlan — 長さ上限 (#1256)", () => {
  it("上限ちょうどまでは解析し、超えるとプリフライトしない (null)", () => {
    const head = "DELETE FROM users WHERE note = '";
    const tail = "'";
    const fill = (n: number) => "x".repeat(Math.max(0, n - head.length - tail.length));
    const atLimit = head + fill(PREFLIGHT_MAX_CHARS) + tail;
    expect(atLimit.length).toBe(PREFLIGHT_MAX_CHARS);
    expect(buildPreflightPlan(atLimit)?.verb).toBe("delete");
    expect(buildPreflightPlan(atLimit + " ")).toBeNull();
  });
});

// Stryker (#1358) の生存変異を潰す境界ケース。誤った COUNT を影響行数バッジに出す
// (= 無関係な行数を「影響行数」と誤表示する) 方向の誤判定に絞っている。
describe("buildPreflightPlan — 推定不可への降格 (変異テスト補強)", () => {
  const unest = (verb: "update" | "delete") => ({
    verb,
    table: null,
    allRows: false,
    countSql: null,
  });

  it("トップレベルの句キーワードごとに降格する", () => {
    const tails = [
      "JOIN b ON a.id = b.id",
      "USING b",
      "ORDER BY id",
      "LIMIT 1",
      "GROUP BY id",
      "HAVING 1",
      "UNION SELECT 1",
      "INTERSECT SELECT 1",
      "EXCEPT SELECT 1",
    ];
    for (const tail of tails) {
      expect(buildPreflightPlan(`DELETE FROM t WHERE a = 1 ${tail}`)).toEqual(unest("delete"));
      expect(buildPreflightPlan(`UPDATE t SET a = 1 WHERE a = 1 ${tail}`)).toEqual(unest("update"));
    }
    // 括弧内のサブクエリは降格しない
    expect(buildPreflightPlan("DELETE FROM t WHERE id IN (SELECT id FROM u ORDER BY id)")?.countSql).toBe(
      "SELECT COUNT(*) FROM t WHERE id IN (SELECT id FROM u ORDER BY id)",
    );
  });

  it("動詞だけ・対象が読めない・別名付きの形は verb を保ったまま降格する", () => {
    expect(buildPreflightPlan("DELETE")).toEqual(unest("delete"));
    expect(buildPreflightPlan("DELETE t FROM u WHERE a = 1")).toEqual(unest("delete"));
    expect(buildPreflightPlan("DELETE FROM")).toEqual(unest("delete"));
    expect(buildPreflightPlan("DELETE FROM t x WHERE a = 1")).toEqual(unest("delete"));
    expect(buildPreflightPlan("UPDATE")).toEqual(unest("update"));
    expect(buildPreflightPlan("UPDATE t")).toEqual(unest("update"));
    expect(buildPreflightPlan("UPDATE t x SET a = 1")).toEqual(unest("update"));
    expect(buildPreflightPlan("UPDATE a, b SET a.x = 1")).toEqual(unest("update"));
  });

  it("テーブル参照が読めない形 (空/未終端クオート・数字始まり・括弧・打ちかけのドット)", () => {
    for (const bad of ['""', "``", '"abc', "1t", "(t)", "db.", "`db`.", "db.(x)", "[t]"]) {
      expect(buildPreflightPlan(`DELETE FROM ${bad} WHERE a = 1`)).toEqual(unest("delete"));
      expect(buildPreflightPlan(`UPDATE ${bad} SET a = 1`)).toEqual(unest("update"));
    }
  });

  it("括弧だけ・動詞が無い文は null", () => {
    expect(buildPreflightPlan("(1)")).toBeNull();
    expect(buildPreflightPlan("(DELETE FROM t)")).toBeNull();
    expect(buildPreflightPlan(";")).toBeNull();
  });

  it("空白の量に関わらずテーブル参照を正しく切り出す", () => {
    expect(buildPreflightPlan("DELETE FROM   t   WHERE a = 1")?.table).toBe("t");
    expect(buildPreflightPlan('DELETE FROM"t" WHERE a = 1')?.table).toBe('"t"');
    expect(buildPreflightPlan("UPDATE\n\tdb . t SET a = 1")?.table).toBe("db . t");
  });

  it("RETURNING は条件から切り落とし、WHERE 直後の RETURNING は降格する", () => {
    expect(buildPreflightPlan("DELETE FROM t WHERE a = 1 RETURNING id", "postgres")?.countSql).toBe(
      "SELECT COUNT(*) FROM t WHERE a = 1",
    );
    expect(buildPreflightPlan("UPDATE t SET a = 1 WHERE b = 2 RETURNING *", "postgres")?.countSql).toBe(
      "SELECT COUNT(*) FROM t WHERE b = 2",
    );
    expect(buildPreflightPlan("DELETE FROM t WHERE RETURNING id", "postgres")).toEqual(unest("delete"));
    expect(buildPreflightPlan("DELETE FROM t WHERE", "postgres")).toEqual(unest("delete"));
  });

  it("preflightTone の境界", () => {
    expect(preflightTone(false, null)).toBe("neutral");
    expect(preflightTone(false, PREFLIGHT_LARGE_THRESHOLD - 1)).toBe("neutral");
    expect(preflightTone(false, PREFLIGHT_LARGE_THRESHOLD)).toBe("warning");
    expect(preflightTone(true, null)).toBe("danger");
  });
});
