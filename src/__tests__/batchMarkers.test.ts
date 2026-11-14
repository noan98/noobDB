import { describe, expect, it } from "vitest";
import {
  batchRanges,
  batchStatuses,
  composeBatchGroup,
  formatElapsed,
  locateScript,
  type BatchMarkerData,
} from "../components/batchMarkers";
import type { EditorMarker } from "../components/editorMarkers";

describe("batchMarkers (#2331)", () => {
  it("batchRanges は文ごとの範囲に基準オフセットを足す", () => {
    const script = "SELECT 1;\n  SELECT 2;";
    const r = batchRanges(script, 0);
    expect(r.map((x) => script.slice(x.from, x.to))).toEqual(["SELECT 1", "SELECT 2"]);
    const shifted = batchRanges(script, 100);
    expect(shifted).toEqual(r.map((x) => ({ from: x.from + 100, to: x.to + 100 })));
  });

  it("locateScript は全文実行なら出現位置、選択実行なら選択の位置を返す", () => {
    const doc = "SELECT 1;\nSELECT 2;\n\nSELECT 1;\nSELECT 2;";
    const script = "SELECT 1;\nSELECT 2;";
    expect(locateScript(doc, script)).toBe(0);
    const second = doc.lastIndexOf("SELECT 1;");
    expect(locateScript(doc, script, { from: second, to: doc.length })).toBe(second);
    // 選択に前後の空白があっても、スクリプトの先頭位置に揃う (トリム済みのスクリプトを渡す場合)
    expect(locateScript(doc, script, { from: second - 1, to: doc.length })).toBe(second);
    expect(locateScript(doc, "nope")).toBe(-1);
    expect(locateScript(doc, "")).toBe(-1);
  });

  it("選択実行でも各文の範囲が本文上の位置と一致する", () => {
    const doc = "-- head\nSELECT 0;\nUPDATE t SET a = 1;\nDELETE FROM t;";
    const from = doc.indexOf("UPDATE");
    const script = doc.slice(from);
    const at = locateScript(doc, script, { from, to: doc.length });
    const ranges = batchRanges(script, at);
    expect(ranges.map((r) => doc.slice(r.from, r.to))).toEqual(["UPDATE t SET a = 1", "DELETE FROM t"]);
  });

  it("batchStatuses: 実行中は先頭の未着手が running、残りは pending", () => {
    const s = batchStatuses(5, [{ status: "ok", elapsedMs: 3 }], true);
    expect(s.map((x) => x.status)).toEqual(["ok", "running", "pending", "pending", "pending"]);
    expect(s[0]?.elapsedMs).toBe(3);
  });

  it("batchStatuses: 3 文目で失敗して停止したら 4・5 文目は skipped (未実行)", () => {
    const s = batchStatuses(
      5,
      [{ status: "ok" }, { status: "ok" }, { status: "error" }, { status: "skipped" }, { status: "skipped" }],
      false,
    );
    expect(s.map((x) => x.status)).toEqual(["ok", "ok", "error", "skipped", "skipped"]);
  });

  it("batchStatuses: 結果が届かないまま実行が終わった文 (取消) は skipped", () => {
    expect(batchStatuses(3, [{ status: "ok" }], false).map((x) => x.status)).toEqual([
      "ok",
      "skipped",
      "skipped",
    ]);
  });

  it("composeBatchGroup は最も重い状態を返す", () => {
    const mk = (status: BatchMarkerData["status"], index: number): EditorMarker<BatchMarkerData> => ({
      from: 0,
      to: 1,
      kind: status,
      data: { index, status },
    });
    expect(composeBatchGroup([mk("ok", 0), mk("error", 1), mk("pending", 2)]).data?.index).toBe(1);
    expect(composeBatchGroup([mk("ok", 0), mk("running", 1)]).data?.index).toBe(1);
    expect(composeBatchGroup([mk("ok", 0), mk("ok", 1)]).data?.index).toBe(0);
    expect(composeBatchGroup([mk("skipped", 0), mk("ok", 1)]).data?.index).toBe(1);
  });

  it("formatElapsed", () => {
    expect(formatElapsed(12)).toBe("12ms");
    expect(formatElapsed(1234)).toBe("1.2s");
    expect(formatElapsed(15000)).toBe("15s");
  });
});
