import { describe, expect, it } from "vitest";
import { qualifiedTableSql } from "../components/sqlDialect";
import vectors from "./fixtures/tableSelectSql.json";

// Rust の `commands::table_open::table_select_sql` (`open_table` が返す初回 SELECT)
// と同一の SQL を返すことを、共有ゴールデンで固定する (#1263)。
describe("qualifiedTableSql (shared golden with table_select_sql)", () => {
  for (const v of vectors) {
    it(`${v.driver} ${v.database}.${v.table} hidden=${v.hidden}`, () => {
      expect(qualifiedTableSql(v.driver, v.database, v.table, v.hidden)).toBe(v.expected);
    });
  }
});
