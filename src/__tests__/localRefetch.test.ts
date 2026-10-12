import { describe, expect, it } from "vitest";
import { planLocalRefetch } from "../components/localRefetch";

const conns = [
  { sessionId: "s1", profile: { name: "Prod", driver: "postgres" } },
  { sessionId: "s2", profile: { name: "Dev", driver: "mysql" } },
];
const meta = (over: Partial<Parameters<typeof planLocalRefetch>[0]> = {}): Parameters<typeof planLocalRefetch>[0] => ({
  source_profile: "Dev",
  source_sql: "SELECT * FROM users",
  source_driver: "mysql",
  source_database: "shop",
  ...over,
});

describe("planLocalRefetch (#1541)", () => {
  it("表示名とドライバが一致する開いている接続を選ぶ", () => {
    expect(planLocalRefetch(meta(), conns)).toEqual({ kind: "ok", sessionId: "s2", database: "shop" });
  });

  it("元の接続が閉じていれば案内 (noConnection)、名前は同じでもドライバが違えば別の接続扱い", () => {
    expect(planLocalRefetch(meta({ source_profile: "Staging" }), conns)).toEqual({
      kind: "noConnection",
      profileName: "Staging",
    });
    expect(planLocalRefetch(meta({ source_profile: "Prod", source_driver: "mysql" }), conns)).toEqual({
      kind: "noConnection",
      profileName: "Prod",
    });
    expect(planLocalRefetch(meta({ source_profile: null }), conns)).toEqual({
      kind: "noConnection",
      profileName: null,
    });
  });

  it("ドライバが記録されていなければ名前だけで探す", () => {
    expect(planLocalRefetch(meta({ source_driver: null }), conns)).toEqual({ kind: "ok", sessionId: "s2", database: "shop" });
  });

  it("MySQL / PostgreSQL で実行 DB が未記録なら断る。SQLite は DB 不要 (#1541)", () => {
    expect(planLocalRefetch(meta({ source_database: null }), conns)).toEqual({ kind: "noDatabase" });
    expect(planLocalRefetch(meta({ source_database: "" }), conns)).toEqual({ kind: "noDatabase" });
    const lite = [{ sessionId: "s3", profile: { name: "Lite", driver: "sqlite" } }];
    expect(
      planLocalRefetch(meta({ source_profile: "Lite", source_driver: "sqlite", source_database: null }), lite),
    ).toEqual({ kind: "ok", sessionId: "s3", database: null });
  });

  it("同名の接続が 2 つ以上開いていれば曖昧として断る (#1541)", () => {
    const dup = [...conns, { sessionId: "s9", profile: { name: "Dev", driver: "mysql" } }];
    expect(planLocalRefetch(meta(), dup)).toEqual({ kind: "ambiguous", profileName: "Dev" });
  });

  it("読み取り専用でない SQL や複文は再実行しない (接続が開いていても)", () => {
    for (const sql of ["DELETE FROM users", "SELECT 1; DROP TABLE users", "UPDATE t SET a = 1", ""]) {
      expect(planLocalRefetch(meta({ source_sql: sql }), conns)).toEqual({ kind: "notReadOnly" });
    }
  });
});
