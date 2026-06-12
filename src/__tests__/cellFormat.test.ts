import { describe, expect, it } from "vitest";
import {
  enumBadgeHue,
  formatDateTimeDisplay,
  formatJsonCompact,
} from "../components/cellFormat";

// 結果グリッドのセル値リッチ表示を支える純ロジックのテスト。整形は表示専用で
// 元の値はコピー/編集/エクスポートで保持する前提のため、ここでは「整形結果が期待通りか」
// と「整形不能な入力では null を返して素の値へフォールバックできるか」を検証する。

describe("formatJsonCompact", () => {
  it("空白を畳んだコンパクト表現に正規化する", () => {
    expect(formatJsonCompact('{ "a": 1,  "b": 2 }')).toBe('{"a":1,"b":2}');
    expect(formatJsonCompact("[ 1, 2, 3 ]")).toBe("[1,2,3]");
  });

  it("ネストした構造も 1 行に畳む", () => {
    expect(formatJsonCompact('{\n  "x": { "y": [1, 2] }\n}')).toBe('{"x":{"y":[1,2]}}');
  });

  it("JSON でない文字列は null を返す", () => {
    expect(formatJsonCompact("hello")).toBeNull();
    expect(formatJsonCompact("123")).toBeNull();
    expect(formatJsonCompact("")).toBeNull();
  });

  it("オブジェクト/配列で始まるが不正な JSON は null を返す", () => {
    expect(formatJsonCompact("{ broken")).toBeNull();
    expect(formatJsonCompact("[1, 2,")).toBeNull();
  });
});

describe("formatDateTimeDisplay", () => {
  it("日付のみをロケールに応じて整形する (タイムゾーン変換なし)", () => {
    // en では月名 + 日 + 年、ja では年月日。いずれも壁時計の数値は維持される。
    expect(formatDateTimeDisplay("2026-06-01", "en")).toBe("Jun 1, 2026");
    expect(formatDateTimeDisplay("2026-06-01", "ja")).toContain("2026");
    expect(formatDateTimeDisplay("2026-06-01", "ja")).toContain("6");
  });

  it("日時を整形し、時刻もそのまま表示する (UTC ピン留めでずれない)", () => {
    const out = formatDateTimeDisplay("2026-06-01 13:45:09", "en");
    expect(out).toContain("2026");
    expect(out).toContain("13:45:09");
  });

  it("ISO 区切り (T) と末尾 Z / オフセットを受理する", () => {
    expect(formatDateTimeDisplay("2026-06-01T13:45:09Z", "en")).toContain("13:45:09");
    expect(formatDateTimeDisplay("2026-06-01T13:45:09+09:00", "en")).toContain("13:45:09");
  });

  it("小数秒を読み飛ばす", () => {
    expect(formatDateTimeDisplay("2026-06-01 13:45:09.123456", "en")).toContain("13:45:09");
  });

  it("日付として解析できない文字列は null を返す", () => {
    expect(formatDateTimeDisplay("not a date", "en")).toBeNull();
    expect(formatDateTimeDisplay("12:00:00", "en")).toBeNull();
    expect(formatDateTimeDisplay("", "en")).toBeNull();
  });

  it("暦として不正な日付は null を返す (ロールオーバーを弾く)", () => {
    expect(formatDateTimeDisplay("2026-02-31", "en")).toBeNull();
    expect(formatDateTimeDisplay("2026-13-01", "en")).toBeNull();
    expect(formatDateTimeDisplay("2026-06-01 25:00:00", "en")).toBeNull();
  });
});

describe("enumBadgeHue", () => {
  it("0–359 の範囲の色相を返す", () => {
    for (const s of ["active", "pending", "", "x", "とても長い列挙値"]) {
      const h = enumBadgeHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("同じ値には同じ色相を割り当てる (決定的)", () => {
    expect(enumBadgeHue("shipped")).toBe(enumBadgeHue("shipped"));
  });

  it("異なる値はおおむね異なる色相になる", () => {
    expect(enumBadgeHue("active")).not.toBe(enumBadgeHue("inactive"));
  });
});
