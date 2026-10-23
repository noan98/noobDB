import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import { buildGridCopyInsert, buildGridCopyText } from "../components/gridCopyFormats";
import vectors from "./fixtures/gridCopyVectors.json";

// 結果グリッド選択範囲のコピー書式 (CSV / JSON / Markdown / INSERT) のゴールデン (#1585)。
// 期待値は `fixtures/gridCopyVectors.json`。境界ケースはその JSON に追記する。

interface Case {
  name: string;
  columns: Column[];
  rows: CellValue[][];
  rowIndices: number[];
  colIndices: number[];
  expected: {
    csv: string;
    json: string;
    markdown: string;
    insert: Record<string, string>;
    insertCombined: Record<string, string>;
  };
}

const noMask = () => false;

describe("gridCopyGolden", () => {
  for (const c of vectors.cases as Case[]) {
    describe(c.name, () => {
      const base = {
        columns: c.columns,
        rows: c.rows,
        rowIndices: c.rowIndices,
        colIndices: c.colIndices,
        isMasked: noMask,
        copyPlaceholder: false,
      };
      for (const f of ["csv", "json", "markdown"] as const) {
        it(f, () => {
          expect(buildGridCopyText(f, base)).toBe(c.expected[f]);
        });
      }
      for (const driver of vectors.drivers) {
        it(`insert (${driver})`, () => {
          const r = buildGridCopyInsert({
            ...base,
            driver,
            database: "shop",
            table: "items",
            combineValues: false,
          });
          expect(r.sql).toBe(c.expected.insert[driver]);
          expect(r.tableResolved).toBe(true);
        });
        it(`insert combined (${driver})`, () => {
          const r = buildGridCopyInsert({
            ...base,
            driver,
            database: "shop",
            table: "items",
            combineValues: true,
          });
          expect(r.sql).toBe(c.expected.insertCombined[driver]);
        });
      }
    });
  }

  it("テーブル未解決ならプレースホルダ名で出し、tableResolved=false を返す", () => {
    const c = (vectors.cases as Case[])[0];
    const r = buildGridCopyInsert({
      columns: c.columns,
      rows: c.rows,
      rowIndices: [0],
      colIndices: c.colIndices,
      isMasked: noMask,
      driver: "sqlite",
      database: "",
      table: null,
      combineValues: false,
    });
    expect(r.tableResolved).toBe(false);
    expect(r.sql).toContain('INSERT INTO "exported_table"');
  });
});
