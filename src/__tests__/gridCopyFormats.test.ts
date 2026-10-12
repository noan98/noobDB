import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import { buildGridCopyText, sliceForCopy } from "../components/gridCopyFormats";
import { MASK_PLACEHOLDER } from "../components/columnMask";

/**
 * 結果グリッドの「CSV / JSON としてコピー」(#1113)。書式はエクスポートと同じで、
 * 対象範囲 (行・列の表示順) とマスク規則 (#1069) を守ることを固定する。
 */

const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
  { name: "email", type_name: "VARCHAR" },
];
const rows: CellValue[][] = [
  [1, "apple", "a@example.com"],
  [2, "ban,ana", null],
  [3, "cherry", "c@example.com"],
];
const noMask = () => false;

describe("gridCopyFormats", () => {
  it("CSV はエクスポートと同じ RFC4180 風 (ヘッダ + \\r\\n、カンマを含む値はクオート)", () => {
    const text = buildGridCopyText("csv", {
      columns,
      rows,
      rowIndices: [1],
      colIndices: [0, 1, 2],
      isMasked: noMask,
      copyPlaceholder: true,
    });
    expect(text).toBe('id,name,email\r\n2,"ban,ana",\r\n');
  });

  it("JSON は行オブジェクトの配列 (NULL は null、数値は数値のまま)", () => {
    const text = buildGridCopyText("json", {
      columns,
      rows,
      rowIndices: [0, 1],
      colIndices: [0, 1, 2],
      isMasked: noMask,
      copyPlaceholder: true,
    });
    expect(JSON.parse(text)).toEqual([
      { id: 1, name: "apple", email: "a@example.com" },
      { id: 2, name: "ban,ana", email: null },
    ]);
  });

  it("行・列は渡した表示順で切り出す (並べ替え後の順序を保つ)", () => {
    const { columns: cols, rows: out } = sliceForCopy({
      columns,
      rows,
      rowIndices: [2, 0],
      colIndices: [1, 0],
      isMasked: noMask,
      copyPlaceholder: true,
    });
    expect(cols.map((c) => c.name)).toEqual(["name", "id"]);
    expect(out).toEqual([
      ["cherry", 3],
      ["apple", 1],
    ]);
  });

  it("マスク中のセルは伏せ字設定なら伏せ字、オフなら実値 (TSV コピーと同じ規則)", () => {
    const isMasked = (_r: number, c: number) => c === 2;
    const masked = sliceForCopy({
      columns,
      rows,
      rowIndices: [0],
      colIndices: [2],
      isMasked,
      copyPlaceholder: true,
    });
    expect(masked.rows).toEqual([[MASK_PLACEHOLDER]]);
    const real = sliceForCopy({
      columns,
      rows,
      rowIndices: [0],
      colIndices: [2],
      isMasked,
      copyPlaceholder: false,
    });
    expect(real.rows).toEqual([["a@example.com"]]);
  });

  it("対象が空なら空文字 (存在しない行・列は読み飛ばす)", () => {
    expect(
      buildGridCopyText("csv", {
        columns,
        rows,
        rowIndices: [99],
        colIndices: [0],
        isMasked: noMask,
        copyPlaceholder: true,
      }),
    ).toBe("");
    expect(
      buildGridCopyText("json", {
        columns,
        rows,
        rowIndices: [0],
        colIndices: [42],
        isMasked: noMask,
        copyPlaceholder: true,
      }),
    ).toBe("");
  });
});

describe("Markdown 表としてコピー (#1541)", () => {
  it("エクスポートと同じ GFM 表 (| をエスケープ、NULL は空欄) で、列の部分集合とマスクに従う", () => {
    const cols: Column[] = [
      { name: "id", type_name: "INT" },
      { name: "memo", type_name: "TEXT" },
      { name: "secret", type_name: "TEXT" },
    ];
    const data: CellValue[][] = [
      [1, "a|b", "s1"],
      [2, null, "s2"],
    ];
    const text = buildGridCopyText("markdown", {
      columns: cols,
      rows: data,
      rowIndices: [0, 1],
      colIndices: [0, 1, 2],
      isMasked: (_r, c) => c === 2,
      copyPlaceholder: true,
    });
    expect(text).toBe(
      `| id | memo | secret |\n| --- | --- | --- |\n| 1 | a\\|b | ${MASK_PLACEHOLDER} |\n| 2 |  | ${MASK_PLACEHOLDER} |\n`,
    );
    expect(
      buildGridCopyText("markdown", {
        columns: cols,
        rows: data,
        rowIndices: [1],
        colIndices: [1, 0],
        isMasked: () => false,
        copyPlaceholder: true,
      }),
    ).toBe("| memo | id |\n| --- | --- |\n|  | 2 |\n");
  });
});
