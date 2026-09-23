import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import { cellToJsonNode, resultToJson } from "../components/resultJson";
import { serializeJson } from "../components/jsonTree";
import { MASK_PLACEHOLDER } from "../components/columnMask";

/**
 * 結果パネルの JSON ビュー (#1113) の変換。列順・型の保持・JSON 列の展開・
 * マスク・行数上限を固定する。
 */

const columns: Column[] = [
  { name: "id", type_name: "BIGINT" },
  { name: "doc", type_name: "JSON" },
  { name: "secret", type_name: "VARCHAR" },
];

describe("resultToJson", () => {
  it("列の並び順のまま行オブジェクトの配列にする (64bit 整数の文字列は丸めない)", () => {
    const rows: CellValue[][] = [["9007199254740993", '{"a":[1,2]}', "x"]];
    const { root, shown, total, truncated } = resultToJson(columns, rows);
    expect({ shown, total, truncated }).toEqual({ shown: 1, total: 1, truncated: false });
    expect(serializeJson(root)).toBe(
      '[{"id":"9007199254740993","doc":{"a":[1,2]},"secret":"x"}]',
    );
  });

  it("JSON 列でも壊れた JSON は文字列のまま、非 JSON 列の JSON 風文字列は展開しない", () => {
    expect(cellToJsonNode("{oops", true)).toEqual({ kind: "string", value: "{oops" });
    expect(cellToJsonNode('{"a":1}', false)).toEqual({ kind: "string", value: '{"a":1}' });
  });

  it("NULL / 真偽値 / 数値 / 非有限数を JSON の型で表す", () => {
    expect(cellToJsonNode(null, false)).toEqual({ kind: "null" });
    expect(cellToJsonNode(true, false)).toEqual({ kind: "boolean", value: true });
    expect(cellToJsonNode(1.5, false)).toEqual({ kind: "number", raw: "1.5" });
    expect(cellToJsonNode(Number.NaN, false)).toEqual({ kind: "string", value: "NaN" });
  });

  it("マスク対象の列は常に伏せ字にする", () => {
    const { root } = resultToJson(columns, [[1, null, "p@ss"]], {
      maskedCols: [false, false, true],
    });
    expect(serializeJson(root)).toBe(`[{"id":1,"doc":null,"secret":"${MASK_PLACEHOLDER}"}]`);
  });

  it("行数上限を超えた分は省略し、その旨を返す", () => {
    const rows: CellValue[][] = Array.from({ length: 5 }, (_, i) => [i, null, null]);
    const res = resultToJson(columns, rows, { limit: 3 });
    expect(res).toMatchObject({ shown: 3, total: 5, truncated: true });
    expect(res.root.kind === "array" ? res.root.items.length : -1).toBe(3);
  });
});
