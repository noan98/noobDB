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

  it("forceTypedConfirm: 関数呼び出しでも本番では書き込み承認と対象名の型入力を求める (#2180)", () => {
    const sql = "SELECT pg_drop_replication_slot('slot_a')";
    const input = { ...base, sql, destructiveTargets: ["slot_a"], forceTypedConfirm: true };
    expect(evaluateDdlGate({ ...input, isProduction: true })).toMatchObject({
      writeApproval: true,
      typedConfirmTarget: "slot_a",
    });
    // 非本番・設定 OFF では素通り (パネル自身の SQL プレビュー確認だけ)。
    expect(evaluateDdlGate(input)).toBeNull();
    // 指定しなければ従来どおり (DROP 文ではないので型入力なし)。
    expect(evaluateDdlGate({ ...input, forceTypedConfirm: false, isProduction: true })).toBeNull();
  });
});

describe("evaluateDdlGate: セル単位の接続 (#2396)", () => {
  // ノートブックは、セルが指す接続の設定でゲートを判定する (アクティブな接続の設定を使い回さない)。
  const cases: { driver: string; sql: string }[] = [
    { driver: "mysql", sql: "DROP TABLE orders" },
    { driver: "postgres", sql: "DROP TABLE orders" },
    { driver: "sqlite", sql: "DROP TABLE orders" },
  ];
  const quiet = { ...base, confirmDangerousQueries: false };

  for (const { driver, sql } of cases) {
    it(`${driver}: 本番の接続のセルは、検証用の接続 (確認なし) の設定にかかわらず型入力確認を求める`, () => {
      const dev = evaluateDdlGate({ ...quiet, sql, driver });
      const prod = evaluateDdlGate({ ...quiet, sql, driver, isProduction: true, confirmWrites: true });
      expect(dev).toBeNull();
      expect(prod?.isProduction).toBe(true);
      expect(prod?.writeApproval).toBe(true);
      expect(prod?.typedConfirmTarget).toBe("orders");
    });

    it(`${driver}: read_only の本番接続は書き込み承認を求めず (バックエンドが拒否する)、危険文の警告は出す`, () => {
      const g = evaluateDdlGate({
        ...quiet,
        sql,
        driver,
        isProduction: true,
        confirmWrites: true,
        readOnly: true,
      });
      expect(g?.writeApproval).toBe(false);
      expect(g?.findings.length).toBeGreaterThan(0);
    });

    it(`${driver}: 緊急モードはセルの接続のものを使う`, () => {
      expect(evaluateDdlGate({ ...quiet, sql, driver, emergencyMode: true })?.writeApproval).toBe(true);
      expect(evaluateDdlGate({ ...quiet, sql, driver, emergencyMode: false })).toBeNull();
    });
  }
});
