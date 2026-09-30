import { describe, expect, it } from "vitest";
import type { CellValue } from "../api/tauri";
import {
  buildHandleRequest,
  columnFilterPasses,
  compareBoolCells,
  compareNumericCells,
  compareStringCells,
  globalCellIncludes,
  isIdentityRequest,
  type ColumnFilter,
  type HandleSortKind,
} from "../components/gridSortFilter";
import { computeFindMatches } from "../components/gridFind";
import { columnStats } from "../components/gridStats";
import type { CellKind } from "../components/cellTypeMeta";
import vectors from "./fixtures/resultOpsVectors.json";

// 結果ハンドル (#1264) のソート・フィルタ・検索・列統計のフロント↔バック共有ゴールデン
// — フロント側。`ResultGrid.tsx` / `gridFind.ts` / `gridStats.ts` の JS 実装 (= 判定の
// 正) が共有ベクタ (`fixtures/resultOpsVectors.json`) の期待値と一致することを固定する。
// バック側は同じ JSON を `src-tauri/tests/result_ops_golden.rs` が `include_str!` で読み、
// `db/result_ops.rs` (結果ハンドル経由の実装) で突き合わせる。
//
// 期待値は JS 実装が出した値。既知の差 (`Intl.Collator` の照合順序) は、両実装が一致する
// 範囲 (ASCII・数字列・Latin-1 のアクセント・かな) だけをベクタに含めている。

interface SortFilterCase {
  name: string;
  kinds: CellKind[];
  rows: CellValue[][];
  sort?: { col: number; desc: boolean }[];
  filters?: { col: number; op: ColumnFilter["op"]; value: string; value2: string; nullMode: ColumnFilter["nullMode"] }[];
  global?: string;
  expected: number[];
}

interface FindCase {
  name: string;
  rows: CellValue[][];
  columnCount: number;
  query: string;
  options: { caseSensitive: boolean; wholeCell: boolean };
  limit: number;
  expected: { hits: { rowIdx: number; colIdx: number }[]; total: number; truncated: boolean };
}

/** TanStack Table と同じ順序 (フィルタ → 複数キーのソート、同値は元の行順) を JS の判定関数で再現する。 */
function applyJs(c: SortFilterCase): number[] {
  const sorting = (c.sort ?? []).map((s) => ({ id: String(s.col), desc: s.desc }));
  const filters = (c.filters ?? []).map((f) => ({
    id: String(f.col),
    value: { op: f.op, value: f.value, value2: f.value2, nullMode: f.nullMode } as ColumnFilter,
  }));
  const req = buildHandleRequest(sorting, filters, c.global, c.kinds);
  const needle = (c.global ?? "").toLowerCase();
  let idx = c.rows.map((_, i) => i).filter((i) => {
    for (const f of filters) {
      if (!columnFilterPasses(c.rows[i][Number(f.id)] ?? null, f.value)) return false;
    }
    if (req.global !== "") {
      let any = false;
      for (let k = 0; k < c.kinds.length; k++) {
        if (globalCellIncludes(c.rows[i][k] ?? null, needle)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    return true;
  });
  const cmp = (kind: HandleSortKind) =>
    kind === "numeric" ? compareNumericCells : kind === "bool" ? compareBoolCells : compareStringCells;
  idx = idx.sort((a, b) => {
    for (const s of req.sort) {
      let r = cmp(s.kind)(c.rows[a][s.col] ?? null, c.rows[b][s.col] ?? null);
      if (s.desc) r *= -1;
      if (r !== 0) return r;
    }
    return a - b;
  });
  return idx;
}

describe("結果ハンドル共有ゴールデン: ソート・フィルタ", () => {
  for (const c of vectors.sortFilter as unknown as SortFilterCase[]) {
    it(c.name, () => {
      expect(applyJs(c)).toEqual(c.expected);
    });
  }
});

describe("結果ハンドル共有ゴールデン: 結果内検索", () => {
  for (const c of vectors.find as unknown as FindCase[]) {
    it(c.name, () => {
      const res = computeFindMatches(c.rows, c.columnCount, c.query, { ...c.options, regex: false });
      const total = res.matches.length;
      expect({
        hits: res.matches.slice(0, c.limit).map((m) => ({ rowIdx: m.rowIdx, colIdx: m.colIdx })),
        total,
        truncated: total > c.limit,
      }).toEqual(c.expected);
    });
  }
});

describe("結果ハンドル共有ゴールデン: 列統計", () => {
  for (const c of vectors.columnStats as unknown as {
    name: string;
    rows: CellValue[][];
    col: number;
    expected: ReturnType<typeof columnStats>;
  }[]) {
    it(c.name, () => {
      const st = columnStats(c.rows.map((r) => r[c.col] ?? null), "string");
      expect(st).toEqual(c.expected);
    });
  }
});

describe("buildHandleRequest", () => {
  const kinds: CellKind[] = ["number", "bool", "string"];

  it("ソートキーの比較方式を列の種別から決める", () => {
    const req = buildHandleRequest(
      [
        { id: "0", desc: true },
        { id: "1", desc: false },
        { id: "2", desc: false },
      ],
      [],
      undefined,
      kinds,
    );
    expect(req.sort.map((s) => s.kind)).toEqual(["numeric", "bool", "string"]);
    expect(req.sort[0].desc).toBe(true);
  });

  it("非アクティブなフィルタと範囲外の列は落とす", () => {
    const active: ColumnFilter = { op: "contains", value: "x", value2: "", nullMode: "any" };
    const inactive: ColumnFilter = { op: "contains", value: "  ", value2: "", nullMode: "any" };
    const req = buildHandleRequest(
      [{ id: "9", desc: false }],
      [
        { id: "0", value: active },
        { id: "1", value: inactive },
        { id: "7", value: active },
      ],
      "",
      kinds,
    );
    expect(req.sort).toEqual([]);
    expect(req.filters).toHaveLength(1);
    expect(req.filters[0].col).toBe(0);
  });

  it("条件が空なら identity", () => {
    expect(isIdentityRequest(buildHandleRequest([], [], "", kinds))).toBe(true);
    expect(isIdentityRequest(buildHandleRequest([], [], "a", kinds))).toBe(false);
  });
});
