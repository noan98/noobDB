import { describe, expect, it } from "vitest";
import { touchKeepAlive } from "../components/keepAliveSet";

describe("touchKeepAlive (#1311)", () => {
  it("新しいキーを最新として末尾に足す", () => {
    expect(touchKeepAlive([], "a", 3)).toEqual(["a"]);
    expect(touchKeepAlive(["a"], "b", 3)).toEqual(["a", "b"]);
  });

  it("既にあるキーは最新へ移し、増やさない", () => {
    expect(touchKeepAlive(["a", "b", "c"], "a", 3)).toEqual(["b", "c", "a"]);
  });

  it("すでに最新なら同じ配列を返す (レンダー中の setState が収束する)", () => {
    const keys = ["a", "b"];
    expect(touchKeepAlive(keys, "b", 3)).toBe(keys);
  });

  it("active が null なら何も変えない", () => {
    const keys = ["a", "b"];
    expect(touchKeepAlive(keys, null, 3)).toBe(keys);
  });

  it("上限を超えたら最も長く使われていないものから捨て、アクティブは残す", () => {
    expect(touchKeepAlive(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
    expect(touchKeepAlive(["a", "b", "c"], "d", 1)).toEqual(["d"]);
    // 上限 0 以下でも 1 つは残す。
    expect(touchKeepAlive([], "x", 0)).toEqual(["x"]);
  });
});
