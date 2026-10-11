import { describe, it, expect } from "vitest";
import { isAbsolutePath } from "../components/pathUtil";

describe("isAbsolutePath", () => {
  it("treats POSIX, home, drive and UNC paths as absolute", () => {
    expect(isAbsolutePath("/var/tmp/a.sql")).toBe(true);
    expect(isAbsolutePath("~/dump.sql")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\a\\dump.sql")).toBe(true);
    expect(isAbsolutePath("d:/dump.sql")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share\\dump.sql")).toBe(true);
  });

  it("treats bare file names and relative paths as relative", () => {
    expect(isAbsolutePath("appdb_dump_20260101_000000.sql")).toBe(false);
    expect(isAbsolutePath("./dump.sql")).toBe(false);
    expect(isAbsolutePath("out/dump.sql")).toBe(false);
    expect(isAbsolutePath("C:dump.sql")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});
