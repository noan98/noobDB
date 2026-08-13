import { describe, expect, it } from "vitest";
import { resultViewKey } from "../components/resultViewKey";

describe("resultViewKey (#909)", () => {
  it("is namespaced and stable for identical SQL", () => {
    const key = resultViewKey("noobdb.chartconfig.v1", "SELECT * FROM users");
    expect(key).toBeDefined();
    expect(key?.startsWith("noobdb.chartconfig.v1::")).toBe(true);
    expect(resultViewKey("noobdb.chartconfig.v1", "SELECT * FROM users")).toBe(key);
  });

  it("treats leading/trailing whitespace as equivalent", () => {
    expect(resultViewKey("ns", "  SELECT 1  ")).toBe(resultViewKey("ns", "SELECT 1"));
  });

  it("differs for different SQL text", () => {
    expect(resultViewKey("ns", "SELECT 1")).not.toBe(resultViewKey("ns", "SELECT 2"));
  });

  it("differs across namespaces for the same SQL (chart vs pivot don't collide)", () => {
    expect(resultViewKey("ns-a", "SELECT 1")).not.toBe(resultViewKey("ns-b", "SELECT 1"));
  });

  it("returns undefined for missing / empty / whitespace-only SQL", () => {
    expect(resultViewKey("ns", undefined)).toBeUndefined();
    expect(resultViewKey("ns", "")).toBeUndefined();
    expect(resultViewKey("ns", "   ")).toBeUndefined();
  });
});
