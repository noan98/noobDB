// 保存済みスニペットをエディタの補完候補にする (#1489)。
//
// 名前 (またはタグ) を打つと候補に出て、確定するとタブストップ付きで展開される。
// 絞り込みは CodeMirror の既定 (ラベルのあいまい一致) ではなく自前で行う
// (`filter: false`)。名前の先頭一致 > 名前の部分一致 > タグの部分一致の順に並べ、
// タグだけで当たった候補も出すため。現在の接続に合うスニペットだけを渡す責任は呼び出し側
// (`scopeMatches`)。記法の解釈は `snippetTemplate.ts`。

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippet,
} from "@codemirror/autocomplete";
import type { Snippet } from "../api/tauri";
import { snippetHasFields, snippetPlainText, snippetToCodeMirrorTemplate } from "../snippetTemplate";

/** 1 度に出すスニペット候補の上限。 */
export const SNIPPET_COMPLETION_LIMIT = 30;

/** 補完の起点にする語 (英数字・アンダースコア・ハイフン・日本語などの文字)。 */
const WORD_RE = /[\p{L}\p{N}_-]+$/u;

/** 情報パネルに出す本文の最大行数 (超過分は「…」)。 */
const INFO_MAX_LINES = 8;

export interface SnippetMatch {
  snippet: Snippet;
  /** 0: 名前の先頭一致 / 1: 名前の部分一致 / 2: タグの部分一致。小さいほど上位。 */
  rank: 0 | 1 | 2;
}

/**
 * 入力中の語 `word` に合うスニペットを順位付きで返す。`word` が空なら全件 (順位 0)。
 * 同順位は名前の昇順 (安定)。
 */
export function matchSnippets(snippets: readonly Snippet[], word: string): SnippetMatch[] {
  const q = word.toLowerCase();
  const out: SnippetMatch[] = [];
  for (const s of snippets) {
    const name = s.name.toLowerCase();
    let rank: SnippetMatch["rank"] | null = null;
    if (q === "" || name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (s.tags.some((tag) => tag.toLowerCase().includes(q))) rank = 2;
    if (rank !== null) out.push({ snippet: s, rank });
  }
  out.sort((a, b) => a.rank - b.rank || a.snippet.name.localeCompare(b.snippet.name));
  return out;
}

/** 候補の情報パネル用に、タブストップを既定値へ置き換えた本文の先頭だけを返す。 */
function infoText(sql: string): string {
  const lines = snippetPlainText(sql).split("\n");
  const head = lines.slice(0, INFO_MAX_LINES).join("\n");
  return lines.length > INFO_MAX_LINES ? `${head}\n…` : head;
}

/** 1 件分の補完候補。記法の無い本文は文字列でそのまま挿入し、従来どおり末尾へカーソルを置く。 */
export function snippetToCompletion(s: Snippet, detail: string, rank: SnippetMatch["rank"]): Completion {
  return {
    label: s.name,
    detail,
    info: infoText(s.sql),
    type: "snippet",
    // 先頭一致を他の補完ソース (キーワード等) より上、タグ一致は下に置く。
    boost: 5 - rank * 5,
    apply: snippetHasFields(s.sql) ? snippet(snippetToCodeMirrorTemplate(s.sql)) : snippetPlainText(s.sql),
  };
}

/**
 * 補完ソースを作る。`getSnippets` は呼ばれるたびに最新の (スコープ絞り込み済みの) 一覧を
 * 返す。同期例外は補完全体を止めるので握りつぶして null を返す。
 */
export function snippetCompletionSource(
  getSnippets: () => readonly Snippet[],
  detail: () => string,
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx) => {
    try {
      const snippets = getSnippets();
      if (snippets.length === 0) return null;
      const m = ctx.matchBefore(WORD_RE);
      // 語が無いのは Ctrl+Space などの明示呼び出しのときだけ全件を出す。
      if (!m && !ctx.explicit) return null;
      const word = m?.text ?? "";
      const matches = matchSnippets(snippets, word).slice(0, SNIPPET_COMPLETION_LIMIT);
      if (matches.length === 0) return null;
      const label = detail();
      return {
        from: m ? m.from : ctx.pos,
        filter: false,
        options: matches.map((x) => snippetToCompletion(x.snippet, label, x.rank)),
      };
    } catch {
      return null;
    }
  };
}
