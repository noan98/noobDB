import { describe, expect, it } from "vitest";
import { extractPartialJsonStrings, partialJsonPreview } from "../ai/partialJson";

describe("extractPartialJsonStrings (#1470)", () => {
  it("完結した JSON のトップレベル文字列フィールドを取り出す", () => {
    const text = JSON.stringify({ explanation: "E", cause: "C", notes: ["N"], count: 3, ok: true });
    expect(extractPartialJsonStrings(text)).toEqual({ explanation: "E", cause: "C" });
  });

  it("値が途中で切れていても、そこまでの文字列を返す", () => {
    expect(extractPartialJsonStrings('{"explanation":"列 nme が見つか')).toEqual({
      explanation: "列 nme が見つか",
    });
  });

  it("まだ始まっていない / 空 / JSON でない入力は空のオブジェクト", () => {
    expect(extractPartialJsonStrings("")).toEqual({});
    expect(extractPartialJsonStrings("  ")).toEqual({});
    expect(extractPartialJsonStrings("plain text")).toEqual({});
    expect(extractPartialJsonStrings('{"expl')).toEqual({});
    expect(extractPartialJsonStrings('{"explanation"')).toEqual({});
    expect(extractPartialJsonStrings('{"explanation":')).toEqual({});
  });

  it("先頭の空白と、エスケープ (\\n \\\" \\\\ \\uXXXX) を解釈する", () => {
    const text = ' \n{"a":"x\\ny \\"q\\" \\\\ \\u3042"}';
    expect(extractPartialJsonStrings(text)).toEqual({ a: 'x\ny "q" \\ あ' });
  });

  it("エスケープの途中で切れた末尾は捨てる", () => {
    expect(extractPartialJsonStrings('{"a":"abc\\')).toEqual({ a: "abc" });
    expect(extractPartialJsonStrings('{"a":"abc\\u30')).toEqual({ a: "abc" });
    expect(extractPartialJsonStrings('{"a":"abc\\u3042')).toEqual({ a: "abcあ" });
  });

  it("末尾が上位サロゲートだけで切れていたら捨て、揃えば文字として返す", () => {
    const emoji = "😀"; // \uD83D\uDE00
    expect(extractPartialJsonStrings(`{"a":"x${emoji.slice(0, 1)}`)).toEqual({ a: "x" });
    expect(extractPartialJsonStrings(`{"a":"x${emoji}`)).toEqual({ a: `x${emoji}` });
  });

  it("入れ子のオブジェクトや配列の中の文字列は拾わない", () => {
    const text = '{"items":[{"explanation":"inner"},"s"],"meta":{"explanation":"inner2"},"explanation":"outer"}';
    expect(extractPartialJsonStrings(text)).toEqual({ explanation: "outer" });
  });

  it("配列の途中で切れていても、先に届いた文字列フィールドは返す", () => {
    expect(extractPartialJsonStrings('{"explanation":"E","notes":["n1","n')).toEqual({ explanation: "E" });
  });

  it("文字列値の中の括弧やカンマ、キーに見える文字列に惑わされない", () => {
    const text = '{"explanation":"a, {b} [c] \\"k\\": v","cause":"C"}';
    expect(extractPartialJsonStrings(text)).toEqual({ explanation: 'a, {b} [c] "k": v', cause: "C" });
  });

  it("数値・真偽値・null の値の後ろの文字列は、そのキーの値として扱わない", () => {
    expect(extractPartialJsonStrings('{"n":1,"s":"x","b":true,"z":null,"t":"y"}')).toEqual({ s: "x", t: "y" });
  });

  it("同じ入力を 1 文字ずつ受信しても、届いた分だけが単調に伸びる", () => {
    const full = JSON.stringify({ explanation: "あいう\n\"え\"", cause: "かきく" });
    let prev = "";
    for (let i = 0; i <= full.length; i++) {
      const got = extractPartialJsonStrings(full.slice(0, i)).explanation ?? "";
      expect("あいう\n\"え\"".startsWith(got)).toBe(true);
      expect(got.length).toBeGreaterThanOrEqual(prev.length);
      prev = got;
    }
    expect(prev).toBe("あいう\n\"え\"");
  });
});

describe("partialJsonPreview (#1470)", () => {
  it("指定したフィールドのうち届いているものだけを、指定順に空行区切りで連結する", () => {
    const text = '{"sql":"SELECT 1","explanation":"一件","warnings":[]}';
    expect(partialJsonPreview(text, ["sql", "explanation"])).toBe("SELECT 1\n\n一件");
    expect(partialJsonPreview(text, ["explanation", "sql"])).toBe("一件\n\nSELECT 1");
  });

  it("空文字のフィールドと未到着のフィールドは出さない", () => {
    expect(partialJsonPreview('{"sql":"","explanation":"途中', ["sql", "explanation", "cause"])).toBe("途中");
    expect(partialJsonPreview("", ["sql"])).toBe("");
  });
});
