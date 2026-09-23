import { describe, expect, it } from "vitest";
import {
  fromTablePinning,
  pinSideFromTable,
  tablePinPosition,
  toTablePinning,
} from "../components/gridColumnPinning";

// react-table v9 の論理ピン留め (start / end) と、永続化・UI 側の物理方向
// (left / right) の橋渡し (#1115)。保存済みレイアウト (#616) の形を変えないことを固定する。
describe("gridColumnPinning", () => {
  it("物理方向の状態を論理方向へ写し、往復で元に戻る", () => {
    const physical = { left: ["0", "2"], right: ["5"] };
    const table = toTablePinning(physical);
    expect(table).toEqual({ start: ["0", "2"], end: ["5"] });
    expect(fromTablePinning(table)).toEqual(physical);
  });

  it("片側が欠けた部分的な状態は空配列で補う", () => {
    expect(fromTablePinning({ start: ["1"] })).toEqual({ left: ["1"], right: [] });
    expect(fromTablePinning({ end: ["3"] })).toEqual({ left: [], right: ["3"] });
    expect(fromTablePinning({})).toEqual({ left: [], right: [] });
    expect(fromTablePinning(undefined)).toEqual({ left: [], right: [] });
  });

  it("getIsPinned の論理位置を物理方向へ変換する", () => {
    expect(pinSideFromTable("start")).toBe("left");
    expect(pinSideFromTable("end")).toBe("right");
    expect(pinSideFromTable(false)).toBe(false);
  });

  it("UI の左右ピンを column.pin に渡す論理位置へ変換する", () => {
    expect(tablePinPosition("left")).toBe("start");
    expect(tablePinPosition("right")).toBe("end");
    expect(tablePinPosition(false)).toBe(false);
  });
});
