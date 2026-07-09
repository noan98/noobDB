import { describe, expect, it } from "vitest";
import {
  EMPTY_FIND_RESULT,
  buildFindKeySet,
  computeFindMatches,
  findMatchKey,
  nextMatchIndex,
  stableMatchIndex,
  type GridFindMatch,
  type GridFindOptions,
} from "../components/gridFind";
import type { CellValue } from "../api/tauri";

// 結果内検索 (#644) の純ロジックの境界ケースを固定するテスト。
// 空クエリ / 不正な正規表現 / 大小区別 / 完全一致 / NULL セル / 0 件 /
// wrap-around / ストリーミング再計算時の現在ヒット維持を網羅する。

const OPTS: GridFindOptions = { caseSensitive: false, wholeCell: false, regex: false };

const ROWS: CellValue[][] = [
  ["Apple", 10, null],
  ["banana", 20, "apple pie"],
  [null, 30, "Cherry"],
];

describe("computeFindMatches", () => {
  it("空クエリはヒット 0 件 (invalidRegex も立たない)", () => {
    const r = computeFindMatches(ROWS, 3, "", OPTS);
    expect(r.matches).toEqual([]);
    expect(r.invalidRegex).toBe(false);
    // 参照安定な EMPTY_FIND_RESULT を返す (useEffect の依存で無駄に発火しない)。
    expect(r).toBe(EMPTY_FIND_RESULT);
  });

  it("行が無い / 列数 0 でもヒット 0 件", () => {
    expect(computeFindMatches([], 3, "a", OPTS).matches).toEqual([]);
    expect(computeFindMatches(ROWS, 0, "a", OPTS).matches).toEqual([]);
  });

  it("既定は大小無視の部分一致で、行優先の出現順に並ぶ", () => {
    const r = computeFindMatches(ROWS, 3, "apple", OPTS);
    expect(r.matches).toEqual([
      { rowIdx: 0, colIdx: 0 },
      { rowIdx: 1, colIdx: 2 },
    ]);
  });

  it("caseSensitive で大文字小文字を区別する", () => {
    const r = computeFindMatches(ROWS, 3, "apple", { ...OPTS, caseSensitive: true });
    expect(r.matches).toEqual([{ rowIdx: 1, colIdx: 2 }]);
    const r2 = computeFindMatches(ROWS, 3, "Apple", { ...OPTS, caseSensitive: true });
    expect(r2.matches).toEqual([{ rowIdx: 0, colIdx: 0 }]);
  });

  it("wholeCell はセル値全体との完全一致のみをヒットとする", () => {
    const r = computeFindMatches(ROWS, 3, "apple", { ...OPTS, wholeCell: true });
    // "apple pie" は部分一致だが完全一致ではない。"Apple" は大小無視で一致。
    expect(r.matches).toEqual([{ rowIdx: 0, colIdx: 0 }]);
    const cs = computeFindMatches(ROWS, 3, "apple", {
      ...OPTS,
      wholeCell: true,
      caseSensitive: true,
    });
    expect(cs.matches).toEqual([]);
  });

  it("NULL セルはヒットしない (String 化して 'null' を探さない)", () => {
    const r = computeFindMatches(ROWS, 3, "null", OPTS);
    expect(r.matches).toEqual([]);
  });

  it("数値・真偽値セルは実値の文字列表現で一致する", () => {
    const rows: CellValue[][] = [[123, true]];
    expect(computeFindMatches(rows, 2, "23", OPTS).matches).toEqual([
      { rowIdx: 0, colIdx: 0 },
    ]);
    expect(computeFindMatches(rows, 2, "true", OPTS).matches).toEqual([
      { rowIdx: 0, colIdx: 1 },
    ]);
  });

  it("正規表現モードでパターン一致する", () => {
    const r = computeFindMatches(ROWS, 3, "^ba.+na$", { ...OPTS, regex: true });
    expect(r.matches).toEqual([{ rowIdx: 1, colIdx: 0 }]);
    // 大小無視フラグも効く。
    const ci = computeFindMatches(ROWS, 3, "^apple", { ...OPTS, regex: true });
    expect(ci.matches).toEqual([
      { rowIdx: 0, colIdx: 0 },
      { rowIdx: 1, colIdx: 2 },
    ]);
  });

  it("regex + wholeCell はセル全体への完全一致になる", () => {
    const r = computeFindMatches(ROWS, 3, "apple", {
      ...OPTS,
      regex: true,
      wholeCell: true,
    });
    // "apple pie" は ^(?:apple)$ に一致しない。
    expect(r.matches).toEqual([{ rowIdx: 0, colIdx: 0 }]);
  });

  it("不正な正規表現は invalidRegex を立ててヒット 0 件", () => {
    const r = computeFindMatches(ROWS, 3, "([", { ...OPTS, regex: true });
    expect(r.matches).toEqual([]);
    expect(r.invalidRegex).toBe(true);
  });

  it("ヒットしないクエリは 0 件 (invalidRegex は立たない)", () => {
    const r = computeFindMatches(ROWS, 3, "zzz", OPTS);
    expect(r.matches).toEqual([]);
    expect(r.invalidRegex).toBe(false);
  });

  it("columnCount を超える列は走査しない", () => {
    const r = computeFindMatches(ROWS, 2, "apple", OPTS);
    // 3 列目の "apple pie" は対象外。
    expect(r.matches).toEqual([{ rowIdx: 0, colIdx: 0 }]);
  });
});

describe("nextMatchIndex", () => {
  it("0 件なら null", () => {
    expect(nextMatchIndex(0, null, 1)).toBeNull();
    expect(nextMatchIndex(0, 2, -1)).toBeNull();
  });

  it("現在位置なしは先頭 (次) / 末尾 (前) から始まる", () => {
    expect(nextMatchIndex(3, null, 1)).toBe(0);
    expect(nextMatchIndex(3, null, -1)).toBe(2);
  });

  it("前後に進み、端で wrap-around する", () => {
    expect(nextMatchIndex(3, 0, 1)).toBe(1);
    expect(nextMatchIndex(3, 2, 1)).toBe(0); // 末尾 → 先頭
    expect(nextMatchIndex(3, 0, -1)).toBe(2); // 先頭 → 末尾
    expect(nextMatchIndex(1, 0, 1)).toBe(0); // 1 件は自分に戻る
  });
});

describe("stableMatchIndex", () => {
  const matches: GridFindMatch[] = [
    { rowIdx: 0, colIdx: 0 },
    { rowIdx: 1, colIdx: 2 },
    { rowIdx: 5, colIdx: 1 },
  ];

  it("0 件なら null", () => {
    expect(stableMatchIndex([], { rowIdx: 0, colIdx: 0 }, 0)).toBeNull();
  });

  it("直前の現在ヒットと同じセルが残っていればそのインデックスを返す (ストリーミングで行が増えた場合)", () => {
    expect(stableMatchIndex(matches, { rowIdx: 1, colIdx: 2 }, 0)).toBe(1);
    // 先頭に新ヒットが挿入されてインデックスがずれても同じセルを指し続ける。
    const grown: GridFindMatch[] = [{ rowIdx: 0, colIdx: 1 }, ...matches];
    expect(stableMatchIndex(grown, { rowIdx: 5, colIdx: 1 }, 2)).toBe(3);
  });

  it("同じセルが消えたら直前インデックスを範囲内にクランプする", () => {
    expect(stableMatchIndex(matches, { rowIdx: 9, colIdx: 9 }, 10)).toBe(2);
    expect(stableMatchIndex(matches, { rowIdx: 9, colIdx: 9 }, -1)).toBe(0);
  });

  it("現在位置が無ければ先頭 (0)", () => {
    expect(stableMatchIndex(matches, null, null)).toBe(0);
  });
});

describe("findMatchKey / buildFindKeySet", () => {
  it("'row:col' 形式のキーと Set を生成する", () => {
    expect(findMatchKey({ rowIdx: 3, colIdx: 7 })).toBe("3:7");
    const set = buildFindKeySet([
      { rowIdx: 0, colIdx: 1 },
      { rowIdx: 2, colIdx: 0 },
    ]);
    expect(set.has("0:1")).toBe(true);
    expect(set.has("2:0")).toBe(true);
    expect(set.has("1:1")).toBe(false);
    expect(set.size).toBe(2);
  });
});
