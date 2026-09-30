import { describe, expect, it } from "vitest";
import vectors from "./fixtures/dataSearchVectors.json";
import { buildColumnPredicate } from "../components/dataSearch";
import { classifyTypeName } from "../components/cellTypeMeta";
import type { MatchMode } from "../components/dataSearch";
import {
  buildTableScanSql,
  isNumericTerm,
  parseScanRow,
  searchTargetForKind,
  shouldSkipTableForScan,
} from "./oracles/dataSearchOracle";

/**
 * DB 全体からの値検索の共有ゴールデン (フロント側、#1261)。
 *
 * 走査 SQL の生成本体は Rust (`db::data_search`) に移り、製品コードの TS に残るのは
 * ヒット行のジャンプ SQL が使う `buildColumnPredicate` だけ。列ごとの述語はその製品コードの
 * 実装を、走査 SQL・しきい値・結果行のパースは移植前の TS 実装 (オラクル) を、同じ
 * ベクタに通す。Rust 側 (`tests/data_search_golden.rs`) が同じベクタに Rust 実装を通すので、
 * ジャンプ SQL と走査 SQL の述語が食い違わないことも保証される。
 */
describe("data search golden vectors", () => {
  it("classifies type names", () => {
    for (const c of vectors.classify) {
      const kind = classifyTypeName(c.dataType);
      expect(kind, c.dataType).toBe(c.kind);
      expect(searchTargetForKind(kind), c.dataType).toBe(c.target);
    }
  });

  it("column predicates (production buildColumnPredicate)", () => {
    expect(vectors.predicates.length).toBeGreaterThan(100);
    for (const p of vectors.predicates) {
      expect(
        buildColumnPredicate(p.driver, p.column, classifyTypeName(p.dataType), p.term, p.mode as MatchMode),
        `${p.driver} ${p.column} ${p.dataType} ${JSON.stringify(p.term)} ${p.mode}`,
      ).toBe(p.expected);
    }
  });

  it("numeric term detection", () => {
    for (const n of vectors.numericTerms) {
      expect(isNumericTerm(n.term), n.term).toBe(n.expected);
    }
  });

  it("table scan SQL (oracle)", () => {
    for (const s of vectors.scanSql) {
      expect(
        buildTableScanSql(s.driver, s.database, s.table, s.columns, s.term, s.mode as MatchMode),
        `${s.driver} ${s.table}`,
      ).toEqual(s.expected);
    }
  });

  it("row threshold (oracle)", () => {
    for (const s of vectors.skip) {
      expect(shouldSkipTableForScan(s.estimate, s.threshold)).toBe(s.expected);
    }
  });

  it("scan row parsing (oracle)", () => {
    for (const p of vectors.parseRow) {
      expect(parseScanRow(p.columns, p.row)).toEqual(p.expected);
    }
  });
});
