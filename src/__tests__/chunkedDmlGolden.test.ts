import { describe, expect, it } from "vitest";
import {
  buildChunkSql,
  buildCountSql,
  maxBatchesFor,
  pickSqliteRowKey,
  validateFragment,
} from "../components/chunkedDml";
import vectors from "./fixtures/chunkedDmlVectors.json";

// 大規模 DML のチャンク分割実行 (#2020) の SQL 生成ゴールデン — フロント側。
// バック側は同じ JSON を `src-tauri/tests/chunked_dml_golden.rs` が読む。

type Driver = "mysql" | "postgres" | "sqlite";
const drivers = vectors.drivers as Driver[];

describe("chunked DML golden vectors", () => {
  for (const c of vectors.cases) {
    for (const driver of Object.keys(c.expected) as Driver[]) {
      it(`${c.note} [${driver}]`, () => {
        const sql = buildChunkSql({
          driver,
          database: c.database,
          table: c.table,
          op: "set" in c && c.set !== undefined ? { kind: "update", setClause: c.set } : { kind: "delete" },
          where: c.where,
          batchSize: c.batchSize,
          rowKey: (c as { rowKey?: string }).rowKey,
        });
        expect(sql).toEqual({ ok: true, sql: (c.expected as Record<string, string>)[driver] });
        expect(buildCountSql({ driver, database: c.database, table: c.table, where: c.where })).toEqual({
          ok: true,
          sql: (c.count as Record<string, string>)[driver],
        });
      });
    }
  }
  for (const c of vectors.errors) {
    for (const driver of ((c as { drivers?: Driver[] }).drivers ?? drivers) as Driver[]) {
      it(`reject: ${c.note} [${driver}]`, () => {
        const set = (c as { set?: string }).set;
        const sql = buildChunkSql({
          driver,
          database: null,
          table: c.table,
          op: set !== undefined ? { kind: "update", setClause: set } : { kind: "delete" },
          where: c.where,
          batchSize: c.batchSize,
        });
        expect(sql).toEqual({ ok: false, code: c.error });
      });
    }
  }
});

describe("chunked DML count SQL rejections", () => {
  for (const c of vectors.errors) {
    // 件数 SELECT は SET もバッチサイズも持たない (SET 側の拒否は対象外、バッチサイズは 1 で固定)。
    if ("set" in c || c.error === "badBatchSize") continue;
    for (const driver of ((c as { drivers?: Driver[] }).drivers ?? drivers) as Driver[]) {
      it(`reject count: ${c.note} [${driver}]`, () => {
        expect(buildCountSql({ driver, database: null, table: c.table, where: c.where })).toEqual({
          ok: false,
          code: c.error,
        });
      });
    }
  }
});

// validate_fragment の単体判定 (#2103)。Rust 側は同じ JSON を chunked_dml_golden.rs が読む。
describe("validateFragment golden vectors", () => {
  for (const c of vectors.fragments) {
    for (const driver of (c.drivers ?? drivers) as Driver[]) {
      it(`${c.note} [${driver}] ${JSON.stringify(c.frag)}`, () => {
        expect(validateFragment(driver, c.frag)).toBe(c.error);
      });
    }
  }
});

describe("maxBatchesFor", () => {
  it("見込みバッチ数の 2 倍 + 3", () => {
    expect(maxBatchesFor(0, 1000)).toBe(3);
    expect(maxBatchesFor(1000, 1000)).toBe(5);
    expect(maxBatchesFor(1001, 1000)).toBe(7);
  });
});

describe("pickSqliteRowKey", () => {
  it("実列に隠されていない別名を選ぶ (Rust pick_sqlite_row_key と同じ)", () => {
    expect(pickSqliteRowKey(["id"])).toBe("rowid");
    expect(pickSqliteRowKey(["RowId"])).toBe("_rowid_");
    expect(pickSqliteRowKey(["rowid", "_rowid_"])).toBe("oid");
    expect(pickSqliteRowKey(["rowid", "_rowid_", "OID"])).toBeNull();
  });
});
