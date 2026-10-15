import { describe, expect, it } from "vitest";
import { resolveCsvDropTarget } from "../dropImport";

describe("CSV ドロップの取り込み先 (#1623)", () => {
  it("アクティブなテーブルタブがあればそのテーブルへ取り込む", () => {
    expect(resolveCsvDropTarget(true, { kind: "table", database: "shop", table: "users" })).toEqual({
      kind: "table",
      database: "shop",
      table: "users",
    });
  });

  it("テーブルタブでなくてもデータベースが決まっていれば新規テーブルとして取り込む", () => {
    expect(resolveCsvDropTarget(true, { kind: "query", database: "shop" })).toEqual({
      kind: "newTable",
      database: "shop",
    });
    // テーブル名の無いテーブルタブ (壊れた状態) も同様にデータベースへ。
    expect(resolveCsvDropTarget(true, { kind: "table", database: "shop", table: null })).toEqual({
      kind: "newTable",
      database: "shop",
    });
  });

  it("未接続・タブなし・データベース不明のときは取り込み先なし", () => {
    expect(resolveCsvDropTarget(false, { kind: "table", database: "shop", table: "users" })).toEqual({
      kind: "none",
    });
    expect(resolveCsvDropTarget(true, null)).toEqual({ kind: "none" });
    expect(resolveCsvDropTarget(true, { kind: "query" })).toEqual({ kind: "none" });
    expect(resolveCsvDropTarget(true, { kind: "query", database: "" })).toEqual({ kind: "none" });
  });
});
