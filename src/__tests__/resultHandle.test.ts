import { describe, expect, it } from "vitest";
import {
  attachResultHandle,
  HANDLE_SORT_MIN_ROWS,
  isResultGoneError,
  resultHandleFor,
  shouldUseHandleForGrid,
} from "../components/resultHandle";
import { BackendError, type CellValue } from "../api/tauri";

// 結果ハンドル (#1264) の行配列への紐づけ。行配列が入れ替わったら (= JS 側の行と
// バックエンドの保持行がずれたら) ハンドルは見つからなくなり、呼び出し側は JS 経路へ戻る。

function rowsOf(n: number): CellValue[][] {
  return Array.from({ length: n }, (_, i) => [i]);
}

describe("resultHandle", () => {
  it("紐づけた行配列からハンドルを引ける", () => {
    const rows = rowsOf(3);
    attachResultHandle(rows, "qs_1");
    expect(resultHandleFor(rows)).toBe("qs_1");
  });

  it("別の配列 (編集適用・行追加・load-more 後) ではハンドルを返さない", () => {
    const rows = rowsOf(3);
    attachResultHandle(rows, "qs_1");
    expect(resultHandleFor(rows.slice())).toBeNull();
    expect(resultHandleFor(rows.concat([[9]]))).toBeNull();
  });

  it("同じ配列でも行数が変わっていたら (直接 push された等) 返さない", () => {
    const rows = rowsOf(3);
    attachResultHandle(rows, "qs_1");
    rows.push([4]);
    expect(resultHandleFor(rows)).toBeNull();
  });

  it("ID が無い / 配列が無いときは紐づけない", () => {
    const rows = rowsOf(2);
    attachResultHandle(rows, null);
    attachResultHandle(rows, undefined);
    expect(resultHandleFor(rows)).toBeNull();
    expect(resultHandleFor(null)).toBeNull();
    expect(resultHandleFor(undefined)).toBeNull();
  });

  it("グリッドでの利用は行数しきい値以上に限る", () => {
    const small = rowsOf(HANDLE_SORT_MIN_ROWS - 1);
    attachResultHandle(small, "qs_small");
    expect(shouldUseHandleForGrid(small)).toBeNull();
    const big = rowsOf(HANDLE_SORT_MIN_ROWS);
    attachResultHandle(big, "qs_big");
    expect(shouldUseHandleForGrid(big)).toBe("qs_big");
    expect(shouldUseHandleForGrid(rowsOf(HANDLE_SORT_MIN_ROWS))).toBeNull();
  });

  it("isResultGoneError はバックエンドの破棄済みエラーだけを見分ける", () => {
    expect(isResultGoneError(new BackendError("invalidInput", "invalid input: result handle gone: qs_1"))).toBe(true);
    expect(isResultGoneError(new Error("result handle gone"))).toBe(true);
    expect(isResultGoneError("result handle gone: x")).toBe(true);
    expect(isResultGoneError(new BackendError("io", "disk full"))).toBe(false);
    expect(isResultGoneError(undefined)).toBe(false);
  });
});
