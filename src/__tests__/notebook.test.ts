import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  checkNotebookLimits,
  cellHasWrites,
  createEmptyNotebook,
  DEFAULT_SNAPSHOT_ROW_LIMIT,
  insertCellAfter,
  MAX_CELL_TEXT_CHARS,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_FILE_BYTES,
  MAX_SNAPSHOT_CELL_CHARS,
  MAX_SNAPSHOT_ROW_LIMIT,
  moveCell,
  newMarkdownCell,
  newSqlCell,
  notebookFileName,
  parseNotebook,
  reorderCellsByIds,
  resolveCellTarget,
  serializeNotebook,
  sqlCellsToRun,
  utf8ByteLength,
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
    expect(text).toContain(`"maskedColumns":["email"]`);
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

describe("サイズ上限と値の切り詰め (#2380)", () => {
  it("長い文字列の値は切り詰めて valuesTruncated を立てる", () => {
    const long = "x".repeat(MAX_SNAPSHOT_CELL_CHARS + 50);
    const s = buildSnapshot(
      {
        columns: [{ name: "t", type_name: "text" }],
        rows: [[long], ["short"]],
        totalRows: 2,
        rowsAffected: 0,
        hasColumns: true,
        elapsedMs: 1,
      },
      200,
      MASK_OFF,
    );
    expect(s.valuesTruncated).toBe(true);
    expect(s.rows[0][0]).toBe(`${"x".repeat(MAX_SNAPSHOT_CELL_CHARS)}…`);
    expect(s.rows[1][0]).toBe("short");
  });

  it("ちょうど上限の値は切り詰めない", () => {
    const edge = "y".repeat(MAX_SNAPSHOT_CELL_CHARS);
    const s = buildSnapshot(
      {
        columns: [{ name: "t", type_name: "text" }],
        rows: [[edge]],
        totalRows: 1,
        rowsAffected: 0,
        hasColumns: true,
        elapsedMs: 1,
      },
      200,
      MASK_OFF,
    );
    expect(s.valuesTruncated).toBe(false);
    expect(s.rows[0][0]).toBe(edge);
  });

  it("UTF-8 バイト数を数える (日本語は 3 バイト)", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("あ")).toBe(3);
    expect(MAX_NOTEBOOK_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("シリアライズはコンパクト JSON (整形しない)", () => {
    const text = serializeNotebook(createEmptyNotebook(null), MASK_OFF);
    expect(text.trim().split("\n")).toHaveLength(1);
  });
});

describe("保存前の上限検査 (読み込み側と同じ定数)", () => {
  it("上限ちょうどは通り、超えると違反を返す", () => {
    const d = createEmptyNotebook(null);
    d.cells = Array.from({ length: MAX_NOTEBOOK_CELLS }, () => newSqlCell("SELECT 1"));
    expect(checkNotebookLimits(d)).toBeNull();
    d.cells = [...d.cells, newMarkdownCell("x")];
    expect(checkNotebookLimits(d)).toEqual({ kind: "cells", limit: MAX_NOTEBOOK_CELLS });
  });

  it("セルのテキスト長 (SQL / Markdown) が上限を超えると違反", () => {
    const d = createEmptyNotebook(null);
    d.cells = [newSqlCell("a".repeat(MAX_CELL_TEXT_CHARS))];
    expect(checkNotebookLimits(d)).toBeNull();
    d.cells = [newSqlCell("a".repeat(MAX_CELL_TEXT_CHARS + 1))];
    expect(checkNotebookLimits(d)).toEqual({ kind: "cellText", limit: MAX_CELL_TEXT_CHARS });
    d.cells = [newMarkdownCell("a".repeat(MAX_CELL_TEXT_CHARS + 1))];
    expect(checkNotebookLimits(d)?.kind).toBe("cellText");
  });

  it("検査を通る文書は読み込みで欠けない", () => {
    const d = createEmptyNotebook(null);
    d.cells = Array.from({ length: MAX_NOTEBOOK_CELLS }, (_, i) => newSqlCell(`SELECT ${i}`));
    const parsed = parseNotebook(serializeNotebook(d, MASK_OFF));
    expect(parsed.ok && parsed.doc.cells.length).toBe(MAX_NOTEBOOK_CELLS);
  });
});

describe("セル単位の接続 (#2396)", () => {
  const prof = (id: string, driver: string) =>
    ({ id, name: `${id}-name`, driver, is_production: false }) as unknown as Parameters<
      typeof resolveCellTarget
    >[2][number];
  const my = prof("my", "mysql");
  const pg = prof("pg", "postgres");
  const lite = prof("lite", "sqlite");

  it("新しい SQL セルは接続未指定 (= 現在の接続)", () => {
    expect(newSqlCell("SELECT 1").connection).toBeNull();
  });

  it("保存・再読み込み後も接続が維持され、ID と表示名だけが入る", () => {
    const d = createEmptyNotebook(null);
    const a = newSqlCell("SELECT 1");
    a.connection = { profileId: "pg", name: "分析用" };
    (a.connection as unknown as Record<string, unknown>).password = "hunter2";
    d.cells = [a, newSqlCell("SELECT 2")];
    const text = serializeNotebook(d, MASK_OFF);
    expect(text).not.toContain("hunter2");
    const parsed = parseNotebook(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [c1, c2] = parsed.doc.cells;
    expect(c1.kind === "sql" && c1.connection).toEqual({ profileId: "pg", name: "分析用" });
    expect(c2.kind === "sql" && c2.connection).toBeNull();
  });

  it("接続が壊れた / 版の古いファイル (connection なし) は未指定として読む", () => {
    const text = JSON.stringify({
      format: "noobdb-notebook",
      version: 1,
      cells: [
        { kind: "sql", sql: "SELECT 1" },
        { kind: "sql", sql: "SELECT 2", connection: { profileId: 5 } },
        { kind: "sql", sql: "SELECT 3", connection: { profileId: "", name: "x" } },
      ],
    });
    const parsed = parseNotebook(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const c of parsed.doc.cells) expect(c.kind === "sql" && c.connection).toBeNull();
  });

  it("実行先の解決: 未指定 / 現在と同じ = current", () => {
    expect(resolveCellTarget(null, "my", [my, pg], [])).toEqual({ kind: "current" });
    expect(resolveCellTarget({ profileId: "my", name: "x" }, "my", [my], [])).toEqual({ kind: "current" });
  });

  it("実行先の解決: 3 ドライバの組み合わせで、開いている接続はそのセッションを指す", () => {
    const open = [
      { sessionId: "s-my", profile: my },
      { sessionId: "s-pg", profile: pg },
      { sessionId: "s-lite", profile: lite },
    ];
    for (const [current, other, sid] of [
      ["my", pg, "s-pg"],
      ["pg", lite, "s-lite"],
      ["lite", my, "s-my"],
    ] as const) {
      expect(
        resolveCellTarget({ profileId: other.id, name: other.name }, current, [my, pg, lite], open),
      ).toEqual({
        kind: "open",
        profile: other,
        sessionId: sid,
      });
    }
  });

  it("実行先の解決: 保存済みだが閉じている = closed、プロファイルが無い = missing", () => {
    const ref = { profileId: "pg", name: "分析用" };
    expect(resolveCellTarget(ref, "my", [my, pg], [{ sessionId: "s-my", profile: my }])).toEqual({
      kind: "closed",
      ref,
      profile: pg,
    });
    expect(resolveCellTarget(ref, "my", [my], [{ sessionId: "s-my", profile: my }])).toEqual({
      kind: "missing",
      ref,
    });
  });

  it("実行先の解決: 保存一覧に無くても開いている一時接続 (別 DB で開く) は open", () => {
    const tmp = prof("tmp", "postgres");
    expect(
      resolveCellTarget({ profileId: "tmp", name: "t" }, "my", [my], [{ sessionId: "s-t", profile: tmp }]),
    ).toMatchObject({ kind: "open", sessionId: "s-t" });
  });

  it("実行先の解決: 開いている接続は保存済みプロファイルの最新の設定を使う", () => {
    const stale = { ...my, is_production: false } as typeof my;
    const fresh = { ...my, is_production: true } as typeof my;
    const t = resolveCellTarget(
      { profileId: "my", name: "x" },
      "pg",
      [fresh],
      [{ sessionId: "s", profile: stale }],
    );
    expect(t).toMatchObject({ kind: "open", sessionId: "s" });
    expect(t.kind === "open" && t.profile.is_production).toBe(true);
  });
});
