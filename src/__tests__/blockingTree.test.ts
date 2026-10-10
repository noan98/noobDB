import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../api/tauri";
import { buildBlockingTree } from "../components/processList";

function proc(id: number, blocked_by: number[] = []): ProcessInfo {
  return {
    id,
    user: null,
    host: null,
    database: null,
    command: null,
    state: null,
    time_secs: null,
    query_summary: null,
    query_truncated: false,
    is_self: false,
    blocked_by,
  };
}

const shape = (ps: ProcessInfo[]) =>
  buildBlockingTree(ps).map((r) => [r.process.id, r.depth, r.isRoot, r.repeated, r.victims]);

describe("buildBlockingTree (#1417)", () => {
  it("待機関係が無ければ空", () => {
    expect(buildBlockingTree([proc(1), proc(2)])).toEqual([]);
  });

  it("チェーン 1 <- 2 <- 3 を深さ優先で並べ、根の victims は間接を含む", () => {
    expect(shape([proc(3, [2]), proc(2, [1]), proc(1)])).toEqual([
      [1, 0, true, false, 2],
      [2, 1, false, false, 1],
      [3, 2, false, false, 0],
    ]);
  });

  it("1 つのブロッカーに複数の待機者がぶら下がる。無関係なプロセスは含まない", () => {
    expect(shape([proc(1), proc(2, [1]), proc(3, [1]), proc(9)])).toEqual([
      [1, 0, true, false, 2],
      [2, 1, false, false, 0],
      [3, 1, false, false, 0],
    ]);
  });

  it("複数ブロッカーに待たされるプロセスは 2 回目を参照行にする", () => {
    expect(shape([proc(1), proc(2), proc(3, [1, 2])])).toEqual([
      [1, 0, true, false, 1],
      [3, 1, false, false, 0],
      [2, 0, true, false, 1],
      [3, 1, false, true, 0],
    ]);
  });

  it("デッドロック (循環) は無限再帰せず、先頭を根にして参照行で閉じる", () => {
    expect(shape([proc(1, [2]), proc(2, [1])])).toEqual([
      [1, 0, true, false, 1],
      [2, 1, false, false, 1],
      [1, 2, false, true, 0],
    ]);
  });

  it("自己参照は無視する", () => {
    expect(buildBlockingTree([proc(1, [1])])).toEqual([]);
  });

  it("一覧に無いブロッカーは kill 不可の外部根として待機者と共に出す", () => {
    const rows = buildBlockingTree([proc(2, [99]), proc(3, [2])]);
    expect(rows.map((r) => [r.process.id, r.depth, r.isRoot, r.external, r.victims])).toEqual([
      [99, 0, true, true, 2],
      [2, 1, false, false, 1],
      [3, 2, false, false, 0],
    ]);
  });

  it("循環の先頭だけ deadlock、通常の根は deadlock ではない", () => {
    const dead = buildBlockingTree([proc(1, [2]), proc(2, [1])]);
    expect(dead.map((r) => r.deadlock)).toEqual([true, false, false]);
    const normal = buildBlockingTree([proc(1), proc(2, [1])]);
    expect(normal.every((r) => !r.deadlock)).toBe(true);
  });

  it("根に繋がる循環外の待機者も循環とは別に扱える", () => {
    // 1 <-> 2 の循環と、そこにぶら下がる 3
    expect(shape([proc(1, [2]), proc(2, [1]), proc(3, [2])]).map((r) => r[0])).toEqual([
      1, 2, 1, 3,
    ]);
  });
});
