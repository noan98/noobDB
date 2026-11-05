import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "../api/tauri";
import { baseProfileId, databaseVariantProfile, filterDatabases } from "../openDatabase";

const profile = {
  id: "p1",
  name: "Prod PG",
  driver: "postgres",
  host: "db",
  port: 5432,
  user: "u",
  database: "app",
  ssh: null,
  group: null,
  color: null,
  is_production: true,
  confirm_writes: true,
  read_only: true,
  skip_history: false,
  file_path: null,
} as unknown as ConnectionProfile;

describe("databaseVariantProfile (#2018)", () => {
  it("database だけ差し替え、安全網フラグは継承する", () => {
    const v = databaseVariantProfile(profile, "analytics");
    expect(v.id).toBe("p1::db::analytics");
    expect(v.name).toBe("Prod PG / analytics");
    expect(v.database).toBe("analytics");
    expect(v.read_only).toBe(true);
    expect(v.is_production).toBe(true);
    expect(v.host).toBe("db");
  });

  it("派生から更に派生しても元の ID・名前に戻って組み立てる", () => {
    const v2 = databaseVariantProfile(databaseVariantProfile(profile, "a"), "b");
    expect(v2.id).toBe("p1::db::b");
    expect(v2.name).toBe("Prod PG / b");
    expect(baseProfileId(v2.id)).toBe("p1");
    expect(baseProfileId("p1")).toBe("p1");
  });
});

describe("filterDatabases", () => {
  it("大文字小文字を無視した部分一致、空語は全件", () => {
    expect(filterDatabases(["App", "analytics", "postgres"], "AN")).toEqual(["analytics"]);
    expect(filterDatabases(["a", "b"], "  ")).toEqual(["a", "b"]);
  });
});
