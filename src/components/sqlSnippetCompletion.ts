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
  insertCompletionText,
  pickedCompletion,
  snippet,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { Snippet } from "../api/tauri";
import { snippetHasFields, snippetPlainText, snippetToCodeMirrorTemplate } from "../snippetTemplate";

/** 1 度に出すスニペット候補の上限。 */
export const SNIPPET_COMPLETION_LIMIT = 30;

/** 補完の起点にする語 (英数字・アンダースコア・ハイフン・日本語などの文字)。 */
const WORD_RE = /[\p{L}\p{N}_-]+$/u;

/** 補完を出さない構文ノード (lang-sql のスキーマ補完の除外と同じ)。 */
const NO_COMPLETE_NODES = ["QuotedIdentifier", "SpecialVar", "String", "LineComment", "BlockComment"];

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
    // 部分一致とタグ一致は 2 文字以上から (1 文字だと候補が多すぎてスキーマ補完を邪魔する)。
    else if (q.length < 2) rank = null;
    else if (name.includes(q)) rank = 1;
    else if (s.tags.some((tag) => tag.toLowerCase().includes(q))) rank = 2;
    if (rank !== null) out.push({ snippet: s, rank });
  }
  out.sort((a, b) => a.rank - b.rank || a.snippet.name.localeCompare(b.snippet.name));
  return out;
}

/** 候補の情報パネル。候補を作る時点ではパースせず、表示されたときに平文へ展開する。 */
function renderInfo(sql: string): Node {
  const lines = snippetPlainText(sql).split("\n");
  const head = lines.slice(0, INFO_MAX_LINES).join("\n");
  const el = document.createElement("div");
  el.style.whiteSpace = "pre-wrap";
  el.textContent = lines.length > INFO_MAX_LINES ? `${head}\n…` : head;
  return el;
}

/**
 * 1 件分の補完候補。`info` / `apply` は関数で遅延評価にし、候補を作る時点では本文を
 * パースしない (確定時に初めて記法を解釈する)。記法の無い本文は原文のまま挿入し、
 * カーソルは末尾に来る。
 */
export function snippetToCompletion(s: Snippet, detail: string, rank: SnippetMatch["rank"]): Completion {
  const completion: Completion = {
    label: s.name,
    detail,
    info: () => renderInfo(s.sql),
    type: "snippet",
    // 先頭一致を他の補完ソース (キーワード等) より上、タグ一致は下に置く。
    boost: 5 - rank * 5,
    apply: (view, picked, from, to) => {
      if (snippetHasFields(s.sql)) {
        snippet(snippetToCodeMirrorTemplate(s.sql))(view, picked, from, to);
        return;
      }
      view.dispatch({
        ...insertCompletionText(view.state, s.sql, from, to),
        annotations: pickedCompletion.of(picked),
      });
    },
  };
  return completion;
}

/**
 * 補完ソースを作る。`getSnippets` は呼ばれるたびに最新の (スコープ絞り込み済みの) 一覧を
 * 返す。同期例外は補完全体を止めるので握りつぶして null を返す。
 */
export function snippetCompletionSource(
  getSnippets: () => readonly Snippet[],
  detail: () => string,
): (ctx: CompletionContext) => CompletionResult | null {
  const source = (ctx: CompletionContext): CompletionResult | null => {
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
  // 文字列リテラル・コメント・引用符付き識別子の中では出さない (lang-sql のスキーマ補完と同じ除外)。
  return (ctx) => {
    for (let n: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
      if (NO_COMPLETE_NODES.includes(n.name)) return null;
      if (n.type.isTop) break;
    }
    return source(ctx);
  };
}
