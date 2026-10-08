import { describe, expect, it } from "vitest";
import type { Column } from "../api/tauri";
import { validateCellInput } from "../components/cellEdit";
import {
  collectInspectorEdits,
  draftFromRow,
  inspectorControlFor,
  inspectorEditableColumns,
  inspectorRowEditBlock,
  rowChangedSince,
} from "../components/rowInspectorEdit";
import type { CellValue } from "../api/tauri";

// 行インスペクタのフォーム編集 (#1394) の判定を固定する。書き込み経路 (cellEdit /
// bulk_update_cells) は既存テストが固定しており、ここは「どの列を・どの値で送るか」を見る。

const validate = (cols: Column[]) => (ci: number, raw: string) =>
  validateCellInput(raw, cols[ci].type_name, true);

describe("inspectorEditableColumns", () => {
  it("読み取り専用 (gridEditable=false) なら全列 false", () => {
    expect(
      inspectorEditableColumns({
        columnCount: 2,
        gridEditable: false,
        editableColumns: [true, true],
      }),
    ).toEqual([false, false]);
  });

  it("グリッドの列判定 (PK・BLOB 除外) を引き継ぎ、マスク中の列は落とす", () => {
    expect(
      inspectorEditableColumns({
        columnCount: 3,
        gridEditable: true,
        editableColumns: [false, true, true],
        maskedColumns: [false, false, true],
      }),
    ).toEqual([false, true, false]);
  });

  it("editableColumns が未指定なら全列 false (保守的に編集させない)", () => {
    expect(inspectorEditableColumns({ columnCount: 2, gridEditable: true })).toEqual([
      false,
      false,
    ]);
  });
});

describe("inspectorRowEditBlock", () => {
  const free = { streaming: false, applying: false, pendingDelete: false, hasPendingEdit: false };

  it("ブロック要因が無ければ null (編集可)", () => {
    expect(inspectorRowEditBlock(free)).toBeNull();
  });

  it("読み込み中 > 適用中 > 削除予定 > 保留中のグリッド編集 の順で理由を返す", () => {
    expect(
      inspectorRowEditBlock({ ...free, streaming: true, applying: true, pendingDelete: true, hasPendingEdit: true }),
    ).toBe("rowInspectorEditBlockedStreaming");
    expect(
      inspectorRowEditBlock({ ...free, applying: true, pendingDelete: true, hasPendingEdit: true }),
    ).toBe("rowInspectorEditBlockedApplying");
    expect(
      inspectorRowEditBlock({ ...free, pendingDelete: true, hasPendingEdit: true }),
    ).toBe("rowInspectorEditBlockedDelete");
    expect(inspectorRowEditBlock({ ...free, hasPendingEdit: true })).toBe(
      "rowInspectorEditBlockedPending",
    );
  });
});

describe("draftFromRow", () => {
  it("NULL は文字列 NULL、それ以外は文字列表現にする (数値を Number 化しない)", () => {
    expect(draftFromRow([1, null, "9007199254740993", false], 4)).toEqual({
      0: "1",
      1: "NULL",
      2: "9007199254740993",
      3: "false",
    });
  });

  it("欠けた値は NULL 扱い", () => {
    expect(draftFromRow([], 2)).toEqual({ 0: "NULL", 1: "NULL" });
  });
});

describe("inspectorControlFor", () => {
  it("日付・日時はネイティブ入力、時刻のうち MySQL の範囲外表記は文字列入力", () => {
    expect(inspectorControlFor("DATE", "2024-01-02")).toEqual({
      kind: "native",
      inputType: "date",
    });
    expect(inspectorControlFor("DATETIME", "2024-01-02 10:00:00")).toEqual({
      kind: "native",
      inputType: "datetime-local",
    });
    expect(inspectorControlFor("TIME", "838:59:59")).toEqual({ kind: "text" });
  });

  it("真偽値は初期値の表記に合わせたセレクタ、表記が合わなければ文字列入力", () => {
    expect(inspectorControlFor("BOOLEAN", true)).toEqual({
      kind: "bool",
      options: ["true", "false", "NULL"],
    });
    expect(inspectorControlFor("BOOL", "1")).toEqual({
      kind: "bool",
      options: ["1", "0", "NULL"],
    });
    expect(inspectorControlFor("BOOLEAN", "TRUE")).toEqual({ kind: "text" });
  });

  it("NULL の初期値でも型に応じたコントロールを選ぶ", () => {
    expect(inspectorControlFor("DATE", null)).toEqual({ kind: "native", inputType: "date" });
    expect(inspectorControlFor("VARCHAR", null)).toEqual({ kind: "text" });
  });

  it("長文型・改行を含む値は複数行欄にする (1 行入力は改行を落とすため)", () => {
    expect(inspectorControlFor("TEXT", "a")).toEqual({ kind: "textarea" });
    expect(inspectorControlFor("JSONB", "{}")).toEqual({ kind: "textarea" });
    expect(inspectorControlFor("VARCHAR", "line1\nline2")).toEqual({ kind: "textarea" });
    expect(inspectorControlFor("VARCHAR", "plain")).toEqual({ kind: "text" });
  });
});

describe("rowChangedSince", () => {
  it("同じ値なら false、どれか 1 セルでも違えば true", () => {
    expect(rowChangedSince([1, "a", null], [1, "a", null], 3)).toBe(false);
    expect(rowChangedSince([1, "a", null], [1, "b", null], 3)).toBe(true);
    expect(rowChangedSince([1, "a", null], [1, "a", "x"], 3)).toBe(true);
  });

  it("NULL と文字列 \"NULL\" は別の値として区別する", () => {
    expect(rowChangedSince([null], ["NULL"], 1)).toBe(true);
  });
});

describe("collectInspectorEdits", () => {
  const columns: Column[] = [
    { name: "id", type_name: "INT" },
    { name: "name", type_name: "VARCHAR" },
    { name: "age", type_name: "INT" },
    { name: "bio", type_name: "TEXT" },
  ];
  const base: CellValue[] = [1, "alice", 30, null];
  const editable = [false, true, true, true];

  // 編集開始時の下書きは draftFromRow(base) と同じ。テストではそれを initial として渡す。
  const run = (
    over: {
      draft?: Record<number, string>;
      base?: CellValue[];
      cols?: Column[];
      editableFlags?: boolean[];
    } = {},
  ) => {
    const cols = over.cols ?? columns;
    const b = over.base ?? base;
    const initial = draftFromRow(b, cols.length);
    return collectInspectorEdits({
      columns: cols,
      base: b,
      initial,
      draft: over.draft ?? initial,
      editable: over.editableFlags ?? editable,
      validate: validate(cols),
    });
  };

  it("変わった編集可能な列だけを生の入力値で返す (PK・未変更・NULL の再入力は含めない)", () => {
    const res = run({ draft: { 0: "2", 1: "alice", 2: "31", 3: "NULL" } });
    expect(res).toEqual({ edits: { 2: "31" }, errors: {} });
  });

  it("編集不可の列は下書きに値があっても送らない", () => {
    const res = run({
      draft: { 0: "99", 1: "alice", 2: "30", 3: "NULL" },
      editableFlags: [false, false, false, false],
    });
    expect(res).toEqual({ edits: {}, errors: {} });
  });

  it("検証に落ちた列は edits に入れず errors に積む", () => {
    const res = run({ draft: { 0: "1", 1: "alice", 2: "abc", 3: "NULL" } });
    expect(res.edits).toEqual({});
    expect(res.errors).toEqual({ 2: "editInvalidNumber" });
  });

  it("NOT NULL の列に NULL を入れると検証エラーになる", () => {
    const notNull: Column[] = [{ name: "name", type_name: "VARCHAR" }];
    const res = collectInspectorEdits({
      columns: notNull,
      base: ["alice"],
      initial: { 0: "alice" },
      draft: { 0: "NULL" },
      editable: [true],
      validate: (ci, raw) => validateCellInput(raw, notNull[ci].type_name, false),
    });
    expect(res.errors).toEqual({ 0: "editInvalidNotNull" });
  });

  it("空欄の文字列列は NULL ではなく空文字の編集になる", () => {
    const res = run({ draft: { 0: "1", 1: "alice", 2: "30", 3: "" } });
    expect(res.edits).toEqual({ 3: "" });
  });

  it("64bit 整数は文字列のまま比較し、1 だけ違う値でも差分として拾う", () => {
    const big: Column[] = [{ name: "id", type_name: "BIGINT" }];
    const same = run({ cols: big, base: ["9007199254740993"], editableFlags: [true], draft: { 0: "9007199254740993" } });
    expect(same.edits).toEqual({});
    const diff = run({ cols: big, base: ["9007199254740993"], editableFlags: [true], draft: { 0: "9007199254740994" } });
    expect(diff.edits).toEqual({ 0: "9007199254740994" });
  });

  it("真偽値は表記が変わっただけ (true と 1) なら差分にしない", () => {
    const bool: Column[] = [{ name: "flag", type_name: "BOOLEAN" }];
    const same = run({ cols: bool, base: [true], editableFlags: [true], draft: { 0: "1" } });
    expect(same.edits).toEqual({});
    const diff = run({ cols: bool, base: [true], editableFlags: [true], draft: { 0: "false" } });
    expect(diff.edits).toEqual({ 0: "false" });
  });

  it("文字列 \"NULL\" を持つ未編集列は SQL NULL に化けず、差分に入らない", () => {
    const cols: Column[] = [
      { name: "code", type_name: "VARCHAR" },
      { name: "age", type_name: "INT" },
    ];
    // code の値は文字列 "NULL"。ユーザは age だけ変える。
    const res = run({ cols, base: ["NULL", 5], editableFlags: [true, true], draft: { 0: "NULL", 1: "6" } });
    expect(res).toEqual({ edits: { 1: "6" }, errors: {} });
  });

  it("文字列 \"null\" の列でも未操作なら差分を作らない", () => {
    const cols: Column[] = [{ name: "code", type_name: "VARCHAR" }];
    const res = run({ cols, base: ["null"], editableFlags: [true] });
    expect(res.edits).toEqual({});
  });

  it("一度変えて元の下書きに戻した列は差分に入らない", () => {
    const res = run({ draft: { 0: "1", 1: "bob", 2: "30", 3: "NULL" } });
    // name を bob にしたが、差分は name だけ (他の未操作列は入らない)
    expect(res.edits).toEqual({ 1: "bob" });
    const reverted = run({ draft: { 0: "1", 1: "alice", 2: "30", 3: "NULL" } });
    expect(reverted.edits).toEqual({});
  });
});
