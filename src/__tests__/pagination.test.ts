import { describe, expect, it } from "vitest";
import {
  buildPageSql,
  canGoNext,
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
    expect(canGoNext(3, 3, 100, 100)).toBe(false);
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
