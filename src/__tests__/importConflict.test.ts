import { describe, it, expect } from "vitest";
import {
  defaultKeyColumns,
  pruneKeyColumns,
  toggleKeyColumn,
  validateConflictKeys,
} from "../components/importConflict";

/**
 * インポートの競合モード (UPSERT, #972) の UI 側純ロジック。検証規則は
 * バックエンドの `ImportConflict::validate` (db/upsert.rs) と同じであること。
 */
describe("importConflict (#972)", () => {
  const table = [
    { name: "id", key: "PRI" },
    { name: "tenant", key: "PRI" },
    { name: "name", key: "" },
  ];

  it("defaults the key to the mapped primary-key columns in table order", () => {
    expect(defaultKeyColumns(table, ["name", "tenant", "id"])).toEqual(["id", "tenant"]);
    // 主キーをマッピングしていなければ既定キーは空 (ユーザに選ばせる)。
    expect(defaultKeyColumns(table, ["name"])).toEqual([]);
  });

  it("drops key columns that are no longer mapped", () => {
    expect(pruneKeyColumns(["id", "name"], ["name"])).toEqual(["name"]);
  });

  it("toggles a key column and keeps the mapped-column order", () => {
    const mapped = ["id", "tenant", "name"];
    expect(toggleKeyColumn(["name"], "id", mapped)).toEqual(["id", "name"]);
    expect(toggleKeyColumn(["id", "name"], "id", mapped)).toEqual(["name"]);
  });

  it("validates like the backend", () => {
    expect(validateConflictKeys("insert", [], [])).toBeNull();
    expect(validateConflictKeys("update", [], ["id"])).toBe("keysRequired");
    expect(validateConflictKeys("skip", ["x"], ["id"])).toBe("keyNotMapped");
    expect(validateConflictKeys("update", ["id"], ["id", "name"])).toBeNull();
  });
});
