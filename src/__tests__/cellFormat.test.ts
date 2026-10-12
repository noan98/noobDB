import { describe, expect, it } from "vitest";
import {
  enumBadgeHue,
  formatDateTimeDisplay,
  formatJsonCompact,
  JSON_COMPACT_MAX_CHARS,
  rawValueTitle,
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

  it("上限を超える長さの JSON は整形せず null (素の値へフォールバック)", () => {
    const big = `[${"1, ".repeat(JSON_COMPACT_MAX_CHARS)}1]`;
    expect(big.length).toBeGreaterThan(JSON_COMPACT_MAX_CHARS);
    expect(formatJsonCompact(big)).toBeNull();
  });

  it("同じ入力を繰り返しても結果が変わらない (キャッシュ経由でも null / 整形結果を保つ)", () => {
    for (let i = 0; i < 3; i++) {
      expect(formatJsonCompact('{ "k": [1, 2] }')).toBe('{"k":[1,2]}');
      expect(formatJsonCompact("{ broken")).toBeNull();
    }
  });

  it("キャッシュ件数を超えて押し出された値も、再計算して同じ結果を返す", () => {
    for (let i = 0; i < 600; i++) formatJsonCompact(`{ "n": ${i} }`);
    expect(formatJsonCompact('{ "n": 0 }')).toBe('{"n":0}');
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

describe("rawValueTitle (#647)", () => {
  it("表示が元値と同じなら title を出さない (undefined)", () => {
    expect(rawValueTitle("123", "123")).toBeUndefined();
    expect(rawValueTitle("", "")).toBeUndefined();
  });

  it("表示が元値と異なるときだけ元値を返す (例: 桁区切り整形で情報が変わる場合)", () => {
    // "007" → Number() → 桁区切り整形で "7" になり先頭ゼロの情報が失われるケース。
    expect(rawValueTitle("007", "7")).toBe("007");
    expect(rawValueTitle("1234567", "1,234,567")).toBe("1234567");
  });
});
