// @vitest-environment jsdom (CodeMirror の EditorView を実際に生成してタブストップ展開を確かめるため)
import {
  CompletionContext,
  nextSnippetField,
  prevSnippetField,
  type Completion,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { Snippet } from "../api/tauri";
import { matchSnippets, snippetCompletionSource } from "../components/sqlSnippetCompletion";
import { snippetToCodeMirrorTemplate } from "../snippetTemplate";
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

  it("記法の無い本文は文字列で挿入、記法ありは関数 (snippet) で展開する", () => {
    const r = run("sel");
    const byLabel = (l: string) => r?.options.find((o) => o.label === l) as Completion;
    expect(typeof byLabel("sel").apply).toBe("function");
    expect(byLabel("select-all").apply).toBe("SELECT * FROM users");
    // 情報パネルは既定値に置き換えた本文
    expect(byLabel("sel").info).toBe("SELECT cols FROM table WHERE cond");
  });

  it("$1 を含む既存スニペットは $1 のまま挿入される", () => {
    const r = run("ユーザー");
    expect(r?.options[0].apply).toBe("SELECT * FROM users WHERE id = $1");
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
