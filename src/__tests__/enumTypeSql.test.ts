import { describe, expect, it } from "vitest";
import {
  buildAddEnumValueSql,
  buildRenameEnumValueSql,
  enumValueLiteral,
  parseEnumLabels,
  validateEnumValue,
} from "../components/enumTypeSql";

// PostgreSQL の ENUM 型への値の追加 / 名前の変更 (#2127)。リテラルのエスケープと検証を固定する。

describe("parseEnumLabels", () => {
  it("object_definition の CREATE TYPE から値の並びを読む", () => {
    expect(parseEnumLabels(`CREATE TYPE "public"."mood" AS ENUM ('sad', 'ok', 'happy');`)).toEqual([
      "sad",
      "ok",
      "happy",
    ]);
  });

  it("引用符の二重化・E'' のバックスラッシュ・カンマ入りの値を戻す", () => {
    expect(parseEnumLabels(`CREATE TYPE "p"."m" AS ENUM ('it''s', E'a\\\\b', 'x, y', '');`)).toEqual([
      "it's",
      "a\\b",
      "x, y",
      "",
    ]);
  });

  it("値が無い ENUM は空配列、ENUM 以外や壊れた定義は null", () => {
    expect(parseEnumLabels(`CREATE TYPE "p"."m" AS ENUM ();`)).toEqual([]);
    expect(parseEnumLabels(`CREATE DOMAIN "p"."d" AS integer;`)).toBeNull();
    expect(parseEnumLabels(`CREATE TYPE "p"."m" AS ENUM ('a`)).toBeNull();
  });
});

describe("buildAddEnumValueSql", () => {
  it("末尾 / BEFORE / AFTER を出し分ける", () => {
    expect(buildAddEnumValueSql("public", "mood", "meh", { kind: "end" })).toBe(
      `ALTER TYPE "public"."mood" ADD VALUE 'meh';`,
    );
    expect(buildAddEnumValueSql("public", "mood", "meh", { kind: "before", reference: "ok" })).toBe(
      `ALTER TYPE "public"."mood" ADD VALUE 'meh' BEFORE 'ok';`,
    );
    expect(buildAddEnumValueSql("public", "mood", "meh", { kind: "after", reference: "it's" })).toBe(
      `ALTER TYPE "public"."mood" ADD VALUE 'meh' AFTER 'it''s';`,
    );
  });

  it("スキーマ名・型名の引用符とインジェクション試行を中和する", () => {
    const sql = buildAddEnumValueSql('we"ird', 'ty"pe', "x'); DROP TABLE t; --", { kind: "end" });
    expect(sql).toBe(`ALTER TYPE "we""ird"."ty""pe" ADD VALUE 'x''); DROP TABLE t; --';`);
  });
});

describe("buildRenameEnumValueSql / enumValueLiteral", () => {
  it("RENAME VALUE を出す", () => {
    expect(buildRenameEnumValueSql("public", "mood", "ok", "fine")).toBe(
      `ALTER TYPE "public"."mood" RENAME VALUE 'ok' TO 'fine';`,
    );
  });

  it("バックスラッシュを含む値は E'' で渡す", () => {
    expect(enumValueLiteral("a\\b")).toBe("E'a\\\\b'");
    expect(enumValueLiteral("a'b")).toBe("'a''b'");
  });
});

describe("validateEnumValue", () => {
  it("空・重複・63 バイト超を弾く", () => {
    expect(validateEnumValue("", ["a"])).toBe("empty");
    expect(validateEnumValue("a", ["a"])).toBe("duplicate");
    expect(validateEnumValue("b", ["a"])).toBeNull();
    expect(validateEnumValue("x".repeat(63), [])).toBeNull();
    expect(validateEnumValue("x".repeat(64), [])).toBe("tooLong");
    // 3 バイト文字 21 個 = 63 バイトは可、22 個は不可。
    expect(validateEnumValue("あ".repeat(21), [])).toBeNull();
    expect(validateEnumValue("あ".repeat(22), [])).toBe("tooLong");
  });
});
