import { describe, it, expect } from "vitest";
import {
  buildPreflightPlan,
  preflightTone,
  PREFLIGHT_LARGE_THRESHOLD,
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
