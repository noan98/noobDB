import { describe, expect, it } from "vitest";
import type { CellValue, StreamStatsSnapshot } from "../api/tauri";
import { attachStreamStats, numericStatsFromStream, streamStatsFor } from "../components/streamStats";
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
    duplicateRows: hasAmbiguousIdentity(rows, Array.from({ length: w }, (_, i) => i)),
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
