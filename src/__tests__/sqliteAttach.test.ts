import { describe, expect, it } from "vitest";
import { isValidAttachAlias, suggestAttachAlias } from "../components/sqliteAttach";
import { qualifiedTableRef } from "../components/cellEdit";

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

describe("qualifiedTableRef (SQLite の別名)", () => {
  it("main は修飾せず、アタッチした別名は修飾する", () => {
    expect(qualifiedTableRef("sqlite", "main", "t")).toBe('"t"');
    expect(qualifiedTableRef("sqlite", "ext", "t")).toBe('"ext"."t"');
  });
});
