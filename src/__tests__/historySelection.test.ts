import { describe, expect, it } from "vitest";
import {
  EMPTY_HISTORY_SELECTION,
  pruneHistorySelection,
  selectHistoryRow,
  type HistorySelection,
} from "../components/historySelection";

const order = [10, 9, 8, 7, 6];
const ids = (s: HistorySelection) => [...s.selected].sort((a, b) => a - b);

describe("selectHistoryRow (#1627)", () => {
  it("Ctrl / Cmd クリックは 1 行ずつ入れ替え、起点にする", () => {
    let s = selectHistoryRow(order, EMPTY_HISTORY_SELECTION, 9, "toggle");
    expect(ids(s)).toEqual([9]);
    expect(s.anchor).toBe(9);
    s = selectHistoryRow(order, s, 7, "toggle");
    expect(ids(s)).toEqual([7, 9]);
    s = selectHistoryRow(order, s, 9, "toggle");
    expect(ids(s)).toEqual([7]);
  });

  it("Shift クリックは起点から押した行までを (上下どちら向きでも) 加える", () => {
    let s = selectHistoryRow(order, EMPTY_HISTORY_SELECTION, 9, "toggle");
    s = selectHistoryRow(order, s, 7, "range");
    expect(ids(s)).toEqual([7, 8, 9]);
    expect(s.anchor).toBe(9);
    s = selectHistoryRow(order, s, 10, "range");
    expect(ids(s)).toEqual([7, 8, 9, 10]);
  });

  it("起点が無い・画面に無いときの Shift クリックはその行だけ", () => {
    const s = selectHistoryRow(order, EMPTY_HISTORY_SELECTION, 8, "range");
    expect(ids(s)).toEqual([8]);
    expect(s.anchor).toBe(8);
    const gone = selectHistoryRow(order, { selected: new Set([99]), anchor: 99 }, 8, "range");
    expect(ids(gone)).toEqual([8, 99]);
    expect(gone.anchor).toBe(8);
  });

  it("入力の選択集合は書き換えない", () => {
    const base: HistorySelection = { selected: new Set([9]), anchor: 9 };
    selectHistoryRow(order, base, 7, "range");
    expect([...base.selected]).toEqual([9]);
  });
});

describe("pruneHistorySelection (#1627)", () => {
  it("画面から消えた行を外し、起点も無効にする", () => {
    const s: HistorySelection = { selected: new Set([9, 5]), anchor: 5 };
    const p = pruneHistorySelection(s, order);
    expect(ids(p)).toEqual([9]);
    expect(p.anchor).toBeNull();
  });
  it("変化が無ければ同じ参照を返す", () => {
    const s: HistorySelection = { selected: new Set([9]), anchor: 9 };
    expect(pruneHistorySelection(s, order)).toBe(s);
    expect(pruneHistorySelection(EMPTY_HISTORY_SELECTION, order)).toBe(EMPTY_HISTORY_SELECTION);
  });
});
