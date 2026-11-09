import { describe, expect, it } from "vitest";
import {
  buildAddEnumValueSql,
  buildRenameEnumValueSql,
  enumValueLiteral,
  ghostInsertIndex,
  parseEnumLabels,
  stepChipIndex,
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

describe("ghostInsertIndex / stepChipIndex (#2158)", () => {
  const vals = ["sad", "ok", "happy"];
  it("差し込み位置は ADD VALUE の BEFORE / AFTER と同じ意味", () => {
    expect(ghostInsertIndex(vals, { kind: "end" })).toBe(3);
    expect(ghostInsertIndex(vals, { kind: "before", reference: "sad" })).toBe(0);
    expect(ghostInsertIndex(vals, { kind: "before", reference: "happy" })).toBe(2);
    expect(ghostInsertIndex(vals, { kind: "after", reference: "sad" })).toBe(1);
    expect(ghostInsertIndex(vals, { kind: "after", reference: "happy" })).toBe(3);
  });

  it("基準値が無い・値が空の型では末尾 / 先頭になる", () => {
    expect(ghostInsertIndex(vals, { kind: "after", reference: "nope" })).toBe(3);
    expect(ghostInsertIndex([], { kind: "end" })).toBe(0);
    expect(ghostInsertIndex([], { kind: "before", reference: "x" })).toBe(0);
  });

  it("矢印キーは端で止まり、Home / End は両端へ、他のキーは対象外", () => {
    expect(stepChipIndex(3, 0, "ArrowRight")).toBe(1);
    expect(stepChipIndex(3, 2, "ArrowRight")).toBe(2);
    expect(stepChipIndex(3, 0, "ArrowLeft")).toBe(0);
    expect(stepChipIndex(3, 1, "ArrowUp")).toBe(0);
    expect(stepChipIndex(3, 1, "ArrowDown")).toBe(2);
    expect(stepChipIndex(3, 1, "Home")).toBe(0);
    expect(stepChipIndex(3, 1, "End")).toBe(2);
    expect(stepChipIndex(3, 1, "a")).toBeNull();
    expect(stepChipIndex(0, 0, "ArrowRight")).toBeNull();
  });
});
