import { describe, expect, it } from "vitest";
import type { CellValue, StreamStatsSnapshot } from "../api/tauri";
import {
  attachStreamStats,
  distinctHintFor,
  numericStatsFromStream,
  streamStatsFor,
} from "../components/streamStats";
import { columnNullRates, nullRatesFromCounts } from "../components/gridStats";
import { computeNumericStats } from "../components/cellConditionalFormat";
import { hasAmbiguousIdentity } from "../components/cellEdit";

function statsOf(rows: CellValue[][]): StreamStatsSnapshot {
  // バックエンド (db/stream_batch.rs) の逐次統計を JS で再現したもの。
  const w = rows[0]?.length ?? 0;
  const nullCounts = new Array<number>(w).fill(0);
  const cols = Array.from({ length: w }, (_, i) => computeNumericStats(rows.map((r) => r[i])));
  for (const r of rows) r.forEach((v, i) => (v === null ? nullCounts[i]++ : 0));
  return {
    rowCount: rows.length,
    nullCounts,
    numMin: cols.map((c) => c?.min ?? null),
    numMax: cols.map((c) => c?.max ?? null),
    duplicateRows: hasAmbiguousIdentity(
      rows,
      Array.from({ length: w }, (_, i) => i),
    ),
  };
}

describe("streamStats レジストリ (#1257)", () => {
  const rows: CellValue[][] = [
    [1, "a", null],
    [3, "b", "2.5"],
  ];

  it("行配列の同一性に紐づき、別配列に置き換わると外れる", () => {
    attachStreamStats(rows, statsOf(rows));
    expect(streamStatsFor(rows)?.rowCount).toBe(2);
    // セル編集の適用などで行配列が入れ替わると統計は見えない。
    expect(streamStatsFor(rows.map((r) => [...r]))).toBeNull();
    expect(streamStatsFor(null)).toBeNull();
    expect(streamStatsFor(undefined)).toBeNull();
  });

  it("行数が食い違う統計 (古いバッチ) は採用しない", () => {
    const grown = [...rows, [5, "c", null]] as CellValue[][];
    attachStreamStats(grown, { ...statsOf(rows) });
    expect(streamStatsFor(grown)).toBeNull();
  });

  it("null / undefined の統計は登録しない", () => {
    const r: CellValue[][] = [[1]];
    attachStreamStats(r, null);
    attachStreamStats(r, undefined);
    expect(streamStatsFor(r)).toBeNull();
  });

  it("numericStatsFromStream: min/max が揃うときだけ返す", () => {
    const s = statsOf(rows);
    expect(numericStatsFromStream(s, 0)).toEqual({ min: 1, max: 3 });
    expect(numericStatsFromStream(s, 1)).toBeNull();
    expect(numericStatsFromStream(s, 2)).toEqual({ min: 2.5, max: 2.5 });
    expect(numericStatsFromStream(s, 9)).toBeNull();
  });

  it("NULL 率はストリーム統計から JS の全行走査と同じ値になる", () => {
    const s = statsOf(rows);
    expect(nullRatesFromCounts(s.nullCounts, rows.length, 3)).toEqual(columnNullRates(rows, 3));
  });

  it("重複行フラグは hasAmbiguousIdentity (全列) と一致する", () => {
    expect(statsOf(rows).duplicateRows).toBe(false);
    expect(statsOf([...rows, [1, "a", null]]).duplicateRows).toBe(true);
  });
});

describe("distinctHintFor (#1628)", () => {
  const snap = (
    rowCount: number,
    nullCounts: number[],
    distinctEstimates?: number[],
  ): StreamStatsSnapshot => ({
    rowCount,
    nullCounts,
    numMin: nullCounts.map(() => null),
    numMax: nullCounts.map(() => null),
    duplicateRows: false,
    distinctEstimates,
  });

  it("ほぼ全行が異なり NULL が無い列は候補キー", () => {
    expect(distinctHintFor(snap(1000, [0], [990]), 1000, 0)).toEqual({ estimate: 990, kind: "candidateKey" });
  });
  it("NULL を含む列や、重複の多い列は候補キーにしない", () => {
    expect(distinctHintFor(snap(1000, [5], [995]), 1000, 0)?.kind).toBeNull();
    expect(distinctHintFor(snap(1000, [0], [800]), 1000, 0)?.kind).toBeNull();
  });
  it("1 種類だけなら定数列、行数が十分で 10 種類以下なら低カーディナリティ", () => {
    expect(distinctHintFor(snap(50, [0], [1]), 50, 0)?.kind).toBe("constant");
    expect(distinctHintFor(snap(500, [0], [4]), 500, 0)?.kind).toBe("lowCardinality");
    expect(distinctHintFor(snap(20, [0], [4]), 20, 0)?.kind).toBeNull();
  });
  it("少ない行数では候補キーと断定しない", () => {
    expect(distinctHintFor(snap(5, [0], [5]), 5, 0)?.kind).toBeNull();
  });
  it("推定が無い・全て NULL の列は null", () => {
    expect(distinctHintFor(snap(100, [0]), 100, 0)).toBeNull();
    expect(distinctHintFor(snap(100, [100], [0]), 100, 0)).toBeNull();
    expect(distinctHintFor(snap(100, [0], [50]), 100, 3)).toBeNull();
  });
});
