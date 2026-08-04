import { describe, expect, it } from "vitest";
import { MAX_LOCAL_TABLE_ROWS, suggestLocalTableName } from "../components/localQuery";

describe("suggestLocalTableName", () => {
  it("suggests r1 when there are no existing tables", () => {
    expect(suggestLocalTableName([])).toBe("r1");
  });

  it("skips names already taken (case-insensitively)", () => {
    expect(suggestLocalTableName(["r1"])).toBe("r2");
    expect(suggestLocalTableName(["R1", "r2"])).toBe("r3");
  });

  it("finds the first gap rather than always appending", () => {
    expect(suggestLocalTableName(["r1", "r3"])).toBe("r2");
  });

  it("ignores unrelated table names", () => {
    expect(suggestLocalTableName(["orders_prod", "customers"])).toBe("r1");
  });
});

describe("MAX_LOCAL_TABLE_ROWS", () => {
  it("mirrors the backend cap (src-tauri/src/commands/local.rs)", () => {
    // 実際の強制はバックエンドが担う (このフロント側の値はガイド表示・早期
    // ガード用)。値がズレると誤解を招くヒントになるため、想定値を固定しておく。
    expect(MAX_LOCAL_TABLE_ROWS).toBe(200_000);
  });
});
