import { describe, expect, it } from "vitest";
import type { Column } from "../api/tauri";
import { rowEditKey, type PendingEdits } from "../components/cellEdit";
import { tabStateAfterApply, type ApplyTabState } from "../components/editApplyState";

// 一括適用成功後のタブ状態遷移 (#1394 で行スコープを追加)。全体適用の従来挙動が変わらないこと
// と、行スコープ適用で他の保留 (他行の編集・削除予定・新規行・履歴) が残ることを固定する。

const COLS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
];
const ROWS = [
  [1, "alice"],
  [2, "bob"],
  [3, "carol"],
];
const PK = [0];
const key1 = rowEditKey(ROWS[0], PK, 0);
const key2 = rowEditKey(ROWS[1], PK, 1);
const key3 = rowEditKey(ROWS[2], PK, 2);

type TestTab = ApplyTabState & { result: { columns: Column[]; rows: typeof ROWS; rows_affected: number } | null };

function baseTab(over: Partial<TestTab> = {}): TestTab {
  const pendingEdits: PendingEdits = {
    [key1]: { 1: "ALICE" },
    [key2]: { 1: "BOB" },
  };
  return {
    result: { columns: COLS, rows: ROWS, rows_affected: ROWS.length },
    pendingEdits,
    pendingDeletes: [key3],
    pendingInserts: [{ 1: "dave" }],
    editUndoStack: [{ [key2]: { 1: "x" } }],
    editRedoStack: [{ [key3]: { 1: "y" } }],
    ...over,
  };
}

describe("tabStateAfterApply: 全体適用 (従来どおり)", () => {
  it("送った編集は消え、削除予定・新規行・履歴はすべて空になる", () => {
    const tt = baseTab();
    const out = tabStateAfterApply(tt, {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" }, [key2]: { 1: "BOB" } },
      scoped: false,
    });
    expect(out.pendingEdits).toEqual({});
    expect(out.pendingDeletes).toEqual([]);
    expect(out.pendingInserts).toEqual([]);
    expect(out.editUndoStack).toEqual([]);
    expect(out.editRedoStack).toEqual([]);
  });

  it("送った行は結果に反映され、削除予定の行は表示から消える", () => {
    const tt = baseTab();
    const out = tabStateAfterApply(tt, {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: false,
    });
    // key3 (削除予定) は deleteKeys として渡されるので結果から除かれる
    expect(out.result?.rows).toEqual([
      [1, "ALICE"],
      [2, "bob"],
    ]);
    expect(out.result?.rows_affected).toBe(2);
  });

  it("結果が無い (プレビュー等) なら表示行は触らず、保留編集だけ更新する", () => {
    const tt = baseTab({ result: null });
    const out = tabStateAfterApply(tt, {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: false,
    });
    expect(out.result).toBeNull();
    expect(out.pendingEdits).toEqual({ [key2]: { 1: "BOB" } });
    expect(out.pendingDeletes).toEqual([]);
  });
});

describe("tabStateAfterApply: 行スコープ適用 (行インスペクタ #1394)", () => {
  it("送った行の編集だけ消え、他行の保留編集は残る", () => {
    const out = tabStateAfterApply(baseTab(), {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: true,
    });
    expect(out.pendingEdits).toEqual({ [key2]: { 1: "BOB" } });
  });

  it("削除予定・新規行は残り、削除予定の行は表示から消さない", () => {
    const out = tabStateAfterApply(baseTab(), {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: true,
    });
    expect(out.pendingDeletes).toEqual([key3]);
    expect(out.pendingInserts).toEqual([{ 1: "dave" }]);
    expect(out.result?.rows).toEqual([
      [1, "ALICE"],
      [2, "bob"],
      [3, "carol"],
    ]);
  });

  it("取り消し/やり直し履歴は残る", () => {
    const tt = baseTab();
    const out = tabStateAfterApply(tt, {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: true,
    });
    expect(out.editUndoStack).toEqual(tt.editUndoStack);
    expect(out.editRedoStack).toEqual(tt.editRedoStack);
  });

  it("送信後に同じセルへ書き直された編集は未送信として残す", () => {
    const tt = baseTab({ pendingEdits: { [key1]: { 1: "ALICE-2" } } });
    const out = tabStateAfterApply(tt, {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: true,
    });
    expect(out.pendingEdits).toEqual({ [key1]: { 1: "ALICE-2" } });
  });

  it("結果が無くても、削除予定・新規行・履歴は保つ", () => {
    const tt = baseTab({ result: null });
    const out = tabStateAfterApply(tt, {
      pkIndices: PK,
      sent: { [key1]: { 1: "ALICE" } },
      scoped: true,
    });
    expect(out.result).toBeNull();
    expect(out.pendingDeletes).toEqual([key3]);
    expect(out.pendingInserts).toEqual([{ 1: "dave" }]);
    expect(out.editUndoStack).toEqual(tt.editUndoStack);
  });
});
