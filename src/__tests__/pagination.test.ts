import { describe, expect, it } from "vitest";
import {
  buildCountSql,
  buildPageSql,
  exactCountKey,
  matchingExactCount,
  parseCountCell,
  totalPagesFromCount,
  canGoNext,
  effectiveTotalPages,
  canGoPrev,
  clampPage,
  estimatedTotalPages,
  pageRange,
} from "../pagination";

describe("buildPageSql", () => {
  it("builds LIMIT/OFFSET for the first page", () => {
    expect(buildPageSql("SELECT * FROM t", 100, 1)).toBe("SELECT * FROM t LIMIT 100 OFFSET 0");
  });

  it("offsets by pageSize*(page-1)", () => {
    expect(buildPageSql("SELECT * FROM t", 50, 4)).toBe("SELECT * FROM t LIMIT 50 OFFSET 150");
  });

  it("clamps invalid page/size to sane minimums", () => {
    expect(buildPageSql("SELECT 1", 0, 0)).toBe("SELECT 1 LIMIT 1 OFFSET 0");
  });
});

describe("estimatedTotalPages", () => {
  it("ceils the estimate over the page size", () => {
    expect(estimatedTotalPages(250, 100)).toBe(3);
    expect(estimatedTotalPages(200, 100)).toBe(2);
  });

  it("returns null when the estimate is unknown or non-positive", () => {
    expect(estimatedTotalPages(null, 100)).toBeNull();
    expect(estimatedTotalPages(undefined, 100)).toBeNull();
    expect(estimatedTotalPages(0, 100)).toBeNull();
    expect(estimatedTotalPages(-5, 100)).toBeNull();
  });
});

describe("clampPage", () => {
  it("clamps to [1, total]", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(99, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });

  it("only enforces the lower bound when total is unknown", () => {
    expect(clampPage(0, null)).toBe(1);
    expect(clampPage(42, null)).toBe(42);
  });
});

describe("canGoNext", () => {
  it("uses total pages when known", () => {
    expect(canGoNext(2, 3, 0, 100)).toBe(true);
    expect(canGoNext(3, 3, 42, 100)).toBe(false);
  });

  it("keeps next enabled on a full page at the estimated last page (estimate may undercount)", () => {
    expect(canGoNext(3, 3, 100, 100)).toBe(true);
  });

  it("falls back to a full page meaning there may be more", () => {
    expect(canGoNext(1, null, 100, 100)).toBe(true);
    expect(canGoNext(1, null, 42, 100)).toBe(false);
  });
});

describe("canGoPrev", () => {
  it("is true only past page 1", () => {
    expect(canGoPrev(1)).toBe(false);
    expect(canGoPrev(2)).toBe(true);
  });
});

describe("pageRange", () => {
  it("computes 1-based row range for the page", () => {
    expect(pageRange(1, 100, 100)).toEqual({ from: 1, to: 100 });
    expect(pageRange(3, 50, 20)).toEqual({ from: 101, to: 120 });
  });

  it("returns a zero range for an empty page", () => {
    expect(pageRange(2, 100, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("effectiveTotalPages", () => {
  it("推定が null なら null", () => {
    expect(effectiveTotalPages(null, 3, true)).toBeNull();
  });
  it("推定を超えて表示中のページへ force で取り直しても戻されない", () => {
    expect(clampPage(7, effectiveTotalPages(6, 7, false))).toBe(7);
  });
  it("満杯なら推定の最終ページから 1 ページ先まで進める", () => {
    expect(clampPage(7, effectiveTotalPages(6, 6, true))).toBe(7);
    expect(clampPage(8, effectiveTotalPages(6, 6, true))).toBe(7);
    expect(clampPage(7, effectiveTotalPages(6, 6, false))).toBe(6);
  });
});

describe("正確な総件数 (#1627)", () => {
  it("buildCountSql は派生テーブルに別名を付け、末尾の ; を落とす", () => {
    expect(buildCountSql("SELECT * FROM t WHERE a = 1;")).toBe(
      "SELECT COUNT(*) FROM (SELECT * FROM t WHERE a = 1) AS noobdb_count",
    );
    expect(buildCountSql("  SELECT 1  ")).toBe("SELECT COUNT(*) FROM (SELECT 1) AS noobdb_count");
  });

  it("parseCountCell は非負の安全整数だけを受ける (数値・文字列)", () => {
    expect(parseCountCell(42)).toBe(42);
    expect(parseCountCell("1234")).toBe(1234);
    expect(parseCountCell(0)).toBe(0);
    expect(parseCountCell("9007199254740993")).toBeNull();
    expect(parseCountCell(-1)).toBeNull();
    expect(parseCountCell(1.5)).toBeNull();
    expect(parseCountCell(null)).toBeNull();
    expect(parseCountCell("abc")).toBeNull();
    expect(parseCountCell("")).toBeNull();
  });

  it("totalPagesFromCount は 0 件でも 1 ページ、端数は切り上げる", () => {
    expect(totalPagesFromCount(0, 100)).toBe(1);
    expect(totalPagesFromCount(100, 100)).toBe(1);
    expect(totalPagesFromCount(101, 100)).toBe(2);
  });

  it("matchingExactCount は条件キーが一致するときだけ件数を返す", () => {
    const key = exactCountKey("SELECT * FROM t", null);
    expect(matchingExactCount({ total: 7, key }, key)).toBe(7);
    expect(matchingExactCount({ total: 7, key }, exactCountKey("SELECT * FROM t", { a: 1 }))).toBeNull();
    expect(matchingExactCount(null, key)).toBeNull();
    expect(matchingExactCount(undefined, key)).toBeNull();
  });

  it("確定した総ページ数では最終ページで満杯でも次へ進めず、推定を現在ページで底上げしない", () => {
    // 推定なら満杯の最終ページで次へ進めるが、確定値なら止める。
    expect(canGoNext(3, 3, 100, 100)).toBe(true);
    expect(canGoNext(3, 3, 100, 100, true)).toBe(false);
    expect(canGoNext(2, 3, 100, 100, true)).toBe(true);
    expect(effectiveTotalPages(3, 5, true)).toBe(6);
    expect(effectiveTotalPages(3, 5, true, true)).toBe(3);
  });
});
