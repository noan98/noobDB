import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildSearchPhrases, SEARCH_PHRASE_KEYS } from "../components/searchPhrases";
import { setLocale, t } from "../i18n";

/** ライブラリ本体から `phrase(view, "...")` / `state.phrase("...")` の原文を抜き出す。 */
function libraryPhrases(): string[] {
  const req = createRequire(import.meta.url);
  const src = readFileSync(req.resolve("@codemirror/search"), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/(?:phrase\(view,|state(?:\$1)?\.phrase\()\s*"([^"]+)"/g)) found.add(m[1]);
  return [...found];
}

describe("検索パネルの phrases (#2401)", () => {
  afterEach(() => setLocale("en"));

  it("ライブラリが使う全ての文言にキーが対応している (過不足なし)", () => {
    const lib = libraryPhrases();
    expect(lib.length).toBeGreaterThan(10);
    expect([...lib].sort()).toEqual(Object.keys(SEARCH_PHRASE_KEYS).sort());
  });

  it("日本語では日本語、英語では英語になる", () => {
    setLocale("ja");
    const ja = buildSearchPhrases(t);
    expect(ja.next).toBe("次へ");
    expect(ja["replace all"]).toBe("すべて置換");
    setLocale("en");
    const en = buildSearchPhrases(t);
    expect(en.next).toBe("Next");
    expect(en["replace all"]).toBe("Replace all");
  });

  it("EditorState.phrase に反映される", () => {
    setLocale("ja");
    const state = EditorState.create({ extensions: EditorState.phrases.of(buildSearchPhrases(t)) });
    expect(state.phrase("match case")).toBe("大文字小文字を区別");
    expect(state.phrase("Find")).toBe("検索");
  });
});
