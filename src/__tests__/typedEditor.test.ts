import { describe, it, expect } from "vitest";
import {
  boolOptions,
  boolSelectValue,
  fromNativeValue,
  resolveTypedEditor,
  toNativeValue,
} from "../components/typedEditor";

describe("resolveTypedEditor (#1355)", () => {
  it("型ごとにコントロールを出し分ける", () => {
    expect(resolveTypedEditor("DATE", "2024-01-31")).toEqual({ control: "native", inputType: "date" });
    expect(resolveTypedEditor("datetime", "2024-01-31 12:00:00")).toEqual({
      control: "native",
      inputType: "datetime-local",
    });
    expect(resolveTypedEditor("datetime", "2024-01-31T12:00:00")).toEqual({
      control: "native",
      inputType: "datetime-local",
    });
    expect(resolveTypedEditor("TIMESTAMP(6)", "")).toEqual({ control: "native", inputType: "datetime-local" });
    expect(resolveTypedEditor("TIME", "12:30")).toEqual({ control: "native", inputType: "time" });
    expect(resolveTypedEditor("BOOLEAN", "true")).toEqual({ control: "bool" });
    expect(resolveTypedEditor("VARCHAR", "x")).toBeNull();
  });

  it("ネイティブで往復できない値はテキスト入力へフォールバック", () => {
    expect(resolveTypedEditor("TIME", "838:59:59")).toBeNull();
    expect(resolveTypedEditor("TIMESTAMP", "2024-01-31 12:00:00+09")).toBeNull();
    expect(resolveTypedEditor("DATE", "2024-1-5")).toBeNull();
    // 小数秒はミリ秒 3 桁でも落ちうるので対象外。
    expect(resolveTypedEditor("DATETIME", "2024-01-31 12:00:00.123")).toBeNull();
    expect(resolveTypedEditor("TIME", "12:00:00.5")).toBeNull();
    // MySQL のゼロ日付。
    expect(resolveTypedEditor("DATE", "0000-00-00")).toBeNull();
    expect(resolveTypedEditor("DATE", "2024-00-10")).toBeNull();
    expect(resolveTypedEditor("DATE", "2024-01-00")).toBeNull();
  });

  it("真偽値は想定外の表記・打鍵開始の 1 文字目ならテキスト入力", () => {
    for (const v of ["", "NULL", "true", "FALSE", "0", "1"]) {
      expect(resolveTypedEditor("BOOL", v)).toEqual({ control: "bool" });
    }
    for (const v of ["t", "y", "yes", "2"]) expect(resolveTypedEditor("BOOL", v)).toBeNull();
  });

  it("NULL / 空はネイティブで開ける", () => {
    expect(resolveTypedEditor("DATE", "NULL")).toEqual({ control: "native", inputType: "date" });
  });
});

describe("native 値変換", () => {
  it("datetime-local は元の区切り (T / 空白) を引き継ぐ", () => {
    expect(toNativeValue("datetime-local", "2024-01-31 12:00:00")).toBe("2024-01-31T12:00:00");
    expect(fromNativeValue("datetime-local", "2024-01-31T12:00:05", "NULL", "2024-01-31 12:00:00")).toBe(
      "2024-01-31 12:00:05",
    );
    expect(fromNativeValue("datetime-local", "2024-02-01T12:00:05", "NULL", "2024-01-31T12:00:00")).toBe(
      "2024-02-01T12:00:05",
    );
  });
  it("元の値に秒があれば秒 0 でも :00 を補う", () => {
    expect(fromNativeValue("datetime-local", "2024-01-31T12:00", "NULL", "2024-01-31 11:00:00")).toBe(
      "2024-01-31 12:00:00",
    );
    expect(fromNativeValue("time", "12:00", "NULL", "11:00:00")).toBe("12:00:00");
    // 元に秒が無ければ補わない。
    expect(fromNativeValue("time", "12:00", "NULL", "11:00")).toBe("12:00");
    expect(fromNativeValue("datetime-local", "2024-01-31T12:00", "NULL", "")).toBe("2024-01-31 12:00");
  });
  it("クリアは blankAs へ、NULL 表示は空欄で出す", () => {
    expect(fromNativeValue("date", "", "NULL")).toBe("NULL");
    expect(fromNativeValue("date", "", "")).toBe("");
    expect(toNativeValue("date", "NULL")).toBe("");
  });
});

describe("真偽値セレクタ", () => {
  it("表記を開始時の値にそろえる", () => {
    expect(boolOptions("1")).toEqual(["1", "0", "NULL"]);
    expect(boolOptions("true")).toEqual(["true", "false", "NULL"]);
    expect(boolSelectValue("1", "1")).toBe("1");
    expect(boolSelectValue("0", "1")).toBe("0");
    expect(boolSelectValue("false", "true")).toBe("false");
    expect(boolSelectValue("", "")).toBe("NULL");
    // NULL を選んでも選択肢の表記は変わらない。
    expect(boolSelectValue("NULL", "1")).toBe("NULL");
  });
});
