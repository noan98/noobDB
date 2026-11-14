import { describe, expect, it } from "vitest";
import {
  batchRanges,
  batchStatuses,
  isTxControlStatement,
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
    expect(shifted).toEqual(r.map((x) => ({ ...x, from: x.from + 100, to: x.to + 100 })));
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

  const texts = ["SELECT 1", "SELECT 2", "BROKEN", "SELECT 4", "SELECT 5"];
  const res = (sql: string, status: "ok" | "error" | "skipped", elapsedMs?: number) => ({
    sql,
    status,
    elapsedMs,
  });

  it("batchStatuses: 実行中は先頭の未着手が running、残りは pending", () => {
    const s = batchStatuses(texts, [res("SELECT 1", "ok", 3)], true);
    expect(s.map((x) => x.status)).toEqual(["ok", "running", "pending", "pending", "pending"]);
    expect(s[0]?.elapsedMs).toBe(3);
  });

  it("batchStatuses: 3 文目で失敗して停止したら 4・5 文目は skipped (未実行)", () => {
    const s = batchStatuses(
      texts,
      [
        res("SELECT 1", "ok"),
        res("SELECT 2", "ok"),
        res("BROKEN", "error"),
        res("SELECT 4", "skipped"),
        res("SELECT 5", "skipped"),
      ],
      false,
    );
    expect(s.map((x) => x.status)).toEqual(["ok", "ok", "error", "skipped", "skipped"]);
  });

  it("batchStatuses: 結果が届かないまま終わった (取消・切断) 文は、先頭の 1 件だけ interrupted、残りは skipped", () => {
    expect(batchStatuses(texts.slice(0, 3), [res("SELECT 1", "ok")], false).map((x) => x.status)).toEqual([
      "ok",
      "interrupted",
      "skipped",
    ]);
  });

  it("batchStatuses: 全体を 1 トランザクションで包む実行では、読み飛ばされた BEGIN / COMMIT を none にして番号を合わせる", () => {
    const t = ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT", "SELECT 1"];
    const s = batchStatuses(
      t,
      [res("INSERT INTO t VALUES (1)", "ok", 5), res("SELECT 1", "ok", 2)],
      false,
      true,
    );
    expect(s.map((x) => x.status)).toEqual(["none", "ok", "none", "ok"]);
    expect(s.map((x) => x.index)).toEqual([-1, 0, -1, 1]);
    // 末尾の COMMIT は、実行が終わっていても未実行・中断扱いにしない
    expect(
      batchStatuses(
        ["INSERT INTO t VALUES (1)", "COMMIT"],
        [res("INSERT INTO t VALUES (1)", "ok")],
        false,
        true,
      ).map((x) => x.status),
    ).toEqual(["ok", "none"]);
    // 途中経過: INSERT の結果が来る前は、BEGIN は none、INSERT が running
    expect(batchStatuses(t, [], true, true).map((x) => x.status)).toEqual([
      "none",
      "running",
      "none",
      "pending",
    ]);
  });

  it("batchStatuses: 制御文の結果が届く実行 (ラップ無し) では制御文も ok で出る", () => {
    const t = ["BEGIN", "SELECT 1", "COMMIT"];
    const s = batchStatuses(t, [res("BEGIN", "ok"), res("SELECT 1", "ok"), res("COMMIT", "ok")], false);
    expect(s.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("batchStatuses: ラップ無しの途中経過では BEGIN から running が付き、制御文も通常の文として進む", () => {
    const t = ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT", "SELECT 1"];
    expect(batchStatuses(t, [], true).map((x) => x.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
    ]);
    const two = [res("BEGIN", "ok"), res("INSERT INTO t VALUES (1)", "ok")];
    expect(batchStatuses(t, two, true).map((x) => x.status)).toEqual(["ok", "ok", "running", "pending"]);
  });

  it("batchStatuses: ラップ無しで取り消した後、届いていない COMMIT は interrupted / skipped になる", () => {
    const t = ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"];
    const s = batchStatuses(t, [res("BEGIN", "ok"), res("INSERT INTO t VALUES (1)", "ok")], false);
    expect(s.map((x) => x.status)).toEqual(["ok", "ok", "interrupted"]);
    const s2 = batchStatuses(t, [res("BEGIN", "ok")], false);
    expect(s2.map((x) => x.status)).toEqual(["ok", "interrupted", "skipped"]);
  });

  it("isTxControlStatement はコメントを除いて判定し、ROLLBACK TO は制御文にしない", () => {
    expect(isTxControlStatement("-- c\nBEGIN")).toBe(true);
    expect(isTxControlStatement("start transaction read only")).toBe(true);
    expect(isTxControlStatement("ROLLBACK TO sp1")).toBe(false);
    expect(isTxControlStatement("SELECT 1")).toBe(false);
  });

  it("batchRanges は MySQL の # コメントも読み飛ばす", () => {
    const script = "# note\nSELECT 1";
    const r = batchRanges(script, 0, "mysql");
    expect(script.slice(r[0]!.from, r[0]!.to)).toBe("SELECT 1");
  });

  it("batchRanges は文頭のコメントを飛ばした位置を from にし、text は全文のまま", () => {
    const script = "-- note\nSELECT 1;\n/* x */ SELECT 2";
    const r = batchRanges(script, 10);
    expect(script.slice(r[0]!.from - 10, r[0]!.to - 10)).toBe("SELECT 1");
    expect(r[0]?.text).toBe("-- note\nSELECT 1");
    expect(script.slice(r[1]!.from - 10, r[1]!.to - 10)).toBe("SELECT 2");
  });

  it("composeBatchGroup は最も重い状態を返す", () => {
    const mk = (status: BatchMarkerData["status"], index: number): EditorMarker<BatchMarkerData> => ({
      from: 0,
      to: 1,
      kind: status,
      data: { index, status, text: "" },
    });
    expect(composeBatchGroup([mk("ok", 0), mk("error", 1), mk("pending", 2)]).data?.index).toBe(1);
    expect(composeBatchGroup([mk("ok", 0), mk("running", 1)]).data?.index).toBe(1);
    expect(composeBatchGroup([mk("ok", 0), mk("ok", 1)]).data?.index).toBe(0);
    expect(composeBatchGroup([mk("skipped", 0), mk("ok", 1)]).data?.index).toBe(1);
    expect(composeBatchGroup([mk("interrupted", 0), mk("ok", 1)]).data?.index).toBe(0);
  });

  it("formatElapsed", () => {
    expect(formatElapsed(12)).toBe("12ms");
    expect(formatElapsed(1234)).toBe("1.2s");
    expect(formatElapsed(15000)).toBe("15s");
  });
});
