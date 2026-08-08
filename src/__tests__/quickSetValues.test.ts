import { describe, expect, it } from "vitest";
import type { Column, TableColumnInfo } from "../api/tauri";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  quickSetOptions,
  resolveDynamicValue,
} from "../components/quickSetValues";
import { editIsNoop, validateCellInput } from "../components/cellEdit";

// セル右クリックの「値をセット」ショートカット (NULL / 空文字 / 0 / true / false /
// 現在日時) の純ロジック。ここで生成される値は「ユーザが手で打てたはずの生文字列」
// でなければならず、既存の検証 (`validateCellInput`) を必ず通ることを固定する。

function col(name: string, type_name: string): Column {
  return { name, type_name };
}

function meta(name: string, nullable: boolean): TableColumnInfo {
  return {
    name,
    data_type: "",
    nullable,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  };
}

// 固定時刻 (ローカルタイム 2024-03-05 07:08:09)。UTC 起点だと実行環境の TZ で
// 日付がずれるため、ローカル成分を指定して生成する。
const NOW = new Date(2024, 2, 5, 7, 8, 9);

function ids(column: Column, m: TableColumnInfo | null = null, driver?: string) {
  return quickSetOptions({ column, meta: m, now: NOW, driver }).map((o) => o.id);
}

describe("quickSetOptions", () => {
  it("どの型の列にも NULL を出す", () => {
    expect(ids(col("a", "VARCHAR"))).toContain("null");
    expect(ids(col("a", "INT"))).toContain("null");
    expect(ids(col("a", "DATETIME"))).toContain("null");
    expect(ids(col("a", "BOOLEAN"))).toContain("null");
  });

  it("NOT NULL 列では NULL を無効化し、理由を添える", () => {
    const [nullOpt] = quickSetOptions({
      column: col("a", "VARCHAR"),
      meta: meta("a", false),
      now: NOW,
    });
    expect(nullOpt.id).toBe("null");
    expect(nullOpt.disabledReason).toBe("editInvalidNotNull");
  });

  it("メタデータが無い列は nullable 扱い (検証の既定と揃える)", () => {
    const [nullOpt] = quickSetOptions({ column: col("a", "VARCHAR"), now: NOW });
    expect(nullOpt.disabledReason).toBeUndefined();
  });

  it("列の型に応じた定番値だけを出す", () => {
    expect(ids(col("a", "INT"))).toEqual(["null", "zero"]);
    expect(ids(col("a", "BOOLEAN"))).toEqual(["null", "true", "false"]);
    expect(ids(col("a", "VARCHAR"))).toEqual(["null", "empty"]);
    expect(ids(col("a", "DATE"))).toEqual(["null", "now"]);
    expect(ids(col("a", "TIME"))).toEqual(["null", "now"]);
    expect(ids(col("a", "DATETIME"))).toEqual(["null", "now"]);
    expect(ids(col("a", "TIMESTAMP(3)"))).toEqual(["null", "now"]);
  });

  // BIT はドライバで意味が変わる唯一の型。MSSQL では真偽型そのもの
  // (`literalFromInput` が 1/0 へ落とす) だが、PostgreSQL / DuckDB では
  // ビット列 ('10110000') なので true/false も空文字も不正なリテラルになる。
  it("BIT 列は真偽型として扱う (MSSQL / MySQL / SQLite)", () => {
    expect(ids(col("a", "BIT"), null, "mssql")).toEqual(["null", "true", "false"]);
    expect(ids(col("a", "bit"), null, "mysql")).toEqual(["null", "true", "false"]);
    expect(ids(col("a", "BIT(1)"), null, "sqlite")).toEqual(["null", "true", "false"]);
  });

  it("ビット列ドライバの BIT 列では NULL 以外を出さない", () => {
    expect(ids(col("a", "BIT"), null, "postgres")).toEqual(["null"]);
    expect(ids(col("a", "BIT(8)"), null, "duckdb")).toEqual(["null"]);
    // 空文字を出してしまうと bit(n) では必ず Apply が失敗する。
    expect(ids(col("a", "BIT(8)"), null, "postgres")).not.toContain("empty");
  });

  it("日時系の値は列の粒度に合わせて整形する", () => {
    const opt = (type: string) =>
      quickSetOptions({ column: col("a", type), now: NOW }).find((o) => o.id === "now");
    expect(opt("DATE")).toMatchObject({ value: "2024-03-05", dynamic: "date" });
    expect(opt("TIME")).toMatchObject({ value: "07:08:09", dynamic: "time" });
    expect(opt("DATETIME")).toMatchObject({
      value: "2024-03-05 07:08:09",
      dynamic: "datetime",
    });
  });

  it("生成した値はすべて列の検証を通る (NOT NULL 列の NULL を除く)", () => {
    const cases: [string, boolean][] = [
      ["VARCHAR", true],
      ["VARCHAR", false],
      ["INT", true],
      ["INT", false],
      ["BOOLEAN", true],
      ["DATE", true],
      ["TIME", true],
      ["DATETIME", true],
    ];
    for (const [type, nullable] of cases) {
      const column = col("a", type);
      for (const opt of quickSetOptions({ column, meta: meta("a", nullable), now: NOW })) {
        if (opt.disabledReason) continue;
        expect(
          validateCellInput(opt.value, type, nullable),
          `${type} (nullable=${nullable}) の ${opt.id}`,
        ).toBeNull();
      }
    }
  });
});

describe("resolveDynamicValue", () => {
  it("クリック時点の時計で組み立て直せる", () => {
    const later = new Date(2025, 11, 31, 23, 59, 58);
    expect(resolveDynamicValue("date", later)).toBe("2025-12-31");
    expect(resolveDynamicValue("time", later)).toBe("23:59:58");
    expect(resolveDynamicValue("datetime", later)).toBe("2025-12-31 23:59:58");
  });

  it("1 桁の月日時分秒をゼロ埋めする", () => {
    const d = new Date(2024, 0, 2, 3, 4, 5);
    expect(formatLocalDate(d)).toBe("2024-01-02");
    expect(formatLocalTime(d)).toBe("03:04:05");
    expect(formatLocalDateTime(d)).toBe("2024-01-02 03:04:05");
  });
});

describe("editIsNoop (クイックセットの無変更判定)", () => {
  it("すでに NULL のセルへの NULL セットは無変更", () => {
    expect(editIsNoop("NULL", col("a", "VARCHAR"), null)).toBe(true);
    expect(editIsNoop("NULL", col("a", "VARCHAR"), "x")).toBe(false);
  });

  it("値の型を跨いでも確定後の値で比較する", () => {
    expect(editIsNoop("0", col("a", "INT"), 0)).toBe(true);
    expect(editIsNoop("0", col("a", "INT"), 1)).toBe(false);
    expect(editIsNoop("true", col("a", "BOOLEAN"), true)).toBe(true);
    expect(editIsNoop("false", col("a", "BOOLEAN"), true)).toBe(false);
    // BIGINT/DECIMAL は精度維持のため文字列で届く。
    expect(editIsNoop("0", col("a", "BIGINT"), "0")).toBe(true);
  });

  it("空文字と NULL は別物として扱う", () => {
    expect(editIsNoop("", col("a", "VARCHAR"), null)).toBe(false);
    expect(editIsNoop("", col("a", "VARCHAR"), "")).toBe(true);
    expect(editIsNoop("NULL", col("a", "VARCHAR"), "")).toBe(false);
  });
});
