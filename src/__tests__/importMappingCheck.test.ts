import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import {
  isRequiredColumn,
  mappingRowState,
  mappingSummary,
  missingRequiredColumns,
  sampleValue,
} from "../components/importMappingCheck";

function col(over: Partial<TableColumnInfo> & { name: string }): TableColumnInfo {
  return {
    data_type: "varchar(10)",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    ...over,
  };
}

const MYSQL: TableColumnInfo[] = [
  col({ name: "id", data_type: "int", nullable: false, key: "PRI", extra: "auto_increment" }),
  col({ name: "name", nullable: false }),
  col({ name: "status", nullable: false, default: "active" }),
  col({ name: "memo" }),
  col({ name: "total", data_type: "int", nullable: false, extra: "STORED GENERATED" }),
];

describe("isRequiredColumn (#2126)", () => {
  it("NOT NULL で DEFAULT・自動採番・生成列のどれでもない列だけが必須", () => {
    expect(MYSQL.filter((c) => isRequiredColumn("mysql", c, MYSQL)).map((c) => c.name)).toEqual(["name"]);
  });

  it("空文字の DEFAULT も既定値として扱う", () => {
    const c = col({ name: "x", nullable: false, default: "" });
    expect(isRequiredColumn("mysql", c, [c])).toBe(false);
  });

  it("PostgreSQL は nextval と IDENTITY を自動採番として扱う", () => {
    const serial = col({ name: "a", nullable: false, default: "nextval('s'::regclass)" });
    const ident = col({ name: "b", nullable: false, extra: "IDENTITY" });
    const plain = col({ name: "c", nullable: false });
    const t = [serial, ident, plain];
    expect(t.filter((c) => isRequiredColumn("postgres", c, t)).map((c) => c.name)).toEqual(["c"]);
  });

  it("SQLite の単一 INTEGER PRIMARY KEY は rowid の別名で必須ではない", () => {
    const pk = col({ name: "id", data_type: "INTEGER", nullable: false, key: "PRI" });
    expect(isRequiredColumn("sqlite", pk, [pk])).toBe(false);
    const composite = [pk, col({ name: "k", data_type: "INTEGER", nullable: false, key: "PRI" })];
    expect(isRequiredColumn("sqlite", composite[0], composite)).toBe(true);
  });
});

describe("mappingRowState / missingRequiredColumns (#2126)", () => {
  it("割り当て済みは mapped、未対応は必須かどうかで skipped / required", () => {
    expect(mappingRowState("mysql", MYSQL[1], MYSQL, 0)).toBe("mapped");
    expect(mappingRowState("mysql", MYSQL[1], MYSQL, 0 as number | null)).toBe("mapped");
    expect(mappingRowState("mysql", MYSQL[1], MYSQL, null)).toBe("required");
    expect(mappingRowState("mysql", MYSQL[3], MYSQL, null)).toBe("skipped");
    expect(mappingRowState("mysql", MYSQL[2], MYSQL, undefined)).toBe("skipped");
  });

  it("未対応の必須列を列順で返す", () => {
    expect(missingRequiredColumns("mysql", MYSQL, {})).toEqual(["name"]);
    expect(missingRequiredColumns("mysql", MYSQL, { name: 1 })).toEqual([]);
    // index 0 は有効な割り当て (falsy と混同しない)。
    expect(missingRequiredColumns("mysql", MYSQL, { name: 0 })).toEqual([]);
  });
});

describe("mappingSummary / sampleValue (#2126)", () => {
  it("対応済みの列数と全列数を返す", () => {
    expect(mappingSummary(MYSQL, { id: 0, name: 1, memo: null })).toEqual({ mapped: 2, total: 5 });
  });

  it("先頭行の値を返し、範囲外・未対応・行なしは null、空文字は空のまま", () => {
    const rows = [
      ["a", ""],
      ["b", "c"],
    ];
    expect(sampleValue(rows, 0)).toBe("a");
    expect(sampleValue(rows, 1)).toBe("");
    expect(sampleValue(rows, 5)).toBeNull();
    expect(sampleValue(rows, null)).toBeNull();
    expect(sampleValue([], 0)).toBeNull();
  });
});
