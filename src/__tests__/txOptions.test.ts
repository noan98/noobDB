import { describe, expect, it } from "vitest";
import { isolationIsAliasedOn, resolveTxOptions, supportsTxOptions } from "../txOptions";

describe("txOptions", () => {
  it("MySQL / PostgreSQL のみ対応", () => {
    expect(supportsTxOptions("mysql")).toBe(true);
    expect(supportsTxOptions("postgres")).toBe(true);
    expect(supportsTxOptions("sqlite")).toBe(false);
    expect(supportsTxOptions(undefined)).toBe(false);
  });

  it("SQLite では選択値があっても既定へ落とす", () => {
    expect(resolveTxOptions("sqlite", "serializable", true)).toEqual({ isolation: null, readOnly: false });
  });

  it("対応ドライバでは選択を通し、未知値は無視する", () => {
    expect(resolveTxOptions("mysql", "repeatable-read", true)).toEqual({ isolation: "repeatable-read", readOnly: true });
    expect(resolveTxOptions("postgres", "", false)).toEqual({ isolation: null, readOnly: false });
    expect(resolveTxOptions("postgres", "bogus", false).isolation).toBeNull();
  });

  it("PostgreSQL の READ UNCOMMITTED は別名扱い", () => {
    expect(isolationIsAliasedOn("postgres", "read-uncommitted")).toBe(true);
    expect(isolationIsAliasedOn("mysql", "read-uncommitted")).toBe(false);
    expect(isolationIsAliasedOn("postgres", "serializable")).toBe(false);
  });
});
