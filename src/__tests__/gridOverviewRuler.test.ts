import { describe, expect, it } from "vitest";
import {
  bucketOf,
  buildRowMasks,
  computeRulerTicks,
  countKindsInRange,
  hitTestRuler,
  laneAtX,
  nextMarkedRow,
  RULER_CHANGE_MASK,
  rowSpanToY,
  rulerKindBit,
  yToRow,
} from "../components/gridOverviewRuler";

describe("buildRowMasks", () => {
  it("状態が無ければ null", () => {
    expect(buildRowMasks(10, {})).toBeNull();
    expect(buildRowMasks(0, { find: () => true })).toBeNull();
    expect(buildRowMasks(10, { find: () => false })).toBeNull();
  });
  it("種別ごとのビットを OR する", () => {
    const m = buildRowMasks(4, {
      find: (i) => i === 1,
      edit: (i) => i === 1 || i === 2,
      delete: (i) => i === 2,
    });
    expect(m).not.toBeNull();
    expect(Array.from(m ?? [])).toEqual([
      0,
      rulerKindBit("find") | rulerKindBit("edit"),
      rulerKindBit("edit") | rulerKindBit("delete"),
      0,
    ]);
  });
});

describe("座標変換", () => {
  it("bucketOf / yToRow は範囲内に収まる", () => {
    expect(bucketOf(0, 100, 10)).toBe(0);
    expect(bucketOf(99, 100, 10)).toBe(9);
    expect(yToRow(-5, 100, 10)).toBe(0);
    expect(yToRow(999, 100, 10)).toBe(99);
    expect(yToRow(5, 100, 10)).toBe(50);
    expect(yToRow(1, 0, 10)).toBe(0);
  });
  it("rowSpanToY", () => {
    expect(rowSpanToY(10, 19, 100, 200)).toEqual({ y: 20, h: 20 });
    expect(rowSpanToY(0, 0, 0, 200)).toEqual({ y: 0, h: 0 });
  });
  it("laneAtX", () => {
    expect(laneAtX(0, 12)).toBe(0);
    expect(laneAtX(5, 12)).toBe(1);
    expect(laneAtX(11.9, 12)).toBe(2);
    expect(laneAtX(50, 12)).toBe(2);
  });
});

describe("computeRulerTicks", () => {
  it("行数が帯より少ないと行ごとに高さを持ち、連続行は連結する", () => {
    const m = new Uint8Array(10);
    m[2] = rulerKindBit("find");
    m[3] = rulerKindBit("find");
    const lanes = computeRulerTicks(m, 100, 2);
    expect(lanes[0]).toEqual([{ kind: "find", y: 20, h: 20, count: 2, firstRow: 2, lastRow: 3 }]);
    expect(lanes[1]).toEqual([]);
    expect(lanes[2]).toEqual([]);
  });
  it("同じレーンの重なりは優先度 (削除 > 編集、追加 > 変更) で 1 色に絞る", () => {
    const m = new Uint8Array(1);
    m[0] = rulerKindBit("edit") | rulerKindBit("delete") | rulerKindBit("changed") | rulerKindBit("added");
    const lanes = computeRulerTicks(m, 10, 1);
    expect(lanes[1].map((t) => t.kind)).toEqual(["delete"]);
    expect(lanes[2].map((t) => t.kind)).toEqual(["added"]);
  });
  it("別レーンの状態は並んで残る", () => {
    const m = new Uint8Array(1);
    m[0] = rulerKindBit("find") | rulerKindBit("edit");
    const lanes = computeRulerTicks(m, 10, 1);
    expect(lanes[0]).toHaveLength(1);
    expect(lanes[1]).toHaveLength(1);
  });
  it("1 行だけの小さなマーカーも最小高さで残る", () => {
    const m = new Uint8Array(100000);
    m[50000] = rulerKindBit("edit");
    const lanes = computeRulerTicks(m, 400, 2);
    expect(lanes[1]).toHaveLength(1);
    expect(lanes[1][0].h).toBe(2);
    expect(lanes[1][0].count).toBe(1);
  });
  it("離れたマーカーは別のティックになる", () => {
    const m = new Uint8Array(1000);
    m[0] = rulerKindBit("find");
    m[999] = rulerKindBit("find");
    expect(computeRulerTicks(m, 100, 1)[0]).toHaveLength(2);
  });
  it("高さ 0 や空は空の結果", () => {
    expect(computeRulerTicks(new Uint8Array(5), 0, 1).every((l) => l.length === 0)).toBe(true);
    expect(computeRulerTicks(new Uint8Array(0), 100, 1).every((l) => l.length === 0)).toBe(true);
  });
  it("10 万行 (全行マーカーあり) でも 100ms 未満で計算できる", () => {
    const n = 100000;
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = i % 7 === 0 ? 31 : i % 3 === 0 ? 1 : 0;
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) computeRulerTicks(m, 800, 2);
    expect((performance.now() - t0) / 5).toBeLessThan(100);
  });
});

describe("hitTestRuler", () => {
  it("許容内のティックを返し、離れていれば null", () => {
    const m = new Uint8Array(100);
    m[50] = rulerKindBit("find");
    const lanes = computeRulerTicks(m, 100, 2);
    expect(hitTestRuler(lanes, 0, 51, 1)?.kind).toBe("find");
    expect(hitTestRuler(lanes, 0, 10, 1)).toBeNull();
    expect(hitTestRuler(lanes, 1, 51, 1)).toBeNull();
  });
});

describe("nextMarkedRow", () => {
  const m = new Uint8Array(10);
  m[2] = rulerKindBit("edit");
  m[7] = rulerKindBit("delete");
  m[5] = rulerKindBit("find");
  it("次 / 前へ辿り、端で折り返す", () => {
    expect(nextMarkedRow(m, 0, 1, RULER_CHANGE_MASK)).toBe(2);
    expect(nextMarkedRow(m, 2, 1, RULER_CHANGE_MASK)).toBe(7);
    expect(nextMarkedRow(m, 7, 1, RULER_CHANGE_MASK)).toBe(2);
    expect(nextMarkedRow(m, 2, -1, RULER_CHANGE_MASK)).toBe(7);
  });
  it("検索ヒットは変更の対象外 / 該当が無ければ null", () => {
    expect(nextMarkedRow(m, 2, 1, RULER_CHANGE_MASK)).not.toBe(5);
    expect(nextMarkedRow(new Uint8Array(5), 0, 1, RULER_CHANGE_MASK)).toBeNull();
    expect(nextMarkedRow(new Uint8Array(0), 0, 1, RULER_CHANGE_MASK)).toBeNull();
  });
  it("該当が 1 行だけなら自分自身を返す", () => {
    const one = new Uint8Array(4);
    one[1] = rulerKindBit("edit");
    expect(nextMarkedRow(one, 1, 1, RULER_CHANGE_MASK)).toBe(1);
  });
});

describe("countKindsInRange", () => {
  it("範囲内の種別ごとの件数", () => {
    const m = new Uint8Array(5);
    m[1] = rulerKindBit("find") | rulerKindBit("edit");
    m[2] = rulerKindBit("find");
    expect(countKindsInRange(m, 0, 10)).toEqual({ find: 2, edit: 1, delete: 0, added: 0, changed: 0 });
    expect(countKindsInRange(m, 2, 2).find).toBe(1);
  });
});
