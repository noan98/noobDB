import { describe, expect, it } from "vitest";
import {
  batchExportFileName,
  batchTimestamp,
  exportFileExtension,
  joinTableDdls,
  summarizeTableNames,
} from "../components/batchTables";

describe("joinTableDdls (#1399)", () => {
  it("末尾の ; を揃えて空行で連結する", () => {
    expect(
      joinTableDdls([
        { table: "a", ddl: "CREATE TABLE a (id int)\n" },
        { table: "b", ddl: "CREATE TABLE b (id int);" },
      ]),
    ).toBe("CREATE TABLE a (id int);\n\nCREATE TABLE b (id int);");
  });

  it("空の DDL は捨てる", () => {
    expect(joinTableDdls([{ table: "a", ddl: "  " }])).toBe("");
  });
});

describe("batchExportFileName", () => {
  it("形式ごとの拡張子を付ける", () => {
    expect(exportFileExtension("markdown")).toBe(".md");
    expect(exportFileExtension("json")).toBe(".json");
    expect(batchExportFileName("users", "csv", new Set())).toBe("users.csv");
  });

  it("使えない文字を置き換える", () => {
    expect(batchExportFileName("a/b:c", "csv", new Set())).toBe("a_b_c.csv");
    expect(batchExportFileName("..", "csv", new Set())).toBe("table.csv");
    expect(batchExportFileName("t. ", "csv", new Set())).toBe("t.csv");
  });

  it("大文字小文字だけが違う名前は連番で衝突を避ける", () => {
    const used = new Set<string>();
    expect(batchExportFileName("Users", "csv", used)).toBe("Users.csv");
    expect(batchExportFileName("users", "csv", used)).toBe("users_2.csv");
    expect(batchExportFileName("USERS", "csv", used)).toBe("USERS_3.csv");
  });
});

describe("batchExportFileName: 上書き回避と予約名", () => {
  it("日時を付けて既存ファイルを上書きしない", () => {
    expect(batchExportFileName("users", "csv", new Set(), "20260101_090000")).toBe("users_20260101_090000.csv");
    expect(batchTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102_030405");
  });

  it("Windows の予約デバイス名は _ を付けて避ける", () => {
    expect(batchExportFileName("CON", "csv", new Set())).toBe("CON_.csv");
    expect(batchExportFileName("nul", "csv", new Set())).toBe("nul_.csv");
    expect(batchExportFileName("Com1", "csv", new Set())).toBe("Com1_.csv");
    expect(batchExportFileName("lpt9.v2", "csv", new Set())).toBe("lpt9.v2_.csv");
    expect(batchExportFileName("COM0", "csv", new Set())).toBe("COM0.csv");
    expect(batchExportFileName("console", "csv", new Set())).toBe("console.csv");
  });
});

describe("summarizeTableNames", () => {
  const more = (n: number) => `+${n}`;
  it("少なければそのまま並べる", () => {
    expect(summarizeTableNames(["a", "b"], 3, more)).toBe("a, b");
  });
  it("多ければ畳む", () => {
    expect(summarizeTableNames(["a", "b", "c", "d", "e"], 3, more)).toBe("a, b, c, +2");
  });
});
