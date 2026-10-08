import { describe, expect, it } from "vitest";
// `commandRegistrationParity.test.ts` / `ipcCommandParity.test.ts` と同じ `?raw`
// インポート方式。こちらは Rust ソースではなく **ドキュメント**を読み込む。
import libRs from "../../src-tauri/src/lib.rs?raw";
import commandListDoc from "../../.claude/skills/noobdb-ipc/references/command-list.md?raw";

// ドキュメントのドリフト検出。
//
// `.claude/skills/noobdb-ipc/references/command-list.md` は「現在の IPC コマンド
// 全件」を名乗るが、これまで人手でしか更新されておらず、実際に約 26 コマンド
// (タスクスケジューラ・フライトレコーダー・アドバイザ・インスペクタなど、機能
// 領域まるごと) が記載漏れしていた。既存のパリティテスト群 (#853 / #907 / #1031)
// が「Rust ⇔ TS」のドリフトを塞いでいるのと同じ発想で、「Rust ⇔ ドキュメント」の
// ドリフトをここで塞ぐ。
//
// 方向は **登録 ⊆ ドキュメント** の一方向だけを強制する。ドキュメントには
// `run_captured_write_inner` のような非コマンド識別子も散文中に出てくるため、
// 完全一致を要求すると誤検出になるが、「登録済みコマンドが 1 つでも書かれて
// いない」ことは常に純粋な記載漏れである。
function extractRegisteredCommands(libRsSource: string): Set<string> {
  const start = libRsSource.indexOf("generate_handler![");
  if (start === -1) {
    throw new Error("lib.rs から generate_handler! ブロックが見つからない");
  }
  const open = libRsSource.indexOf("[", start);
  const close = libRsSource.indexOf("]", open);
  if (open === -1 || close === -1) {
    throw new Error("generate_handler! のブラケットが閉じていない");
  }
  const block = libRsSource.slice(open + 1, close);

  const commands = new Set<string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    for (const entry of line.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      const segments = trimmed.split("::");
      const name = segments[segments.length - 1].trim();
      if (name !== "") commands.add(name);
    }
  }
  return commands;
}

// ドキュメント中の `identifier` (インラインコード) をすべて拾う。コマンド名は
// 必ずバッククォートで囲って書く規約なので、この抽出で漏れることはない。
function extractDocumentedNames(markdown: string): Set<string> {
  const names = new Set<string>();
  const re = /`([a-z_][a-z0-9_]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    names.add(match[1]);
  }
  return names;
}

const registered = extractRegisteredCommands(libRs);
const documented = extractDocumentedNames(commandListDoc);

describe("IPC コマンドとドキュメントのパリティ", () => {
  it("generate_handler! の抽出が機能している (前提条件)", () => {
    expect(registered.size).toBeGreaterThan(50);
  });

  it("登録済みコマンドがすべて command-list.md に記載されている", () => {
    const missing = [...registered].filter((name) => !documented.has(name)).sort();
    expect(
      missing,
      `.claude/skills/noobdb-ipc/references/command-list.md への追記が漏れています。` +
        `コマンドを追加したら、この一覧にも \`名前\` の形で載せてください。`,
    ).toEqual([]);
  });

  it("command-list.md はコマンド総数を手書きしない", () => {
    // 以前は「**160 コマンド**」の宣言を実数と突き合わせていたが、並列の PR が
    // どちらも 160 → 161 と同じ書き換えをすると git は衝突なしでマージし、main で
    // 初めて数が合わなくなる。記載漏れは上の集合チェックで検出できるので、総数は
    // 書かない運用にした (再び書かれたらここで落とす)。
    const declared = /\*\*(\d+)\s*コマンド\*\*/.exec(commandListDoc);
    expect(declared?.[0] ?? null, "コマンド総数は書かずに一覧だけを更新してください").toBeNull();
  });
});
