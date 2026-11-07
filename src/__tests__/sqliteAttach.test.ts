import { describe, expect, it } from "vitest";
import { attachAliasProblem, isValidAttachAlias, suggestAttachAlias } from "../components/sqliteAttach";
import { qualifiedTableName } from "../components/sqlDialect";
import {
  buildCreateIndexSql,
  buildDropIndexSql,
  buildDropTableSql,
  buildRenameTableSql,
  buildTruncateSql,
} from "../components/tableMaintenance";

describe("isValidAttachAlias", () => {
  it("英数字と _ だけを許し、main / temp と数字始まりは拒否する", () => {
    expect(isValidAttachAlias("ext_1")).toBe(true);
    expect(isValidAttachAlias("_x")).toBe(true);
    expect(isValidAttachAlias("")).toBe(false);
    expect(isValidAttachAlias("1a")).toBe(false);
    expect(isValidAttachAlias("a b")).toBe(false);
    expect(isValidAttachAlias('a"b')).toBe(false);
    expect(isValidAttachAlias("Main")).toBe(false);
    expect(isValidAttachAlias("TEMP")).toBe(false);
    expect(isValidAttachAlias("a".repeat(65))).toBe(false);
  });
});

describe("suggestAttachAlias", () => {
  it("ファイル名から別名を作り、重複は連番にする", () => {
    expect(suggestAttachAlias("/data/archive.sqlite", [])).toBe("archive");
    expect(suggestAttachAlias("C:\\x\\my-db.v2.db", [])).toBe("my_db_v2");
    expect(suggestAttachAlias("/d/archive.db", [{ path: "/a", alias: "Archive" }])).toBe("archive_2");
  });
  it("予約名・数字始まり・空は有効な別名に直す", () => {
    expect(suggestAttachAlias("/d/main.db", [])).toBe("main_db");
    expect(suggestAttachAlias("/d/2024.db", [])).toBe("db_2024");
    expect(isValidAttachAlias(suggestAttachAlias("/d/.db", []))).toBe(true);
  });
});

describe("qualifiedTableName (SQLite の別名)", () => {
  it("main は修飾せず、アタッチした別名は修飾する", () => {
    expect(qualifiedTableName("sqlite", "main", "t")).toBe('"t"');
    expect(qualifiedTableName("sqlite", "ext", "t")).toBe('"ext"."t"');
  });
  it("空・null・大文字小文字違いの main は修飾しない", () => {
    expect(qualifiedTableName("sqlite", "", "t")).toBe('"t"');
    expect(qualifiedTableName("sqlite", null, "t")).toBe('"t"');
    expect(qualifiedTableName("sqlite", "MAIN", "t")).toBe('"t"');
  });
  it("MySQL / PostgreSQL の挙動は変わらない", () => {
    expect(qualifiedTableName("mysql", "db", "t")).toBe("`db`.`t`");
    expect(qualifiedTableName("postgres", "public", "t")).toBe('"public"."t"');
    expect(qualifiedTableName("mysql", "", "t")).toBe("`t`");
  });
});

describe("別名側の保守系 SQL (SQLite)", () => {
  it("DROP / TRUNCATE / RENAME は別名で修飾する", () => {
    expect(buildDropTableSql("sqlite", "ext", "t")).toBe('DROP TABLE "ext"."t";');
    expect(buildTruncateSql("sqlite", "ext", "t")).toBe('DELETE FROM "ext"."t";');
    expect(buildDropTableSql("sqlite", "main", "t")).toBe('DROP TABLE "t";');
    expect(buildRenameTableSql("sqlite", "ext", "t", "u")).toBe('ALTER TABLE "ext"."t" RENAME TO "u";');
  });
  it("索引は名前側にスキーマを付け、ON の表は修飾しない", () => {
    expect(buildCreateIndexSql("sqlite", "ext", "t", ["a"], { name: "ix" })).toBe(
      'CREATE INDEX "ext"."ix" ON "t" ("a");',
    );
    expect(buildCreateIndexSql("sqlite", "main", "t", ["a"], { name: "ix" })).toBe(
      'CREATE INDEX "ix" ON "t" ("a");',
    );
    expect(buildDropIndexSql("sqlite", "ext", "t", "ix")).toBe('DROP INDEX "ext"."ix";');
    expect(buildDropIndexSql("sqlite", "main", "t", "ix")).toBe('DROP INDEX "ix";');
  });
});

describe("attachAliasProblem", () => {
  const rows = [
    { path: "/a", alias: "ext" },
    { path: "/b", alias: "EXT" },
    { path: "/c", alias: "1x" },
    { path: "/d", alias: "" },
    { path: "/e", alias: " ok " },
  ];
  it("不正な形式と重複 (大文字小文字を除く) を返し、空は問題にしない", () => {
    expect(attachAliasProblem(rows, 0)).toBeNull();
    expect(attachAliasProblem(rows, 1)).toBe("duplicate");
    expect(attachAliasProblem(rows, 2)).toBe("invalid");
    expect(attachAliasProblem(rows, 3)).toBeNull();
    expect(attachAliasProblem(rows, 4)).toBeNull();
  });
});
