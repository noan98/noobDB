import { describe, expect, it } from "vitest";
import { bulkExportPath, joinTableDdls } from "../components/tableBulk";

describe("joinTableDdls", () => {
  it("各 DDL を `;` で終えて空行で区切り、空の DDL は捨てる", () => {
    expect(joinTableDdls(["CREATE TABLE a (id int)", "CREATE TABLE b (id int);\n", "  "])).toBe(
      "CREATE TABLE a (id int);\n\nCREATE TABLE b (id int);",
    );
  });
});

describe("bulkExportPath", () => {
  it("区切り文字をフォルダに合わせ、末尾の区切りは重ねない", () => {
    expect(bulkExportPath("C:\\out\\", "users", "csv")).toBe("C:\\out\\users.csv");
    expect(bulkExportPath("/tmp/out", "users", "markdown")).toBe("/tmp/out/users.md");
  });

  it("ファイル名に使えない文字は _ にする", () => {
    expect(bulkExportPath("/tmp", 'a/b:c"d', "json")).toBe("/tmp/a_b_c_d.json");
  });
});
