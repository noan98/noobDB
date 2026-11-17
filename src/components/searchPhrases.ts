import type { I18nKey } from "../i18n";

/**
 * `@codemirror/search` が `state.phrase()` に渡す英語の原文 → noobDB の i18n キー (#2401)。
 * 左辺はライブラリ内部の文字列そのもの (大文字小文字も含めて一致が必要)。
 * ライブラリを更新して文言が変わったときは searchPhrases.test.ts が落ちる。
 */
export const SEARCH_PHRASE_KEYS = {
  Find: "editorSearchFind",
  Replace: "editorSearchReplace",
  next: "editorSearchNext",
  previous: "editorSearchPrevious",
  all: "editorSearchAll",
  "match case": "editorSearchMatchCase",
  regexp: "editorSearchRegexp",
  "by word": "editorSearchByWord",
  replace: "editorSearchReplaceOne",
  "replace all": "editorSearchReplaceAll",
  close: "editorSearchClose",
  "current match": "editorSearchCurrentMatch",
  "on line": "editorSearchOnLine",
  "replaced match on line $": "editorSearchReplacedOnLine",
  "replaced $ matches": "editorSearchReplacedMatches",
  "Go to line": "editorGotoLine",
  go: "editorGotoLineGo",
} as const satisfies Record<string, I18nKey>;

/** `EditorState.phrases.of()` へ渡す辞書を現在のロケールで組み立てる。 */
export function buildSearchPhrases(translate: (key: I18nKey) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [phrase, key] of Object.entries(SEARCH_PHRASE_KEYS)) out[phrase] = translate(key);
  return out;
}
