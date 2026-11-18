import { describe, expect, it } from "vitest";
import {
  PREVIEW_SQL_LIMIT,
  buildPreviewColumns,
  clipPreviewSql,
  indexHistoryMeta,
  relativeExecutedAt,
  snippetPlaceholders,
} from "../components/commandPalettePreview";
import type { HistoryEntry, TableColumnInfo } from "../api/tauri";

const col = (over: Partial<TableColumnInfo>): TableColumnInfo => ({
  name: "id",
  data_type: "bigint",
  nullable: false,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: 1,
  profile_id: "p",
  driver: "mysql",
  database: null,
  sql_preview: "",
  sql_len: 0,
  rows: null,
  rows_affected: null,
  elapsed_ms: null,
  status: "ok",
  error: null,
  executed_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("buildPreviewColumns (#2425)", () => {
  it("詳細が無いときはスキーマキャッシュの列名だけを並べる", () => {
    expect(buildPreviewColumns(["a", "b"], null)).toEqual([
      { name: "a", dataType: null, primaryKey: false, nullable: null, references: null, comment: null },
      { name: "b", dataType: null, primaryKey: false, nullable: null, references: null, comment: null },
    ]);
  });

  it("詳細があれば型・PK・FK・コメントを載せる", () => {
    const cols = buildPreviewColumns(["id"], {
      rowEstimate: 10,
      columns: [
        col({ name: "id", key: "PRI" }),
        col({ name: "user_id", data_type: "int", referenced_table: "users", referenced_column: "id" }),
        col({ name: "memo", data_type: "text", comment: "  備考  " }),
        col({ name: "x", referenced_table: "t", referenced_column: null }),
      ],
    });
    expect(cols[0]).toMatchObject({ primaryKey: true, dataType: "bigint" });
    expect(cols[1].references).toBe("users.id");
    expect(cols[2].comment).toBe("備考");
    expect(cols[3].references).toBe("t");
  });

  it("詳細の列が空なら列名にフォールバックする", () => {
    expect(buildPreviewColumns(["a"], { columns: [], rowEstimate: null })[0].dataType).toBeNull();
  });
});

describe("snippetPlaceholders", () => {
  it("タブストップと {{param}} を重複なしで抽出し、${0} は除く", () => {
    const ph = snippetPlaceholders("SELECT ${1:cols} FROM ${table} WHERE a = {{id}} AND b = {{id}} ${0}");
    expect(ph.tabStops).toEqual(["1: cols", "table"]);
    expect(ph.params).toEqual(["id"]);
  });

  it("記法を含まない本文は空", () => {
    expect(snippetPlaceholders("SELECT 1")).toEqual({ tabStops: [], params: [] });
  });
});

describe("clipPreviewSql", () => {
  it("上限以内はそのまま、超えたら切り詰めて省略文字数を返す", () => {
    expect(clipPreviewSql("abc")).toEqual({ text: "abc", omitted: 0 });
    const long = "x".repeat(PREVIEW_SQL_LIMIT + 5);
    const r = clipPreviewSql(long);
    expect(r.text).toHaveLength(PREVIEW_SQL_LIMIT);
    expect(r.omitted).toBe(5);
  });
});

describe("indexHistoryMeta / relativeExecutedAt", () => {
  it("同じ SQL は最新 (先頭) の実行メタを採る", () => {
    const m = indexHistoryMeta(
      [
        entry({ id: 2, elapsed_ms: 5, sql_preview: "SELECT 1", sql_len: 8 }),
        entry({ id: 1, elapsed_ms: 9, status: "error", error: "boom", sql_preview: "SELECT 1", sql_len: 8 }),
      ],
      ["SELECT 1", "SELECT 1"],
    );
    expect(m.get("SELECT 1")).toMatchObject({ elapsedMs: 5, ok: true });
  });

  it("件数が食い違っても短い方で打ち切る", () => {
    expect(indexHistoryMeta([entry({ sql_preview: "a", sql_len: 1 })], ["a", "b"]).size).toBe(1);
  });

  it("添字がずれた行 (文字数・要約の先頭が合わない) にはメタを付けない", () => {
    // 取得の間に履歴が 1 行増え、全文の並びだけ 1 つ後ろへずれた状態。
    const m = indexHistoryMeta(
      [
        entry({ id: 2, sql_preview: "SELECT 1", sql_len: 8 }),
        entry({ id: 1, sql_preview: "SELECT 22", sql_len: 9 }),
      ],
      ["INSERT INTO t VALUES (1)", "SELECT 1"],
    );
    expect(m.size).toBe(0);
  });

  it("要約が省略 (…) されていても先頭一致・空白の畳みで組にできる (文字数はコードポイント)", () => {
    const sql = "SELECT  '😀'\nFROM t WHERE id = 1";
    const m = indexHistoryMeta(
      [entry({ sql_preview: "SELECT '😀' FROM t…", sql_len: [...sql].length, elapsed_ms: 3 })],
      [sql],
    );
    expect(m.get(sql)).toMatchObject({ elapsedMs: 3 });
  });

  it("相対時刻は解釈できない日時で null", () => {
    expect(relativeExecutedAt("nope", 0)).toBeNull();
    const now = Date.parse("2026-01-01T02:00:00Z");
    expect(relativeExecutedAt("2026-01-01T00:00:00Z", now)).toEqual({ unit: "hours", value: 2 });
  });
});
