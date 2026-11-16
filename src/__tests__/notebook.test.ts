import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  cellHasWrites,
  createEmptyNotebook,
  DEFAULT_SNAPSHOT_ROW_LIMIT,
  insertCellAfter,
  MAX_SNAPSHOT_ROW_LIMIT,
  moveCell,
  newMarkdownCell,
  newSqlCell,
  notebookFileName,
  parseNotebook,
  reorderCellsByIds,
  serializeNotebook,
  sqlCellsToRun,
  type NotebookDoc,
} from "../notebook";
import { MASK_PLACEHOLDER, DEFAULT_MASK_PATTERNS } from "../components/columnMask";

const MASK_ON = { enabled: true, patterns: DEFAULT_MASK_PATTERNS };
const MASK_OFF = { enabled: false, patterns: DEFAULT_MASK_PATTERNS };
const cols = [
  { name: "id", type_name: "int" },
  { name: "email", type_name: "text" },
];
const bigRows = Array.from({ length: 300 }, (_, i) => [i, `u${i}@example.com`]);

describe("スナップショット", () => {
  it("保存行数の上限で切り詰め、総行数と切り詰めを覚える", () => {
    const s = buildSnapshot(
      { columns: cols, rows: bigRows, totalRows: 1000, rowsAffected: 0, hasColumns: true, elapsedMs: 5 },
      DEFAULT_SNAPSHOT_ROW_LIMIT,
      MASK_OFF,
    );
    expect(s.rows).toHaveLength(200);
    expect(s.totalRows).toBe(1000);
    expect(s.truncated).toBe(true);
  });

  it("上限以内なら切り詰めない", () => {
    const s = buildSnapshot(
      {
        columns: cols,
        rows: bigRows.slice(0, 3),
        totalRows: 3,
        rowsAffected: 0,
        hasColumns: true,
        elapsedMs: 1,
      },
      200,
      MASK_OFF,
    );
    expect(s.truncated).toBe(false);
  });

  it("保存行数は上限 (MAX) を超えない", () => {
    const s = buildSnapshot(
      { columns: cols, rows: bigRows, totalRows: 300, rowsAffected: 0, hasColumns: true, elapsedMs: 1 },
      999999,
      MASK_OFF,
    );
    expect(s.rows.length).toBeLessThanOrEqual(MAX_SNAPSHOT_ROW_LIMIT);
  });

  it("マスキング有効なら対象列を伏せ字にする (無効なら素通し)", () => {
    const input = {
      columns: cols,
      rows: [[1, "a@b.c"]],
      totalRows: 1,
      rowsAffected: 0,
      hasColumns: true,
      elapsedMs: 1,
    };
    const on = buildSnapshot(input, 200, MASK_ON);
    expect(on.rows[0]).toEqual([1, MASK_PLACEHOLDER]);
    expect(on.maskedColumns).toEqual(["email"]);
    expect(buildSnapshot(input, 200, MASK_OFF).rows[0]).toEqual([1, "a@b.c"]);
  });
});

describe("保存 / 読み込み", () => {
  const doc = (): NotebookDoc => {
    const d = createEmptyNotebook({ profileId: "p1", name: "本番" });
    d.title = "調査";
    const sql = newSqlCell("SELECT 1");
    sql.snapshot = buildSnapshot(
      { columns: cols, rows: [[1, "a@b.c"]], totalRows: 1, rowsAffected: 0, hasColumns: true, elapsedMs: 3 },
      200,
      MASK_OFF,
    );
    d.cells = [newMarkdownCell("# 見出し"), sql];
    return d;
  };

  it("書き出して読み直すと結果のスナップショットごと復元される", () => {
    const parsed = parseNotebook(serializeNotebook(doc(), MASK_OFF));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.title).toBe("調査");
    expect(parsed.doc.connection).toEqual({ profileId: "p1", name: "本番" });
    expect(parsed.doc.cells.map((c) => c.kind)).toEqual(["markdown", "sql"]);
    const sql = parsed.doc.cells[1];
    expect(sql.kind === "sql" && sql.snapshot?.rows).toEqual([[1, "a@b.c"]]);
  });

  it("秘密情報らしきプロパティはファイルに入らない (ホワイトリスト)", () => {
    const d = doc() as unknown as Record<string, unknown>;
    (d.connection as Record<string, unknown>).password = "hunter2";
    (d.connection as Record<string, unknown>).ssh_passphrase = "hunter3";
    d.apiKey = "sk-ant-secret";
    (d.cells as Record<string, unknown>[])[1].password = "hunter4";
    const text = serializeNotebook(d as unknown as NotebookDoc, MASK_OFF);
    for (const secret of [
      "hunter2",
      "hunter3",
      "hunter4",
      "sk-ant-secret",
      "password",
      "passphrase",
      "apiKey",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("書き出し時にもマスクを掛け直す (取得後に設定を有効にした場合)", () => {
    const text = serializeNotebook(doc(), MASK_ON);
    expect(text).not.toContain("a@b.c");
    expect(text).toContain(MASK_PLACEHOLDER);
    expect(text).toContain('"maskedColumns": [\n          "email"');
  });

  it("version を持ち、新しすぎる版・別形式・壊れた JSON は拒否する", () => {
    const ok = JSON.parse(serializeNotebook(doc(), MASK_OFF));
    expect(ok.version).toBe(1);
    expect(parseNotebook(JSON.stringify({ ...ok, version: 99 }))).toEqual({
      ok: false,
      reason: "newerVersion",
    });
    expect(parseNotebook(JSON.stringify({ ...ok, format: "x" }))).toEqual({ ok: false, reason: "format" });
    expect(parseNotebook("{")).toEqual({ ok: false, reason: "invalid" });
  });

  it("壊れたセルは捨て、重複 ID は振り直す", () => {
    const raw = {
      format: "noobdb-notebook",
      version: 1,
      cells: [
        { id: "a", kind: "sql", sql: "SELECT 1" },
        { id: "a", kind: "markdown", text: "x" },
        5,
        { kind: "weird" },
      ],
    };
    const parsed = parseNotebook(JSON.stringify(raw));
    expect(parsed.ok && parsed.doc.cells).toHaveLength(2);
    if (parsed.ok) expect(new Set(parsed.doc.cells.map((c) => c.id)).size).toBe(2);
  });

  it("ファイル名は区切り文字を除き拡張子を付ける", () => {
    expect(notebookFileName("a/b:c")).toBe("a_b_c.noobnb");
    expect(notebookFileName("  ")).toBe("notebook.noobnb");
    expect(notebookFileName("x", "md")).toBe("x.md");
  });
});

describe("セル操作", () => {
  const a = newSqlCell("SELECT 1");
  const b = newMarkdownCell("note");
  const c = newSqlCell("SELECT 2");
  it("追加・移動・並べ替え", () => {
    expect(insertCellAfter([a, b], a.id, c).map((x) => x.id)).toEqual([a.id, c.id, b.id]);
    expect(moveCell([a, b, c], b.id, -1).map((x) => x.id)).toEqual([b.id, a.id, c.id]);
    expect(moveCell([a, b, c], a.id, -1)).toEqual([a, b, c]);
    expect(reorderCellsByIds([a, b, c], [c.id, a.id, b.id]).map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    // 順列でなければ変えない
    expect(reorderCellsByIds([a, b, c], [a.id, a.id, b.id])).toEqual([a, b, c]);
  });
  it("実行対象は SQL セルだけで、「ここから下」は自身を含む", () => {
    expect(sqlCellsToRun([a, b, c]).map((x) => x.id)).toEqual([a.id, c.id]);
    expect(sqlCellsToRun([a, b, c], b.id).map((x) => x.id)).toEqual([c.id]);
    expect(sqlCellsToRun([a, b, c], a.id).map((x) => x.id)).toEqual([a.id, c.id]);
    expect(sqlCellsToRun([newSqlCell("  ")])).toEqual([]);
  });
  it("書き込み文を含むセルを判定する", () => {
    expect(cellHasWrites("SELECT 1", "mysql")).toBe(false);
    expect(cellHasWrites("DELETE FROM t", "mysql")).toBe(true);
    expect(cellHasWrites("", "mysql")).toBe(false);
  });
});
