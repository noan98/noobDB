import { describe, expect, it } from "vitest";
import {
  breadcrumbItems,
  buildFkPeekOpenSql,
  buildFkPeekSql,
  FK_PEEK_MAX_COLUMNS,
  FK_PEEK_MAX_TRAIL,
  peekBack,
  peekCanBack,
  peekCanForward,
  peekCurrent,
  peekFollow,
  peekFollowTarget,
  peekForward,
  peekGoTo,
  peekSlideDirection,
  peekStart,
  planPeekColumns,
  type PeekColumnMeta,
  type PeekStep,
} from "../fkPeek";

const step = (table: string, value: PeekStep["value"] = 1): PeekStep => ({ table, column: "id", value });

describe("buildFkPeekSql", () => {
  it("FK ジャンプの SELECT に LIMIT 1 を付ける", () => {
    expect(buildFkPeekSql({ driver: "mysql", database: "shop", step: step("customers", 42) })).toBe(
      "SELECT * FROM `shop`.`customers` WHERE `id` = 42 LIMIT 1",
    );
    expect(buildFkPeekSql({ driver: "postgres", database: null, step: step("customers", "a'b") })).toBe(
      `SELECT * FROM "customers" WHERE "id" = 'a''b' LIMIT 1`,
    );
  });
  it("グリッドで開く SQL は LIMIT 無し", () => {
    expect(buildFkPeekOpenSql({ driver: "sqlite", step: step("customers", 7) })).not.toMatch(/LIMIT/);
  });
  it("64bit 整数の文字列を丸めない", () => {
    const sql = buildFkPeekSql({ driver: "mysql", step: step("t", "9223372036854775807") });
    expect(sql).toContain("9223372036854775807");
  });
});

describe("パンくずの状態遷移", () => {
  it("たどると履歴が伸び、戻る / 進むで往復できる", () => {
    let t = peekStart(step("customers"));
    expect(peekCanBack(t)).toBe(false);
    t = peekFollow(t, step("regions"));
    expect(t.index).toBe(1);
    expect(peekCurrent(t).table).toBe("regions");
    t = peekBack(t);
    expect(peekCurrent(t).table).toBe("customers");
    expect(peekCanForward(t)).toBe(true);
    t = peekForward(t);
    expect(peekCurrent(t).table).toBe("regions");
  });
  it("端での戻る / 進むは同じ状態を返す", () => {
    const t = peekStart(step("a"));
    expect(peekBack(t)).toBe(t);
    expect(peekForward(t)).toBe(t);
  });
  it("戻った後でたどると先の履歴を捨てる", () => {
    let t = peekFollow(peekFollow(peekStart(step("a")), step("b")), step("c"));
    t = peekBack(peekBack(t));
    t = peekFollow(t, step("d"));
    expect(t.steps.map((s) => s.table)).toEqual(["a", "d"]);
    expect(t.index).toBe(1);
  });
  it("履歴の上限を超えたら古い方から落とす", () => {
    let t = peekStart(step("t0"));
    for (let i = 1; i <= FK_PEEK_MAX_TRAIL + 3; i++) t = peekFollow(t, step(`t${i}`));
    expect(t.steps).toHaveLength(FK_PEEK_MAX_TRAIL);
    expect(peekCurrent(t).table).toBe(`t${FK_PEEK_MAX_TRAIL + 3}`);
    expect(t.index).toBe(FK_PEEK_MAX_TRAIL - 1);
  });
  it("peekGoTo は範囲を丸める", () => {
    const t = peekFollow(peekStart(step("a")), step("b"));
    expect(peekGoTo(t, -5).index).toBe(0);
    expect(peekGoTo(t, 99).index).toBe(1);
    expect(peekGoTo(t, 1)).toBe(t);
  });
  it("スライドの向き: 進むは正、戻るは負、同じなら 0", () => {
    expect(peekSlideDirection(0, 1)).toBe(1);
    expect(peekSlideDirection(2, 0)).toBe(-1);
    expect(peekSlideDirection(1, 1)).toBe(0);
  });
  it("パンくずは起点 → たどった順。起点は移動先なし、先の履歴は ahead", () => {
    let t = peekFollow(peekFollow(peekStart(step("customers")), step("regions")), step("countries"));
    t = peekBack(t);
    const items = breadcrumbItems("orders", t);
    expect(items.map((i) => i.label)).toEqual(["orders", "customers", "regions", "countries"]);
    expect(items.map((i) => i.stepIndex)).toEqual([null, 0, 1, 2]);
    expect(items.map((i) => i.current)).toEqual([false, false, true, false]);
    expect(items.map((i) => i.ahead)).toEqual([false, false, false, true]);
    expect(breadcrumbItems(null, t)[0].label).toBe("customers");
  });
});

const meta = (name: string, o: Partial<PeekColumnMeta> = {}): PeekColumnMeta => ({
  name,
  data_type: "varchar(50)",
  nullable: true,
  key: "",
  referenced_table: null,
  referenced_column: null,
  ...o,
});
const cols = (names: string[]) => names.map((name) => ({ name, type_name: "VARCHAR" }));

describe("planPeekColumns", () => {
  it("メタが無ければ先頭から上限まで", () => {
    const names = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const plan = planPeekColumns(cols(names), null);
    expect(plan.shown).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.hidden).toBe(10 - FK_PEEK_MAX_COLUMNS);
    expect(plan.followable).toEqual([]);
  });
  it("PK → NOT NULL の文字列列 → それ以外の優先順で選び、表示は列順", () => {
    const names = ["a_null", "b_num", "c_nn", "id", "d_nn", "e_null"];
    const m = [
      meta("a_null"),
      meta("b_num", { data_type: "int", nullable: false }),
      meta("c_nn", { nullable: false }),
      meta("id", { key: "PRI", data_type: "int", nullable: false }),
      meta("d_nn", { nullable: false }),
      meta("e_null"),
    ];
    const plan = planPeekColumns(cols(names), m, 3);
    expect(plan.shown).toEqual([2, 3, 4]);
    expect(plan.hidden).toBe(3);
  });
  it("FK 列は主要な列に入らなくてもたどれるように加える", () => {
    const names = ["id", "name", "x1", "x2", "region_id"];
    const m = [
      meta("id", { key: "PRI", nullable: false }),
      meta("name", { nullable: false }),
      meta("x1"),
      meta("x2"),
      meta("region_id", { referenced_table: "regions", referenced_column: "id", data_type: "int" }),
    ];
    const plan = planPeekColumns(cols(names), m, 2);
    expect(plan.shown).toEqual([0, 1, 4]);
    expect(plan.followable).toEqual([4]);
    expect(plan.hidden).toBe(2);
  });
});

describe("peekFollowTarget", () => {
  const m = [
    meta("region_id", { referenced_table: "regions", referenced_column: "id" }),
    meta("half", { referenced_table: "regions", referenced_column: null }),
  ];
  it("参照先が解決できる列だけ返す (論理リレーションも同じ形)", () => {
    expect(peekFollowTarget(m, "region_id")).toEqual({ table: "regions", column: "id" });
    expect(peekFollowTarget(m, "half")).toBeNull();
    expect(peekFollowTarget(m, "nope")).toBeNull();
    expect(peekFollowTarget(null, "region_id")).toBeNull();
  });
});
