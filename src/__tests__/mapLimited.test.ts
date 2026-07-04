import { describe, expect, it } from "vitest";
import { mapLimited } from "../components/mapLimited";

describe("mapLimited", () => {
  it("結果の順序は items と一致する", async () => {
    const out = await mapLimited([3, 1, 2], 2, async (n) => n * 10);
    expect(out).toEqual([30, 10, 20]);
  });

  it("limit が 0 以下でも全要素を処理する (undefined 埋めで黙って返さない)", async () => {
    expect(await mapLimited([1, 2, 3], 0, async (n) => n + 1)).toEqual([2, 3, 4]);
    expect(await mapLimited([1, 2], -5, async (n) => n + 1)).toEqual([2, 3]);
  });

  it("空配列は空配列を返す", async () => {
    expect(await mapLimited([], 8, async (n) => n)).toEqual([]);
  });

  it("同時実行数が limit を超えない", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimited([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
