import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "../api/tauri";
import { connectRequestFromProfile } from "../connectRequest";
import {
  baseProfileId,
  connectionsAffectedByDelete,
  databaseVariantProfile,
  filterDatabases,
  insertVariantProfiles,
  isVariantProfileId,
} from "../openDatabase";

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

describe("固定ローカルポートと名前 (#2018)", () => {
  const withSsh = {
    ...profile,
    ssh: { host: "b", port: 22, user: "u", auth_method: "key", private_key_path: "/k", local_port: 15432 },
  } as unknown as ConnectionProfile;

  it("派生プロファイルは ssh.local_port を引き継がない (元の接続が握っているため)", () => {
    const v = databaseVariantProfile(withSsh, "analytics");
    expect(v.ssh?.local_port).toBeNull();
    expect(withSsh.ssh?.local_port).toBe(15432);
    const req = connectRequestFromProfile(v, { pinLocalPort: true });
    expect(req.ssh?.local_port).toBeNull();
  });

  it("元の名前に ' / ' を含んでも、末尾の ' / <db>' だけを外して組み立てる", () => {
    const base = { ...profile, name: "A / B" } as ConnectionProfile;
    const v1 = databaseVariantProfile(base, "x");
    expect(v1.name).toBe("A / B / x");
    expect(databaseVariantProfile(v1, "y").name).toBe("A / B / y");
  });

  it("variant_of は派生のときだけ元 ID を明示する", () => {
    expect(connectRequestFromProfile(profile).variant_of).toBeUndefined();
    expect(connectRequestFromProfile(databaseVariantProfile(profile, "a")).variant_of).toBe("p1");
  });
});

describe("insertVariantProfiles", () => {
  it("派生を元プロファイルの直下へ、元が無ければ末尾へ差し込む", () => {
    const a = { ...profile, id: "a" } as ConnectionProfile;
    const b = { ...profile, id: "b" } as ConnectionProfile;
    const va = databaseVariantProfile(a, "x");
    const orphan = databaseVariantProfile({ ...profile, id: "gone" } as ConnectionProfile, "y");
    expect(insertVariantProfiles([a, b], [orphan, va]).map((p) => p.id)).toEqual([
      "a",
      "a::db::x",
      "b",
      "gone::db::y",
    ]);
    expect(isVariantProfileId("a::db::x")).toBe(true);
    expect(isVariantProfileId("a")).toBe(false);
  });
});

describe("connectionsAffectedByDelete (#2018)", () => {
  it("本体と派生接続だけを返し、別プロファイルや前方一致の ID は含めない", () => {
    const conns = ["p1", "p1::db::a", "p1::db::b", "p10", "p10::db::a", "p2"].map((id, i) => ({
      sessionId: `s${i}`,
      profile: { id },
    }));
    expect(connectionsAffectedByDelete(conns, "p1").map((c) => c.sessionId)).toEqual(["s0", "s1", "s2"]);
    expect(connectionsAffectedByDelete(conns, "p2").map((c) => c.sessionId)).toEqual(["s5"]);
    expect(connectionsAffectedByDelete(conns, "p3")).toEqual([]);
  });
});
