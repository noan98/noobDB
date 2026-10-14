import { describe, expect, it } from "vitest";
import {
  nextStatSort,
  sortStatRows,
  statRowsToTable,
  type StatExportLabels,
} from "../components/queryInspector";
import { tableToCsv, tableToTsv } from "../components/tabularText";

const row = (
  digest: string,
  calls: number,
  total: number,
  mean: number,
  rows: number | null,
  database: string | null = "app",
) => ({
  digest,
  database,
  calls,
  total_time_ms: total,
  mean_time_ms: mean,
  max_time_ms: mean * 2,
  rows,
  n_plus_one: false,
});
const fp = (r: { digest: string }) => `SELECT ${r.digest}`;

describe("sortStatRows (#1539)", () => {
  const rows = [row("a", 5, 100, 20, 10), row("b", 500, 90, 0.18, null), row("c", 50, 300, 6, 3)];
  it("null なら入力順のコピーを返し、入力は変更しない", () => {
    const out = sortStatRows(rows, null, fp);
    expect(out.map((r) => r.digest)).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(rows);
  });
  it("回数の降順 / 平均の昇順", () => {
    expect(sortStatRows(rows, { key: "calls", dir: "desc" }, fp).map((r) => r.digest)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(sortStatRows(rows, { key: "mean", dir: "asc" }, fp).map((r) => r.digest)).toEqual(["b", "c", "a"]);
  });
  it("値が無い行は向きに関わらず末尾", () => {
    expect(sortStatRows(rows, { key: "rows", dir: "desc" }, fp).map((r) => r.digest)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(sortStatRows(rows, { key: "rows", dir: "asc" }, fp).map((r) => r.digest)).toEqual(["c", "a", "b"]);
  });
  it("同値は元の順序を保つ", () => {
    const tie = [row("x", 1, 1, 1, 1), row("y", 1, 1, 1, 1), row("z", 1, 1, 1, 1)];
    expect(sortStatRows(tie, { key: "calls", dir: "desc" }, fp).map((r) => r.digest)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });
  it("フィンガープリントは文字列比較", () => {
    expect(sortStatRows(rows, { key: "fingerprint", dir: "desc" }, fp).map((r) => r.digest)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

describe("nextStatSort (#1539)", () => {
  it("数値列: 降順 → 昇順 → 解除", () => {
    const s1 = nextStatSort(null, "calls");
    expect(s1).toEqual({ key: "calls", dir: "desc" });
    const s2 = nextStatSort(s1, "calls");
    expect(s2).toEqual({ key: "calls", dir: "asc" });
    expect(nextStatSort(s2, "calls")).toBeNull();
  });
  it("文字列列: 昇順 → 降順 → 解除。別の列では既定の向きから", () => {
    const s1 = nextStatSort({ key: "calls", dir: "asc" }, "db");
    expect(s1).toEqual({ key: "db", dir: "asc" });
    expect(nextStatSort(s1, "db")).toEqual({ key: "db", dir: "desc" });
  });
});

describe("statRowsToTable / CSV / TSV (#1539)", () => {
  const labels: StatExportLabels = {
    calls: "Calls",
    total: "Total",
    mean: "Mean",
    max: "Max",
    rows: "Rows",
    db: "DB",
    fingerprint: "Fingerprint",
    nPlusOne: "N+1",
  };
  const r = { ...row("q", 3, 12.5, 4.1666, null, null), n_plus_one: true };
  const table = statRowsToTable([r], () => 'SELECT "a",\n b FROM t\tWHERE x = ?', labels);
  it("見出しと行を作り、null はそのまま", () => {
    expect(table.header).toEqual(["Calls", "Total", "Mean", "Max", "Rows", "DB", "N+1", "Fingerprint"]);
    expect(table.rows[0].slice(0, 7)).toEqual([3, 12.5, 4.1666, 8.3332, null, null, "Y"]);
  });
  it("CSV はカンマ・改行・ダブルクオートをエスケープする", () => {
    const csv = tableToCsv(table.header, table.rows);
    expect(csv.split("\r\n")[1]).toBe('3,12.5,4.1666,8.3332,,,Y,"SELECT ""a"",\n b FROM t\tWHERE x = ?"');
  });
  it("TSV はタブ・改行を空白へ潰す", () => {
    const tsv = tableToTsv(table.header, table.rows);
    const lines = tsv.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1].split("\t")).toHaveLength(8);
    expect(lines[1].endsWith('SELECT "a",  b FROM t WHERE x = ?')).toBe(true);
  });
  it("TSV も数式として解釈されうる先頭文字を緩和する", () => {
    const tsv = tableToTsv(["a"], [["=SUM(A1)"], ["-5"]]);
    expect(tsv).toBe("a\n'=SUM(A1)\n-5\n");
  });
});
