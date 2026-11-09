import { describe, expect, it } from "vitest";
import vectors from "./fixtures/sqliteAttachVectors.json";
import {
  attachAliasProblem,
  attachmentsProblem,
  attachRowProblem,
  cleanAttachments,
  isValidAttachAlias,
  MAX_ATTACHED,
  suggestAttachAlias,
} from "../components/sqliteAttach";
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

describe("共有ゴールデン sqliteAttachVectors.json (#2153)", () => {
  it("上限の件数が Rust の SQLITE_MAX_ATTACHED と一致する", () => {
    expect(MAX_ATTACHED).toBe(vectors.maxAttached);
  });
  it("別名の判定が Rust の is_valid_attach_alias と一致する", () => {
    expect(vectors.aliases.length).toBeGreaterThan(0);
    for (const c of vectors.aliases) expect(isValidAttachAlias(c.alias), c.name).toBe(c.valid);
  });
  it("ATTACH 設定の検証が Rust の attachment_settings_problem と一致する", () => {
    expect(vectors.sets.length).toBeGreaterThan(0);
    for (const c of vectors.sets) expect(attachmentsProblem(c.attachments), c.name).toBe(c.problem);
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

describe("suggestAttachAlias の長さ (#2153)", () => {
  it("70 文字のファイル名でも有効な別名 (64 文字以内) になる", () => {
    const name = suggestAttachAlias(`/d/${"x".repeat(70)}.db`, []);
    expect(isValidAttachAlias(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
  });
  it("接頭辞・接尾辞・連番を付けても 64 文字を超えない", () => {
    for (const len of [58, 60, 61, 62, 63, 64, 65, 100]) {
      const digits = suggestAttachAlias(`/d/${"1".repeat(len)}.db`, []);
      expect(isValidAttachAlias(digits), `数字始まり ${len}`).toBe(true);
      const long = "y".repeat(len);
      const first = suggestAttachAlias(`/d/${long}.db`, []);
      const second = suggestAttachAlias(`/e/${long}.db`, [{ path: "/d", alias: first }]);
      expect(isValidAttachAlias(second), `連番 ${len}`).toBe(true);
      expect(second).not.toBe(first);
      expect(second.length).toBeLessThanOrEqual(64);
    }
  });
  it("61 文字 (接頭辞・接尾辞の余白いっぱい) の語幹はそのまま使う", () => {
    const stem = "z".repeat(61);
    expect(suggestAttachAlias(`/d/${stem}.db`, [])).toBe(stem);
  });
  it("前後に空白のある既存の別名とも重ならない", () => {
    expect(suggestAttachAlias("/d/ext.db", [{ path: "/a", alias: " EXT " }])).toBe("ext_2");
  });
});

describe("attachRowProblem / cleanAttachments (#2153)", () => {
  it("空の別名・パスは、保存を試した後だけ行の問題にする", () => {
    const rows = [{ path: "/a", alias: "" }];
    expect(attachRowProblem(rows, 0, false)).toBeNull();
    expect(attachRowProblem(rows, 0, true)).toBe("aliasRequired");
    const noPath = [{ path: "", alias: "ext" }];
    expect(attachRowProblem(noPath, 0, false)).toBeNull();
    expect(attachRowProblem(noPath, 0, true)).toBe("pathRequired");
  });
  it("形式の誤りと重複は常に返す", () => {
    expect(attachRowProblem([{ path: "/a", alias: "main" }], 0, false)).toBe("invalid");
    const dup = [
      { path: "/a", alias: "x" },
      { path: "/b", alias: "X" },
    ];
    expect(attachRowProblem(dup, 1, false)).toBe("duplicate");
  });
  it("パスも別名も空の行は検証にも保存にも含めない", () => {
    const rows = [
      { path: " /a ", alias: " ext " },
      { path: " ", alias: "" },
    ];
    expect(cleanAttachments(rows)).toEqual([{ path: "/a", alias: "ext" }]);
    expect(attachmentsProblem(cleanAttachments(rows))).toBeNull();
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
