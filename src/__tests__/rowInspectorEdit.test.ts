import { describe, expect, it } from "vitest";
import type { Column } from "../api/tauri";
import { validateCellInput } from "../components/cellEdit";
import {
  collectInspectorEdits,
  draftFromRow,
  inspectorControlFor,
  inspectorEditableColumns,
  inspectorRowEditBlock,
} from "../components/rowInspectorEdit";

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
  it("ブロック要因が無ければ null (編集可)", () => {
    expect(
      inspectorRowEditBlock({ streaming: false, pendingDelete: false, hasPendingEdit: false }),
    ).toBeNull();
  });

  it("読み込み中 > 削除予定 > 保留中のグリッド編集 の順で理由を返す", () => {
    expect(
      inspectorRowEditBlock({ streaming: true, pendingDelete: true, hasPendingEdit: true }),
    ).toBe("rowInspectorEditBlockedStreaming");
    expect(
      inspectorRowEditBlock({ streaming: false, pendingDelete: true, hasPendingEdit: true }),
    ).toBe("rowInspectorEditBlockedDelete");
    expect(
      inspectorRowEditBlock({ streaming: false, pendingDelete: false, hasPendingEdit: true }),
    ).toBe("rowInspectorEditBlockedPending");
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
});

describe("collectInspectorEdits", () => {
  const columns: Column[] = [
    { name: "id", type_name: "INT" },
    { name: "name", type_name: "VARCHAR" },
    { name: "age", type_name: "INT" },
    { name: "bio", type_name: "TEXT" },
  ];
  const values = [1, "alice", 30, null];
  const editable = [false, true, true, true];

  it("変わった編集可能な列だけを生の入力値で返す (PK・未変更・NULL の再入力は含めない)", () => {
    const res = collectInspectorEdits({
      columns,
      values,
      draft: { 0: "2", 1: "alice", 2: "31", 3: "NULL" },
      editable,
      validate: validate(columns),
    });
    expect(res).toEqual({ edits: { 2: "31" }, errors: {} });
  });

  it("編集不可の列は下書きに値があっても送らない", () => {
    const res = collectInspectorEdits({
      columns,
      values,
      draft: { 0: "99", 1: "alice", 2: "30", 3: "NULL" },
      editable: [false, false, false, false],
      validate: validate(columns),
    });
    expect(res).toEqual({ edits: {}, errors: {} });
  });

  it("検証に落ちた列は edits に入れず errors に積む", () => {
    const res = collectInspectorEdits({
      columns,
      values,
      draft: { 0: "1", 1: "alice", 2: "abc", 3: "NULL" },
      editable,
      validate: validate(columns),
    });
    expect(res.edits).toEqual({});
    expect(res.errors).toEqual({ 2: "editInvalidNumber" });
  });

  it("NOT NULL の列に NULL を入れると検証エラーになる", () => {
    const notNull: Column[] = [{ name: "name", type_name: "VARCHAR" }];
    const res = collectInspectorEdits({
      columns: notNull,
      values: ["alice"],
      draft: { 0: "NULL" },
      editable: [true],
      validate: (ci, raw) => validateCellInput(raw, notNull[ci].type_name, false),
    });
    expect(res.errors).toEqual({ 0: "editInvalidNotNull" });
  });

  it("空欄の文字列列は NULL ではなく空文字の編集になる", () => {
    const res = collectInspectorEdits({
      columns,
      values,
      draft: { 0: "1", 1: "alice", 2: "30", 3: "" },
      editable,
      validate: validate(columns),
    });
    expect(res.edits).toEqual({ 3: "" });
  });

  it("64bit 整数は文字列のまま比較し、1 だけ違う値でも差分として拾う", () => {
    const big: Column[] = [{ name: "id", type_name: "BIGINT" }];
    const same = collectInspectorEdits({
      columns: big,
      values: ["9007199254740993"],
      draft: { 0: "9007199254740993" },
      editable: [true],
      validate: validate(big),
    });
    expect(same.edits).toEqual({});
    const diff = collectInspectorEdits({
      columns: big,
      values: ["9007199254740993"],
      draft: { 0: "9007199254740994" },
      editable: [true],
      validate: validate(big),
    });
    expect(diff.edits).toEqual({ 0: "9007199254740994" });
  });

  it("真偽値は表記が変わっただけ (true と 1) なら差分にしない", () => {
    const bool: Column[] = [{ name: "flag", type_name: "BOOLEAN" }];
    const res = collectInspectorEdits({
      columns: bool,
      values: [true],
      draft: { 0: "false" },
      editable: [true],
      validate: validate(bool),
    });
    expect(res.edits).toEqual({ 0: "false" });
  });
});
