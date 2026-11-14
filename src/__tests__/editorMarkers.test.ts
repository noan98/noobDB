import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { type EditorMarker, mapMarkers, markerAt, rangeTouched } from "../components/editorMarkers";

const mk = (from: number, to: number): EditorMarker => ({ from, to, kind: "error" });
const ins = (at: number, text: string, len = 20) => ChangeSet.of({ from: at, insert: text }, len);
const del = (from: number, to: number, len = 20) => ChangeSet.of({ from, to }, len);

describe("editorMarkers (#2330)", () => {
  it("手前の編集では位置が追従し、消えない", () => {
    const out = mapMarkers([mk(10, 13)], ins(2, "abc"), true);
    expect(out).toEqual([{ from: 13, to: 16, kind: "error" }]);
  });
  it("範囲の内側を編集すると dropOnEdit で消える", () => {
    expect(mapMarkers([mk(10, 13)], ins(11, "x"), true)).toEqual([]);
    expect(mapMarkers([mk(10, 13)], del(11, 12), true)).toEqual([]);
    expect(mapMarkers([mk(10, 13)], del(9, 11), true)).toEqual([]);
  });
  it("端への挿入は触ったと扱い、手前・後ろの編集では消えない", () => {
    expect(mapMarkers([mk(10, 13)], ins(10, "x"), true)).toHaveLength(0);
    expect(mapMarkers([mk(10, 13)], ins(13, "x"), true)).toHaveLength(0);
    expect(mapMarkers([mk(10, 13)], ins(9, "x"), true)).toHaveLength(1);
    expect(mapMarkers([mk(10, 13)], ins(14, "x"), true)).toHaveLength(1);
    expect(mapMarkers([mk(10, 13)], ins(15, "x"), true)).toEqual([{ from: 10, to: 13, kind: "error" }]);
  });
  it("dropOnEdit=false なら範囲内の編集でも残る", () => {
    expect(mapMarkers([mk(10, 13)], ins(11, "xy"), false)).toEqual([{ from: 10, to: 15, kind: "error" }]);
  });
  it("rangeTouched", () => {
    expect(rangeTouched(5, 8, del(0, 5))).toBe(false);
    expect(rangeTouched(5, 8, del(7, 9))).toBe(true);
  });
  it("markerAt は範囲内だけを返す", () => {
    const list = [mk(2, 4), mk(8, 8)];
    expect(markerAt(list, 3)).toBe(list[0]);
    expect(markerAt(list, 4)).toBeNull();
    expect(markerAt(list, 4, -1)).toBe(list[0]);
    expect(markerAt(list, 8)).toBe(list[1]);
  });

  it("onEdit: stale は範囲を触った編集で stale を立てて残し、位置も追従する", () => {
    expect(mapMarkers([mk(10, 13)], ins(11, "xy"), "stale")).toEqual([
      { from: 10, to: 15, kind: "error", stale: true },
    ]);
    expect(mapMarkers([mk(10, 13)], ins(2, "ab"), "stale")).toEqual([{ from: 12, to: 15, kind: "error" }]);
    // いったん stale になったものは、その後の無関係な編集でも stale のまま
    const once = mapMarkers([mk(10, 13)], ins(11, "x"), "stale");
    expect(mapMarkers(once, ins(0, "z"), "stale")[0]?.stale).toBe(true);
  });
  it("onEdit: stale は端への純粋な挿入では古い扱いにしない (drop は従来どおり触った扱い)", () => {
    expect(mapMarkers([mk(10, 13)], ins(10, "x"), "stale")).toEqual([{ from: 11, to: 14, kind: "error" }]);
    expect(mapMarkers([mk(10, 13)], ins(13, "x"), "stale")).toEqual([{ from: 10, to: 13, kind: "error" }]);
    expect(mapMarkers([mk(10, 13)], ins(10, "x"), "drop")).toEqual([]);
    expect(mapMarkers([mk(10, 13)], del(12, 14), "stale")[0]?.stale).toBe(true);
  });
  it("onEdit: keep は触っても stale を立てない", () => {
    expect(mapMarkers([mk(10, 13)], ins(11, "xy"), "keep")).toEqual([{ from: 10, to: 15, kind: "error" }]);
  });
});
