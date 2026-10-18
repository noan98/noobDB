// @vitest-environment jsdom (CodeMirror の EditorView を実際に生成してタブストップ展開を確かめるため)
import {
  CompletionContext,
  nextSnippetField,
  prevSnippetField,
  type Completion,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { sql } from "@codemirror/lang-sql";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { Snippet } from "../api/tauri";
import { matchSnippets, snippetCompletionSource } from "../components/sqlSnippetCompletion";
import { snippetPlainText, snippetToCodeMirrorTemplate } from "../snippetTemplate";
import { snippet as cmSnippet } from "@codemirror/autocomplete";

const mk = (name: string, sql: string, tags: string[] = []): Snippet => ({
  id: name,
  name,
  folder: null,
  tags,
  sql,
  driver: null,
  scope: { kind: "any" },
});

const SNIPS = [
  mk("sel", "SELECT ${1:cols} FROM ${2:table} WHERE ${3:cond}", ["query"]),
  mk("select-all", "SELECT * FROM users"),
  mk("count", "SELECT COUNT(*) FROM t", ["aggregate", "sel-helper"]),
  mk("ユーザー一覧", "SELECT * FROM users WHERE id = $1"),
];

describe("matchSnippets", () => {
  it("名前の先頭一致 > 部分一致 > タグ一致の順に並べる", () => {
    const r = matchSnippets(SNIPS, "sel");
    expect(r.map((m) => [m.snippet.name, m.rank])).toEqual([
      ["sel", 0],
      ["select-all", 0],
      ["count", 2],
    ]);
    expect(matchSnippets(SNIPS, "all").map((m) => [m.snippet.name, m.rank])).toEqual([["select-all", 1]]);
  });

  it("部分一致とタグ一致は 2 文字以上から (1 文字は先頭一致だけ)", () => {
    expect(matchSnippets(SNIPS, "l").map((m) => m.snippet.name)).toEqual(["sel", "select-all"].slice(0, 0));
    expect(matchSnippets(SNIPS, "c").map((m) => m.snippet.name)).toEqual(["count"]);
    expect(matchSnippets(SNIPS, "q").map((m) => m.snippet.name)).toEqual([]);
    expect(matchSnippets(SNIPS, "qu").map((m) => m.snippet.name)).toEqual(["sel"]);
  });

  it("大文字小文字を区別せず、空の語は全件", () => {
    expect(matchSnippets(SNIPS, "SEL").length).toBe(3);
    expect(matchSnippets(SNIPS, "").length).toBe(SNIPS.length);
    expect(matchSnippets(SNIPS, "zzz")).toEqual([]);
  });

  it("日本語の名前にも一致する", () => {
    expect(matchSnippets(SNIPS, "ユーザ").map((m) => m.snippet.name)).toEqual(["ユーザー一覧"]);
  });
});

describe("snippetCompletionSource", () => {
  const run = (doc: string, explicit = false, snippets = SNIPS) => {
    const state = EditorState.create({ doc });
    const ctx = new CompletionContext(state, doc.length, explicit);
    return snippetCompletionSource(
      () => snippets,
      () => "スニペット",
    )(ctx);
  };

  it("語の先頭位置から候補を返し、自前フィルタ (filter:false) にする", () => {
    const r = run("SELECT 1; sel");
    expect(r?.from).toBe(10);
    expect(r?.filter).toBe(false);
    expect(r?.options.map((o) => o.label)).toEqual(["sel", "select-all", "count"]);
    expect(r?.options[0].detail).toBe("スニペット");
    expect(r?.options[0].type).toBe("snippet");
  });

  it("語が無いときは明示呼び出しのときだけ全件", () => {
    expect(run("SELECT 1; ")).toBeNull();
    expect(run("SELECT 1; ", true)?.options.length).toBe(SNIPS.length);
  });

  it("候補が無い / スニペットが空なら null", () => {
    expect(run("zzz")).toBeNull();
    expect(run("sel", false, [])).toBeNull();
  });

  it("info / apply は遅延評価の関数で、確定時に記法の有無で挿入方法を切り替える", () => {
    const r = run("sel");
    const byLabel = (l: string) => r?.options.find((o) => o.label === l) as Completion;
    expect(typeof byLabel("sel").apply).toBe("function");
    expect(typeof byLabel("sel").info).toBe("function");
    const info = (byLabel("sel").info as (c: Completion) => Node)(byLabel("sel"));
    expect(info.textContent).toBe("SELECT cols FROM table WHERE cond");
  });

  const applyTo = (label: string, text: string) => {
    const r = run(text);
    const c = r?.options.find((o) => o.label === label) as Completion;
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: [EditorState.allowMultipleSelections.of(true)] }),
      parent: document.body,
    });
    (c.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(
      view,
      c,
      r?.from ?? 0,
      text.length,
    );
    return view;
  };

  it("$1 や \\${ を含む記法なしの既存スニペットは原文のまま挿入される", () => {
    const v = applyTo("ユーザー一覧", "ユーザー");
    expect(v.state.doc.toString()).toBe("SELECT * FROM users WHERE id = $1");
    v.destroy();
  });

  it("文字列リテラル・コメントの中では候補を出さない", () => {
    // lang-sql の構文木が無い素の state では判定できないので、SQL 言語付きの state で確かめる。
    const state = EditorState.create({ doc: "SELECT 'sel", extensions: [sql()] });
    const src = snippetCompletionSource(
      () => SNIPS,
      () => "x",
    );
    expect(src(new CompletionContext(state, state.doc.length, false))).toBeNull();
    const c = EditorState.create({ doc: "-- sel", extensions: [sql()] });
    expect(src(new CompletionContext(c, c.doc.length, false))).toBeNull();
    const ok = EditorState.create({ doc: "SELECT sel", extensions: [sql()] });
    expect(src(new CompletionContext(ok, ok.doc.length, false))).not.toBeNull();
  });

  it("ソースが例外を投げても null を返す", () => {
    const state = EditorState.create({ doc: "sel" });
    const src = snippetCompletionSource(
      () => {
        throw new Error("boom");
      },
      () => "x",
    );
    expect(src(new CompletionContext(state, 3, false))).toBeNull();
  });
});

describe("タブストップ展開 (CodeMirror snippet)", () => {
  const expand = (template: string, doc = "") => {
    // 連動フィールドは複数選択で実現されるので、エディタ本体と同じく許可しておく (QueryEditor の makeState)。
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true)] }),
      parent: document.body,
    });
    cmSnippet(snippetToCodeMirrorTemplate(template))(view, null, doc.length, doc.length);
    return view;
  };
  const selText = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

  it("挿入直後は 1 番の既定値が選択され、Tab / Shift+Tab で巡回できる", () => {
    const v = expand("SELECT ${1:cols} FROM ${2:table} WHERE ${3:cond}");
    expect(v.state.doc.toString()).toBe("SELECT cols FROM table WHERE cond");
    expect(selText(v)).toBe("cols");
    expect(nextSnippetField(v)).toBe(true);
    expect(selText(v)).toBe("table");
    expect(nextSnippetField(v)).toBe(true);
    expect(selText(v)).toBe("cond");
    v.destroy();
  });

  it("途中のフィールドからは Shift+Tab で戻れる", () => {
    const v = expand("SELECT ${1:cols} FROM ${2:table} WHERE ${3:cond}");
    expect(prevSnippetField(v)).toBe(false); // 1 番では戻れない
    nextSnippetField(v);
    expect(selText(v)).toBe("table");
    expect(prevSnippetField(v)).toBe(true);
    expect(selText(v)).toBe("cols");
    v.destroy();
  });

  it("${0} が最後の停止位置になる", () => {
    const v = expand("INSERT INTO ${1:t} VALUES (${0})");
    expect(selText(v)).toBe("t");
    expect(nextSnippetField(v)).toBe(true);
    const pos = v.state.selection.main.head;
    expect(v.state.doc.toString().slice(pos - 1, pos + 1)).toBe("()");
    v.destroy();
  });

  it("{{name}} と $1 は本文にそのまま残る", () => {
    const v = expand("SELECT ${1:c} FROM t WHERE a = {{id}} AND b = $1");
    expect(v.state.doc.toString()).toBe("SELECT c FROM t WHERE a = {{id}} AND b = $1");
    v.destroy();
  });

  it("連動フィールドは入力に追従する", () => {
    const v = expand("${1:a} = ${1}");
    expect(v.state.doc.toString()).toBe("a = a");
    v.dispatch(v.state.replaceSelection("xyz"));
    expect(v.state.doc.toString()).toBe("xyz = xyz");
    v.destroy();
  });
});

describe("単一行・行頭タブなしの本文: 展開した doc と snippetPlainText が一致する", () => {
  const cases = [
    "SELECT ${1:cols} FROM ${2:table} WHERE ${3:cond}",
    "SELECT ${cols} FROM ${tbl} WHERE a = {{id}}",
    "SELECT ${1:a}, ${1} FROM t",
    "SELECT '{\"a\":1}'::jsonb, ${1:x}",
    "echo \\${1:x} ${2:y}",
    "SELECT * FROM users WHERE id = $1 AND x = ${1:v}",
    "SELECT ${cols} FROM ${tbl}${0}",
    "${1:a} ${tbl} ${0}",
    "SELECT * FROM t -- {not a field}",
  ];
  it.each(cases)("%s", (src) => {
    const view = new EditorView({
      state: EditorState.create({ doc: "", extensions: [EditorState.allowMultipleSelections.of(true)] }),
      parent: document.body,
    });
    cmSnippet(snippetToCodeMirrorTemplate(src))(view, null, 0, 0);
    expect(view.state.doc.toString()).toBe(snippetPlainText(src));
    view.destroy();
  });
});

describe("巡回順: ${0} は他のフィールドより必ず後", () => {
  const order = (src: string) => {
    const view = new EditorView({
      state: EditorState.create({ doc: "", extensions: [EditorState.allowMultipleSelections.of(true)] }),
      parent: document.body,
    });
    cmSnippet(snippetToCodeMirrorTemplate(src))(view, null, 0, 0);
    const stops: string[] = [];
    const cur = () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    stops.push(`${view.state.selection.main.from}:${cur()}`);
    while (nextSnippetField(view)) stops.push(`${view.state.selection.main.from}:${cur()}`);
    view.destroy();
    return stops;
  };

  it("名前付きだけ + ${0}", () => {
    // cols → tbl → 末尾 (${0})
    expect(order("SELECT ${cols} FROM ${tbl}${0}")).toEqual(["7:cols", "17:tbl", "20:"]);
  });

  it("番号付きと名前付きの混在 + ${0}", () => {
    expect(order("${1:a} ${tbl} ${0}")).toEqual(["0:a", "2:tbl", "6:"]);
  });

  it("名前付きだけ (${0} なし) は出現順", () => {
    expect(order("${x} ${y}")).toEqual(["0:x", "2:y"]);
  });
});
