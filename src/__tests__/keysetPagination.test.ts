import { describe, expect, it } from "vitest";
import type { Column, TableColumnInfo } from "../api/tauri";
import {
  buildKeysetCondition,
  buildKeysetPageSql,
  keysetMoveFor,
  readKeysetAnchor,
  resolveKeysetPlan,
  reverseRowsForPrev,
  type KeysetPlan,
} from "../keysetPagination";

function col(name: string, data_type: string, key = "", nullable = false): TableColumnInfo {
  return {
    name,
    data_type,
    nullable,
    key,
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  } as TableColumnInfo;
}
const cols = (names: string[]): Column[] => names.map((name) => ({ name, type_name: "x" }));

const drivers = ["mysql", "postgres", "sqlite"] as const;
const q = (d: string, n: string) => (d === "mysql" ? `\`${n}\`` : `"${n}"`);

describe("resolveKeysetPlan", () => {
  const table = [col("id", "bigint", "PRI"), col("name", "text"), col("note", "text", "", true)];
  const rc = cols(["id", "name", "note"]);

  it("ソート無しは主キー昇順", () => {
    expect(resolveKeysetPlan(table, null, rc)).toEqual({
      keys: [{ column: "id", direction: "asc", numeric: true }],
    });
  });

  it("ソート列 + 主キーのタイブレークを同方向で並べる", () => {
    expect(resolveKeysetPlan(table, { column: "name", direction: "desc" }, rc)?.keys).toEqual([
      { column: "name", direction: "desc", numeric: false },
      { column: "id", direction: "desc", numeric: true },
    ]);
  });

  it("ソート列が主キーそのものなら重複させない", () => {
    expect(resolveKeysetPlan(table, { column: "id", direction: "desc" }, rc)?.keys).toHaveLength(1);
  });

  it("複合主キーは全列をキーにする", () => {
    const t = [col("a", "int", "PRI"), col("b", "int", "PRI"), col("c", "text")];
    expect(resolveKeysetPlan(t, null, cols(["a", "b", "c"]))?.keys.map((k) => k.column)).toEqual(["a", "b"]);
  });

  it("NULL 可能なソート列は OFFSET にフォールバック (null)", () => {
    expect(resolveKeysetPlan(table, { column: "note", direction: "asc" }, rc)).toBeNull();
  });

  it("NULL 可能な主キー列 (SQLite) も null", () => {
    const t = [col("id", "text", "PRI", true)];
    expect(resolveKeysetPlan(t, null, cols(["id"]))).toBeNull();
  });

  it("主キー無し / describe 未取得 / 結果に列が無いときは null", () => {
    expect(resolveKeysetPlan([col("x", "int")], null, cols(["x"]))).toBeNull();
    expect(resolveKeysetPlan(null, null, rc)).toBeNull();
    expect(resolveKeysetPlan(table, null, cols(["name"]))).toBeNull();
    expect(resolveKeysetPlan(table, { column: "zzz", direction: "asc" }, rc)).toBeNull();
  });

  it("バイナリ/JSON 型のキーは null", () => {
    expect(resolveKeysetPlan([col("id", "bytea", "PRI")], null, cols(["id"]))).toBeNull();
    expect(resolveKeysetPlan(table, { column: "name", direction: "asc" }, rc)).not.toBeNull();
    expect(
      resolveKeysetPlan([col("id", "int", "PRI"), col("j", "jsonb")], { column: "j", direction: "asc" }, cols(["id", "j"])),
    ).toBeNull();
  });
});

describe("readKeysetAnchor", () => {
  const plan: KeysetPlan = {
    keys: [
      { column: "name", direction: "asc", numeric: false },
      { column: "id", direction: "asc", numeric: true },
    ],
  };
  const rc = cols(["id", "name"]);
  it("結果列の位置に関係なくキー順に取り出す", () => {
    expect(readKeysetAnchor(plan, rc, [7, "bob"])).toEqual(["bob", 7]);
  });
  it("NULL や行なしは null", () => {
    expect(readKeysetAnchor(plan, rc, [7, null])).toBeNull();
    expect(readKeysetAnchor(plan, rc, undefined)).toBeNull();
  });
});

describe("buildKeysetCondition / buildKeysetPageSql", () => {
  const single: KeysetPlan = { keys: [{ column: "id", direction: "asc", numeric: true }] };
  const composite: KeysetPlan = {
    keys: [
      { column: "a", direction: "asc", numeric: false },
      { column: "b", direction: "asc", numeric: true },
    ],
  };
  const mixed: KeysetPlan = {
    keys: [
      { column: "a", direction: "asc", numeric: false },
      { column: "b", direction: "desc", numeric: true },
    ],
  };

  it("単一キー: next は > / prev は < で ORDER BY を反転", () => {
    for (const d of drivers) {
      const id = q(d, "id");
      expect(buildKeysetPageSql(`SELECT * FROM t`, d, null, single, [10], "next", 50)).toBe(
        `SELECT * FROM t WHERE ${id} > 10 ORDER BY ${id} ASC LIMIT 50`,
      );
      expect(buildKeysetPageSql(`SELECT * FROM t`, d, null, single, [10], "prev", 50)).toBe(
        `SELECT * FROM t WHERE ${id} < 10 ORDER BY ${id} DESC LIMIT 50`,
      );
    }
  });

  it("降順キーは next が < / prev が >", () => {
    const desc: KeysetPlan = { keys: [{ column: "id", direction: "desc", numeric: true }] };
    expect(buildKeysetCondition("postgres", desc, [5], "next")).toBe(`"id" < 5`);
    expect(buildKeysetCondition("postgres", desc, [5], "prev")).toBe(`"id" > 5`);
  });

  it("複合キー同方向は行値比較 (3 方言)", () => {
    for (const d of drivers) {
      const [a, b] = [q(d, "a"), q(d, "b")];
      expect(buildKeysetCondition(d, composite, ["x", 3], "next")).toBe(`(${a}, ${b}) > ('x', 3)`);
      expect(buildKeysetCondition(d, composite, ["x", 3], "prev")).toBe(`(${a}, ${b}) < ('x', 3)`);
    }
  });

  it("方向が混在するキーは OR 展開", () => {
    expect(buildKeysetCondition("postgres", mixed, ["x", 3], "next")).toBe(
      `(("a" > 'x') OR ("a" = 'x' AND "b" < 3))`,
    );
    expect(buildKeysetCondition("postgres", mixed, ["x", 3], "prev")).toBe(
      `(("a" < 'x') OR ("a" = 'x' AND "b" > 3))`,
    );
  });

  it("サーバ側フィルタは括弧で包んで AND する", () => {
    const sql = buildKeysetPageSql(
      `SELECT * FROM t`,
      "sqlite",
      { column: "name", op: "contains", value: "a", numeric: false },
      single,
      [1],
      "next",
      10,
    );
    expect(sql).toBe(
      `SELECT * FROM t WHERE ("name" LIKE '%a%' ESCAPE '\\') AND "id" > 1 ORDER BY "id" ASC LIMIT 10`,
    );
  });

  it("64bit 整数は文字列のまま裸で埋め込み丸めない", () => {
    expect(buildKeysetCondition("mysql", single, ["9223372036854775807"], "next")).toBe(
      "`id` > 9223372036854775807",
    );
  });

  it("非数値列の文字列は方言別にクオートする (MySQL のみバックスラッシュ二重化)", () => {
    const s: KeysetPlan = { keys: [{ column: "k", direction: "asc", numeric: false }] };
    expect(buildKeysetCondition("mysql", s, ["a\\b'c"], "next")).toBe("`k` > 'a\\\\b''c'");
    expect(buildKeysetCondition("postgres", s, ["a\\b'c"], "next")).toBe(`"k" > 'a\\b''c'`);
    expect(buildKeysetCondition("sqlite", s, ["a\\b'c"], "next")).toBe(`"k" > 'a\\b''c'`);
  });

  it("数値列でも数値でない文字列は SQL インジェクションしない", () => {
    expect(buildKeysetCondition("postgres", single, ["1; DROP TABLE t"], "next")).toBe(
      `"id" > '1; DROP TABLE t'`,
    );
  });

  it("pageSize は 1 以上の整数に丸める", () => {
    expect(buildKeysetPageSql("SELECT * FROM t", "sqlite", null, single, [1], "next", 0)).toMatch(/LIMIT 1$/);
  });
});

describe("reverseRowsForPrev", () => {
  it("prev だけ反転し、元配列は変更しない", () => {
    const rows = [1, 2, 3];
    expect(reverseRowsForPrev(rows, "prev")).toEqual([3, 2, 1]);
    expect(rows).toEqual([1, 2, 3]);
    expect(reverseRowsForPrev(rows, "next")).toBe(rows);
  });
});

describe("keysetMoveFor", () => {
  it("隣接ページだけ keyset", () => {
    expect(keysetMoveFor(3, 4, false, false)).toBe("next");
    expect(keysetMoveFor(3, 2, false, false)).toBe("prev");
  });
  it("ジャンプ・強制再取得・サイズ変更・1 ページ目への復帰は OFFSET", () => {
    expect(keysetMoveFor(3, 9, false, false)).toBeNull();
    expect(keysetMoveFor(1, 2, true, false)).toBeNull();
    expect(keysetMoveFor(1, 2, false, true)).toBeNull();
    expect(keysetMoveFor(2, 1, false, false)).toBeNull();
  });
});
