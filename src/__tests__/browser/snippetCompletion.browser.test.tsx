import { beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import { installTauriMock } from "./tauriMock";
import { QueryEditor, type QueryEditorHandle } from "../../components/QueryEditor";
import type { Snippet } from "../../api/tauri";

// #1489 — 保存済みスニペットの補完とタブストップ展開。補完ポップアップと Tab / Shift+Tab による
// フィールド巡回は実レイアウト・実キー入力が要るので実ブラウザで確かめる。

const snip = (name: string, sql: string, tags: string[] = []): Snippet => ({
  id: name,
  name,
  folder: null,
  tags,
  sql,
  driver: null,
  scope: { kind: "any" },
});

const SNIPPETS = [
  snip("sel", "SELECT ${1:cols} FROM ${2:table} WHERE ${3:cond}", ["query"]),
  snip("pgparam", "SELECT * FROM users WHERE id = $1"),
];

let handle: QueryEditorHandle | null = null;

async function mountEditor(initialSql = "") {
  handle = null;
  const screen = await renderInBrowser(
    <QueryEditor
      ref={(h) => {
        handle = h;
      }}
      onRun={() => {}}
      initialSql={initialSql}
      sessionId="s1"
      driver="mysql"
      defaultDatabase="shop"
      snippets={SNIPPETS}
    />,
  );
  await screen.getByRole("textbox").click();
  return screen;
}

/** CodeMirror はポップアップが開いて一定時間 (既定 75ms) は確定を受け付けない。 */
const settle = () => new Promise((r) => setTimeout(r, 200));
const docText = () => handle?.getText() ?? "";
const selectedText = () => window.getSelection()?.toString() ?? "";
const optionLabels = () =>
  [...document.querySelectorAll(".cm-tooltip-autocomplete li .cm-completionLabel")].map(
    (e) => e.textContent ?? "",
  );

describe("スニペット補完とタブストップ (実ブラウザ)", () => {
  beforeEach(() => {
    installTauriMock();
  });

  it("名前を打つと候補に出て、Tab で確定するとタブストップ付きで展開される", async () => {
    await mountEditor();
    await userEvent.keyboard("sel");
    await expect.poll(() => optionLabels().includes("sel"), { timeout: 5_000 }).toBe(true);
    // 種別アイコンが付く。
    expect(document.querySelector(".cm-tooltip-autocomplete .cm-completionIcon-snippet svg")).not.toBeNull();
    await settle();
    await userEvent.keyboard("{Tab}");
    await expect.poll(docText, { timeout: 5_000 }).toBe("SELECT cols FROM table WHERE cond");
    await expect.poll(selectedText).toBe("cols");
    await userEvent.keyboard("{Tab}");
    await expect.poll(selectedText).toBe("table");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.poll(selectedText).toBe("cols");
    await userEvent.keyboard("{Tab}name{Tab}");
    await expect.poll(selectedText).toBe("cond");
    expect(docText()).toBe("SELECT cols FROM name WHERE cond");
  });

  it("insertSnippet (サイドバー / パレットからの挿入) でも同じようにフィールドを巡回できる", async () => {
    await mountEditor();
    handle?.insertSnippet("SELECT ${1:cols} FROM ${2:table}");
    await expect.poll(docText, { timeout: 5_000 }).toBe("SELECT cols FROM table");
    await expect.poll(selectedText).toBe("cols");
    await userEvent.keyboard("{Tab}");
    await expect.poll(selectedText).toBe("table");
  });

  it("記法の無いスニペット ($1 を含む) は従来どおりそのまま挿入され、カーソルは末尾に来る", async () => {
    await mountEditor();
    handle?.insertSnippet("SELECT * FROM users WHERE id = $1");
    await expect.poll(docText, { timeout: 5_000 }).toBe("SELECT * FROM users WHERE id = $1");
    expect(selectedText()).toBe("");
    await userEvent.keyboard("{Tab}");
    expect(docText()).toBe("SELECT * FROM users WHERE id = $1");
  });

  it("補完から $1 を含む既存スニペットを選んでも本文は変わらない", async () => {
    await mountEditor();
    await userEvent.keyboard("pgp");
    await expect.poll(() => optionLabels().includes("pgparam"), { timeout: 5_000 }).toBe(true);
    await settle();
    await userEvent.keyboard("{Tab}");
    await expect.poll(docText, { timeout: 5_000 }).toBe("SELECT * FROM users WHERE id = $1");
  });
});
