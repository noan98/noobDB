import { describe, expect, it } from "vitest";
import type { TableColumnInfo } from "../api/tauri";
import {
  columnCommentsFor,
  normalizeComment,
  tableCommentMap,
  withComment,
} from "../components/schemaComment";

function col(name: string, comment?: string | null): TableColumnInfo {
  return {
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
    comment,
  };
}

describe("schemaComment (#1002)", () => {
  it("normalizeComment は空白のみ / null / undefined を null にする", () => {
    expect(normalizeComment(undefined)).toBeNull();
    expect(normalizeComment(null)).toBeNull();
    expect(normalizeComment("   ")).toBeNull();
    expect(normalizeComment(" 会員 ")).toBe(" 会員 ");
  });

  it("withComment はコメントがあるときだけ改行で添える", () => {
    expect(withComment("int", "数量")).toBe("int\n数量");
    expect(withComment("int", "")).toBe("int");
    expect(withComment("int", null)).toBe("int");
  });

  it("tableCommentMap は空コメントを落とす", () => {
    expect(
      tableCommentMap([
        { name: "a", comment: "A" },
        { name: "b", comment: " " },
      ]),
    ).toEqual({ a: "A" });
  });

  it("columnCommentsFor は結果列の順に並べ、メタ無し・旧バックエンド (comment 欠落) は null", () => {
    expect(columnCommentsFor(["b", "x", "a"], [col("a", "A"), col("b", "B")])).toEqual(["B", null, "A"]);
    expect(columnCommentsFor(["a"], [col("a")])).toEqual([null]);
    expect(columnCommentsFor(["a"], null)).toEqual([null]);
  });
});
