import { describe, expect, it } from "vitest";
import {
  appendTypeaheadKey,
  computeListboxMove,
  findTypeaheadIndex,
  isTypeaheadKey,
  TYPEAHEAD_RESET_MS,
  type TypeaheadState,
} from "../components/listboxNav";

/**
 * `ListboxSelect` (#1143) のキーボード操作・型入力ジャンプの純ロジック。
 */
describe("computeListboxMove", () => {
  it("候補が 0 件なら常に null", () => {
    expect(computeListboxMove("ArrowDown", null, 0)).toBeNull();
    expect(computeListboxMove("Home", 0, 0)).toBeNull();
  });

  it("Home/End は先頭/末尾へ飛ぶ", () => {
    expect(computeListboxMove("Home", 2, 5)).toBe(0);
    expect(computeListboxMove("End", 2, 5)).toBe(4);
  });

  it("ArrowDown はハイライト無しから先頭 → 末尾でループする", () => {
    expect(computeListboxMove("ArrowDown", null, 3)).toBe(0);
    expect(computeListboxMove("ArrowDown", 0, 3)).toBe(1);
    expect(computeListboxMove("ArrowDown", 2, 3)).toBe(0);
  });

  it("ArrowUp はハイライト無しから末尾 → 先頭でループする", () => {
    expect(computeListboxMove("ArrowUp", null, 3)).toBe(2);
    expect(computeListboxMove("ArrowUp", 2, 3)).toBe(1);
    expect(computeListboxMove("ArrowUp", 0, 3)).toBe(2);
  });
});

describe("appendTypeaheadKey / findTypeaheadIndex", () => {
  const labels = ["id", "name", "email", "created_at"];

  it("タイムアウト内なら文字を積み重ねる", () => {
    let state: TypeaheadState | null = null;
    state = appendTypeaheadKey(state, "n", 1000);
    state = appendTypeaheadKey(state, "a", 1000 + TYPEAHEAD_RESET_MS - 1);
    expect(state.query).toBe("na");
  });

  it("タイムアウトを超えたら新しいバッファとして始める", () => {
    let state: TypeaheadState | null = null;
    state = appendTypeaheadKey(state, "n", 1000);
    state = appendTypeaheadKey(state, "e", 1000 + TYPEAHEAD_RESET_MS + 1);
    expect(state.query).toBe("e");
  });

  it("前方一致するラベルを現在位置の次から探す", () => {
    // "e" は email(2) のみが前方一致する。
    expect(findTypeaheadIndex(labels, "e", null)).toBe(2);
    // 現在位置が email(2) のとき次を探すが、他に一致が無ければ同じ位置に戻る。
    expect(findTypeaheadIndex(labels, "e", 2)).toBe(2);
  });

  it("一致が複数あれば現在位置の次からループして探す", () => {
    const withDup = ["a1", "b1", "a2", "c1"];
    expect(findTypeaheadIndex(withDup, "a", null)).toBe(0);
    expect(findTypeaheadIndex(withDup, "a", 0)).toBe(2);
    // 末尾まで来たら先頭へループする。
    expect(findTypeaheadIndex(withDup, "a", 2)).toBe(0);
  });

  it("一致が無ければ null", () => {
    expect(findTypeaheadIndex(labels, "zzz", null)).toBeNull();
  });

  it("空クエリ・空リストは null", () => {
    expect(findTypeaheadIndex(labels, "", 0)).toBeNull();
    expect(findTypeaheadIndex([], "n", null)).toBeNull();
  });
});

describe("isTypeaheadKey", () => {
  it("修飾キー無しの印字可能な 1 文字だけを対象にする", () => {
    expect(isTypeaheadKey({ key: "n", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isTypeaheadKey({ key: " ", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isTypeaheadKey({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isTypeaheadKey({ key: "n", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });
});
