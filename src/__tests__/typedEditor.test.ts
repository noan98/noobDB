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
    expect(resolveTypedEditor("TIMESTAMP(6)", "")).toEqual({ control: "native", inputType: "datetime-local" });
    expect(resolveTypedEditor("TIME", "12:30")).toEqual({ control: "native", inputType: "time" });
    expect(resolveTypedEditor("BOOLEAN", "true")).toEqual({ control: "bool" });
    expect(resolveTypedEditor("VARCHAR", "x")).toBeNull();
  });

  it("ネイティブで表せない値はテキスト入力へフォールバック", () => {
    expect(resolveTypedEditor("TIME", "838:59:59")).toBeNull();
    expect(resolveTypedEditor("TIMESTAMP", "2024-01-31 12:00:00+09")).toBeNull();
    expect(resolveTypedEditor("DATE", "2024-1-5")).toBeNull();
    expect(resolveTypedEditor("DATETIME", "2024-01-31 12:00:00.123456")).toBeNull();
  });

  it("NULL / 空はネイティブで開ける", () => {
    expect(resolveTypedEditor("DATE", "NULL")).toEqual({ control: "native", inputType: "date" });
  });
});

describe("native 値変換", () => {
  it("datetime-local は空白と T を相互変換する", () => {
    expect(toNativeValue("datetime-local", "2024-01-31 12:00:00")).toBe("2024-01-31T12:00:00");
    expect(fromNativeValue("datetime-local", "2024-01-31T12:00", "NULL")).toBe("2024-01-31 12:00");
  });
  it("クリアは blankAs へ、NULL 表示は空欄で出す", () => {
    expect(fromNativeValue("date", "", "NULL")).toBe("NULL");
    expect(fromNativeValue("date", "", "")).toBe("");
    expect(toNativeValue("date", "NULL")).toBe("");
  });
});

describe("真偽値セレクタ", () => {
  it("表記を現在値にそろえる", () => {
    expect(boolOptions("1")).toEqual(["1", "0", "NULL"]);
    expect(boolOptions("true")).toEqual(["true", "false", "NULL"]);
    expect(boolSelectValue("1")).toBe("1");
    expect(boolSelectValue("0")).toBe("0");
    expect(boolSelectValue("false")).toBe("false");
    expect(boolSelectValue("")).toBe("NULL");
  });
});
