import { describe, expect, it } from "vitest";
import { abbreviateList, bulkExportPaths, joinTableDdls } from "../components/tableBulk";
import { buildDropTablesSql } from "../components/tableMaintenance";

describe("joinTableDdls", () => {
  it("各 DDL を `;` で終えて空行で区切り、空の DDL は捨てる", () => {
    expect(joinTableDdls(["CREATE TABLE a (id int)", "CREATE TABLE b (id int);\n", "  "])).toBe(
      "CREATE TABLE a (id int);\n\nCREATE TABLE b (id int);",
    );
  });
});

describe("bulkExportPaths", () => {
  it("区切り文字をフォルダに合わせ、末尾の区切りは重ねない", () => {
    expect(bulkExportPaths("C:\\out\\", ["users"], "csv")).toEqual(["C:\\out\\users.csv"]);
    expect(bulkExportPaths("/tmp/out", ["users"], "markdown")).toEqual(["/tmp/out/users.md"]);
  });

  it("ファイル名に使えない文字は _ にする", () => {
    expect(bulkExportPaths("/tmp", ['a/b:c"d'], "json")).toEqual(["/tmp/a_b_c_d.json"]);
  });

  it("置き換えや大文字小文字だけの違いで重なる名前には連番を付ける", () => {
    expect(bulkExportPaths("/o", ["a/b", "a_b", "Users", "users", "a_b_2", "a_b"], "csv")).toEqual([
      "/o/a_b.csv",
      "/o/a_b_2.csv",
      "/o/Users.csv",
      "/o/users_2.csv",
      "/o/a_b_2_2.csv",
      "/o/a_b_3.csv",
    ]);
  });
});

describe("abbreviateList", () => {
  it("max を超えた分を rest に数える", () => {
    expect(abbreviateList([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], rest: 0 });
    expect(abbreviateList([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], rest: 2 });
  });
});

describe("buildDropTablesSql", () => {
  it("MySQL / PostgreSQL は 1 文にまとめ、SQLite は 1 テーブル 1 文", () => {
    expect(buildDropTablesSql("mysql", "app", ["a", "b"])).toEqual(["DROP TABLE `app`.`a`, `app`.`b`;"]);
    expect(buildDropTablesSql("postgres", "public", ["a", "B"])).toEqual(['DROP TABLE "public"."a", "public"."B";']);
    expect(buildDropTablesSql("sqlite", "main", ["a", "b"])).toEqual(['DROP TABLE "a";', 'DROP TABLE "b";']);
    expect(buildDropTablesSql("mysql", "app", [])).toEqual([]);
  });
});
