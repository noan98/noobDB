import { describe, expect, it } from "vitest";
import {
  buildSampleCards,
  dummyValue,
  selectedOps,
  type SampleColumn,
  type SampleOptions,
} from "../components/auditSample";

// 監査トリガーの見本の組み立て (#2324)。

const COLS: SampleColumn[] = [
  { name: "id", dataType: "int", primaryKey: true },
  { name: "email", dataType: "varchar(255)", primaryKey: false },
  { name: "meta", dataType: "jsonb", primaryKey: false },
];

const OPTS: SampleOptions = {
  insert: true,
  update: true,
  delete: true,
  exclude_columns: [],
  skip_unchanged_update: true,
};

describe("buildSampleCards", () => {
  it("INSERT は old_row が NULL、DELETE は new_row が NULL、UPDATE は両方持つ", () => {
    const [ins, upd, del] = buildSampleCards(COLS, OPTS);
    expect([ins.op, upd.op, del.op]).toEqual(["insert", "update", "delete"]);
    expect(ins.oldRow).toBeNull();
    expect(ins.newRow).toHaveLength(3);
    expect(upd.oldRow).toHaveLength(3);
    expect(upd.newRow).toHaveLength(3);
    expect(del.oldRow).toHaveLength(3);
    expect(del.newRow).toBeNull();
  });

  it("選ばれていない操作のカードは作らない", () => {
    const cards = buildSampleCards(COLS, { ...OPTS, insert: false, delete: false });
    expect(cards.map((c) => c.op)).toEqual(["update"]);
    expect(buildSampleCards(COLS, { ...OPTS, insert: false, update: false, delete: false })).toEqual([]);
  });

  it("除外列は印が付くだけで残り、pk は除外しても主キーを残す", () => {
    const [ins] = buildSampleCards(COLS, { ...OPTS, exclude_columns: ["email", "id"] });
    expect(ins.newRow?.map((c) => [c.name, c.excluded])).toEqual([
      ["id", true],
      ["email", true],
      ["meta", false],
    ]);
    expect(ins.pk?.map((c) => [c.name, c.excluded])).toEqual([["id", false]]);
  });

  it("主キーが無い表の pk は null", () => {
    const cols = COLS.map((c) => ({ ...c, primaryKey: false }));
    expect(buildSampleCards(cols, OPTS)[0].pk).toBeNull();
  });

  it("変化のない UPDATE を記録しない設定は UPDATE だけに付く", () => {
    const on = buildSampleCards(COLS, OPTS);
    expect(on.map((c) => c.skipsUnchanged)).toEqual([false, true, false]);
    const off = buildSampleCards(COLS, { ...OPTS, skip_unchanged_update: false });
    expect(off.every((c) => !c.skipsUnchanged)).toBe(true);
  });

  it("値は型ファミリーのダミーで、実データは入らない", () => {
    const [ins] = buildSampleCards(COLS, OPTS);
    expect(ins.newRow?.map((c) => c.value)).toEqual([
      dummyValue("number"),
      dummyValue("string"),
      dummyValue("json"),
    ]);
    expect(dummyValue("number")).toBe("<int>");
  });
});

describe("selectedOps", () => {
  it("INSERT / UPDATE / DELETE の順で返す", () => {
    expect(selectedOps({ ...OPTS, update: false })).toEqual(["insert", "delete"]);
  });
});
