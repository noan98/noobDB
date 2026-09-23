import { describe, expect, it } from "vitest";
import type { IndexInfo, TableColumnInfo } from "../api/tauri";
import {
  indexKind,
  sortIndexes,
  structureColumnRows,
  structureTargetLabel,
} from "../components/tableStructure";

/** テーブル構造ボトムパネル (#1112) の整形ロジック。 */

const col = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: false,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});

const idx = (name: string, over: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  columns: [name],
  unique: false,
  primary: false,
  method: null,
  ...over,
});

describe("structureColumnRows", () => {
  it("位置・キー種別 (PK → FK → UNIQUE)・補足を整形する", () => {
    const rows = structureColumnRows([
      col("id", { key: "PRI", extra: "auto_increment" }),
      col("user_id", { key: "PRI", referenced_table: "users", referenced_column: "id" }),
      col("email", { key: "uni", nullable: true, default: "''", extra: "  " }),
    ]);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ keys: ["pk"], extra: "auto_increment", foreignKey: null });
    expect(rows[1].keys).toEqual(["pk", "fk"]);
    expect(rows[1].foreignKey).toEqual({ column: "user_id", referencedTable: "users", referencedColumn: "id" });
    // 小文字の "uni" も一意として扱い、空白だけの extra は null。
    expect(rows[2]).toMatchObject({ keys: ["unique"], extra: null, nullable: true, defaultValue: "''" });
    expect(rows[0].comment).toBeNull();
  });

  it("列コメント (#1002) は前後の空白を除いて持ち、空なら null", () => {
    const rows = structureColumnRows([col("a", { comment: "  顧客 ID " }), col("b", { comment: "   " })]);
    expect(rows.map((r) => r.comment)).toEqual(["顧客 ID", null]);
  });

  it("空の列一覧は空", () => {
    expect(structureColumnRows([])).toEqual([]);
  });
});

describe("indexKind / sortIndexes", () => {
  it("主キー > 一意 > 通常 で種別を 1 つに決める", () => {
    expect(indexKind(idx("a", { primary: true, unique: true }))).toBe("primary");
    expect(indexKind(idx("b", { unique: true }))).toBe("unique");
    expect(indexKind(idx("c"))).toBe("index");
  });

  it("主キー → 一意 → 通常 の順に並べる (同種内は元の順)", () => {
    const sorted = sortIndexes([
      idx("i1"),
      idx("u1", { unique: true }),
      idx("i2"),
      idx("pk", { primary: true, unique: true }),
      idx("u2", { unique: true }),
    ]);
    expect(sorted.map((i) => i.name)).toEqual(["pk", "u1", "u2", "i1", "i2"]);
  });
});

describe("structureTargetLabel", () => {
  it("db.table 形式で、SQLite と DB 名なしはテーブル名だけ", () => {
    expect(structureTargetLabel("mysql", { database: "app", table: "users" })).toBe("app.users");
    expect(structureTargetLabel("sqlite", { database: "main", table: "users" })).toBe("users");
    expect(structureTargetLabel("postgres", { database: "", table: "users" })).toBe("users");
  });
});
