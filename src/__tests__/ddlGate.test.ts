import { describe, expect, it } from "vitest";
import { analyzeDangerousSql } from "../dangerousSql";
import { evaluateDdlGate, type DdlGateInput } from "../ddlGate";

const base: DdlGateInput = {
  sql: 'DROP EXTENSION "postgis" CASCADE',
  driver: "postgres",
  isProduction: false,
  confirmWrites: false,
  readOnly: false,
  emergencyMode: false,
  confirmDangerousQueries: false,
};

describe("evaluateDdlGate (#2176)", () => {
  it("DROP EXTENSION / TYPE / SCHEMA CASCADE を drop として検出する", () => {
    for (const sql of ['DROP EXTENSION "postgis" CASCADE', "DROP TYPE mood", "DROP SCHEMA app CASCADE"]) {
      expect(analyzeDangerousSql(sql, "postgres")[0]?.kind).toBe("drop");
    }
  });

  it("本番 + confirm_writes: 書き込み承認と対象名の型入力を求める", () => {
    const g = evaluateDdlGate({ ...base, isProduction: true, confirmWrites: true });
    expect(g?.writeApproval).toBe(true);
    expect(g?.typedConfirmTarget).toBe("postgis");
  });

  it("本番 (confirm_writes なし): 危険文の警告と型入力のみ", () => {
    const g = evaluateDdlGate({ ...base, isProduction: true });
    expect(g?.writeApproval).toBe(false);
    expect(g?.typedConfirmTarget).toBe("postgis");
  });

  it("非本番では型入力を求めない。設定 OFF なら素通り、ON なら警告", () => {
    expect(evaluateDdlGate(base)).toBeNull();
    const g = evaluateDdlGate({ ...base, confirmDangerousQueries: true });
    expect(g?.typedConfirmTarget).toBeNull();
    expect(g?.findings).toHaveLength(1);
  });

  it("緊急モード中は非破壊の DDL でも毎回承認を求める", () => {
    const g = evaluateDdlGate({ ...base, sql: "CREATE EXTENSION pg_trgm", emergencyMode: true });
    expect(g?.writeApproval).toBe(true);
    expect(g?.findings).toHaveLength(0);
  });

  it("read-only の本番接続は confirm_writes の承認対象外", () => {
    const g = evaluateDdlGate({
      ...base,
      sql: "CREATE EXTENSION pg_trgm",
      isProduction: true,
      confirmWrites: true,
      readOnly: true,
    });
    expect(g).toBeNull();
  });

  it("本番 + confirm_writes でも非破壊の DDL は承認のみ (型入力なし)", () => {
    const g = evaluateDdlGate({
      ...base,
      sql: "CREATE EXTENSION pg_trgm",
      isProduction: true,
      confirmWrites: true,
    });
    expect(g?.writeApproval).toBe(true);
    expect(g?.typedConfirmTarget).toBeNull();
  });

  it("destructiveTargets が曖昧なら固定フレーズ CONFIRM", () => {
    const g = evaluateDdlGate({ ...base, isProduction: true, destructiveTargets: ["a", "b"] });
    expect(g?.typedConfirmTarget).toBe("CONFIRM");
  });
});
