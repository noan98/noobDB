import { describe, expect, it } from "vitest";
import {
  parseSchemaDragItem,
  schemaDragPlainText,
  schemaDropText,
  serializeSchemaDragItem,
  type SchemaDragItem,
} from "../schemaDragDrop";
import { tableInsertText } from "../schemaInsertText";

const table: SchemaDragItem = { kind: "table", database: "shop", table: "users" };
const column: SchemaDragItem = { kind: "column", database: "shop", table: "users", column: "id" };

describe("シリアライズ", () => {
  it("往復で同じ値に戻る", () => {
    expect(parseSchemaDragItem(serializeSchemaDragItem(table))).toEqual(table);
    expect(parseSchemaDragItem(serializeSchemaDragItem(column))).toEqual(column);
  });
  it("壊れた入力は null", () => {
    expect(parseSchemaDragItem("not json")).toBeNull();
    expect(parseSchemaDragItem("null")).toBeNull();
    expect(parseSchemaDragItem('{"kind":"table"}')).toBeNull();
    expect(parseSchemaDragItem('{"kind":"column","database":"a","table":"b"}')).toBeNull();
    expect(parseSchemaDragItem('{"kind":"x","database":"a","table":"b"}')).toBeNull();
  });
});

describe("schemaDragPlainText", () => {
  it("テーブルは名前、列は table.column", () => {
    expect(schemaDragPlainText(table)).toBe("users");
    expect(schemaDragPlainText(column)).toBe("users.id");
  });
});

describe("tableInsertText", () => {
  it("SQLite は DB 修飾なし、他は db.table", () => {
    expect(tableInsertText("sqlite", "main", "users")).toBe("users");
    expect(tableInsertText("mysql", "shop", "users")).toBe("shop.users");
    expect(tableInsertText("postgres", "public", "Users")).toBe('public."Users"');
  });
});

describe("schemaDropText", () => {
  const base = { driver: "mysql", alt: false, editorBlank: false };
  it("テーブル: 既定は修飾名", () => {
    expect(schemaDropText(table, base)).toBe("shop.users");
  });
  it("テーブル: Alt または空エディタは SELECT 雛形", () => {
    expect(schemaDropText(table, { ...base, alt: true })).toBe("SELECT * FROM `shop`.`users`");
    expect(schemaDropText(table, { ...base, editorBlank: true })).toBe("SELECT * FROM `shop`.`users`");
    expect(schemaDropText(table, { driver: "sqlite", alt: true, editorBlank: false })).toBe(
      'SELECT * FROM "users"',
    );
  });
  it("列: 既定は列名、Alt で修飾名", () => {
    expect(schemaDropText(column, base)).toBe("id");
    expect(schemaDropText(column, { ...base, alt: true })).toBe("users.id");
    expect(schemaDropText({ ...column, column: "Id" }, { ...base, driver: "postgres" })).toBe('"Id"');
  });
});
