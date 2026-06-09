import { describe, expect, it } from "vitest";
// Vite の `?raw` インポートで両ソースの中身を文字列として取り込む。Node の fs に
// 依存しないため、frontend の `tsc` 型チェック (build) でも追加の型定義が不要。
// `?raw` の型宣言は `vite/client` (src/vite-env.d.ts で参照) が提供する。
import libRs from "../../src-tauri/src/lib.rs?raw";
import tauriTs from "../api/tauri.ts?raw";

// IPC コマンド登録 ↔ フロント (tauri.ts) ラッパのパリティ検証 (#501)。
//
// CLAUDE.md が繰り返し警告するとおり、Tauri コマンドは「Rust ハンドラを追加し、
// `lib.rs` の `generate_handler!` で登録し、`src/api/tauri.ts` に型付きラッパを
// 追加する」3 点セットで成立する。コマンド名はただの文字列なので、登録漏れ・
// 呼び出し漏れ・タイポはコンパイルを通過し、実行時に初めて失敗する。
//
// ここでは両ソースからコマンド名集合を機械的に抽出して突き合わせ、片側にしか
// 存在しないコマンドがあればテストを落とす。これにより「追加し忘れたら CI が
// 落ちる」状態を担保する。frontend ジョブ (Vitest) は Node 上で動くため、両ファイル
// をファイルシステムから直接読み込める。

// `lib.rs` の `generate_handler![...]` ブロックから登録済みコマンド名を抽出する。
// 各エントリは `commands::connection::test_connection,` の形式で、末尾のパス
// セグメントがコマンド名になる。行コメント (`//`) は除去してから解析する。
function extractRegisteredCommands(libRs: string): Set<string> {
  const start = libRs.indexOf("generate_handler![");
  if (start === -1) {
    throw new Error("lib.rs から generate_handler! ブロックが見つからない");
  }
  // `generate_handler![` に続く `]` までを対象にする。マクロ内に `]` は現れない。
  const open = libRs.indexOf("[", start);
  const close = libRs.indexOf("]", open);
  if (open === -1 || close === -1) {
    throw new Error("generate_handler! のブラケットが閉じていない");
  }
  const block = libRs.slice(open + 1, close);

  const commands = new Set<string>();
  for (const rawLine of block.split("\n")) {
    // 行コメントを除去。
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

// `src/api/tauri.ts` の `invoke<...>("name", ...)` 呼び出しからコマンド名を抽出する。
// ジェネリック引数 (`invoke<{ session_id: string }>`) は省略可能だが、いずれの場合も
// 直後の `("コマンド名"` を拾う。
function extractInvokedCommands(tauriTs: string): Set<string> {
  const commands = new Set<string>();
  // `invoke` の直後に任意のジェネリック (`<...>`、`(` を含まない) が来て、`("name"`
  // が続く。
  const re = /\binvoke\s*(?:<[^(]*>)?\s*\(\s*"([a-z_][a-z0-9_]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tauriTs)) !== null) {
    commands.add(match[1]);
  }
  return commands;
}

const registered = extractRegisteredCommands(libRs);
const invoked = extractInvokedCommands(tauriTs);

describe("IPC コマンドパリティ (lib.rs 登録 ↔ tauri.ts 呼び出し)", () => {
  it("両ソースから十分な数のコマンドを抽出できている (抽出ロジックの保険)", () => {
    expect(registered.size).toBeGreaterThanOrEqual(30);
    expect(invoked.size).toBeGreaterThanOrEqual(30);
  });

  it("lib.rs に登録済みだが tauri.ts から呼ばれていないコマンドが無い", () => {
    const missingInFront = [...registered].filter((c) => !invoked.has(c)).sort();
    expect(missingInFront, `tauri.ts にラッパが無い登録コマンド: ${missingInFront.join(", ")}`).toEqual(
      [],
    );
  });

  it("tauri.ts から呼ばれているが lib.rs に登録されていないコマンドが無い", () => {
    const missingInBack = [...invoked].filter((c) => !registered.has(c)).sort();
    expect(missingInBack, `lib.rs に登録の無い呼び出しコマンド: ${missingInBack.join(", ")}`).toEqual(
      [],
    );
  });

  it("登録集合と呼び出し集合が完全一致する", () => {
    expect([...invoked].sort()).toEqual([...registered].sort());
  });
});
