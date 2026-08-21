import { describe, expect, it } from "vitest";
// `streamEventParity.test.ts` / `ipcArgParity.test.ts` と同じ `import.meta.glob` +
// `?raw` 方式。`src-tauri/src/commands/**/*.rs` を再帰的に列挙することで、将来
// `commands/` 配下にサブモジュールが増えても追記漏れが起きない (#970 と同じ理由)。
import libRs from "../../src-tauri/src/lib.rs?raw";

const commandModules = import.meta.glob("../../src-tauri/src/commands/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const commandSources = Object.values(commandModules);

// 「定義したのに配線されていない」死蔵コマンド検出 (#1031)。
//
// `ipcCommandParity.test.ts` は `lib.rs` の `generate_handler!` **登録**集合と
// `tauri.ts` の**呼び出し**集合を突き合わせるが、その前提は「`generate_handler!`
// に載っているコマンドが正 (真実)」というものだった。`#[tauri::command]` が
// 付いているのに `generate_handler!` から**漏れて**おり、かつ `tauri.ts` の
// ラッパも無い関数は、コンパイルは通るが到達不能という純粋な死蔵コードになる —
// `ipcCommandParity` (登録されていないのでどちらの集合にも現れない)・
// `apiReachabilityParity` (#907、Rust 側は見ない)・knip (TS 限定) のいずれからも
// 不可視。ここでは `src-tauri/src/commands/**/*.rs` のソースを直接読み、実際に
// `#[tauri::command]` が付与された関数名を機械的に抽出して、`generate_handler!`
// 登録集合の**部分集合**であることを assert する。

// 各 `.rs` ファイルから `#[tauri::command]` が付与された `pub (async) fn <name>`
// を抽出する。`ipcCommandParity.test.ts` の `generate_handler!` 抽出と同じく、
// 行コメント (`//` 始まりの内容、`///` `//!` doc コメントも同じプレフィックスなので
// まとめて除去できる) を先に取り除いてから走査する — でないと「`#[tauri::command]`
// wrapper above is intentionally a one-liner」のような**説明文中の記法**を誤検出
// してしまう (`commands/query.rs` / `commands/sync.rs` / `commands/sandbox.rs` に
// 実例がある)。`#[tauri::command]` と `pub fn` の間には `#[allow(...)]` のような
// 追加の属性行が挟まることがあるため、0 個以上の `#[...]` を許容する。
function extractDefinedCommands(sources: string[]): Set<string> {
  const commands = new Set<string>();
  const re =
    /#\[tauri::command\](?:\s*#\[[^\]]*\])*\s*pub\s+(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  for (const src of sources) {
    const cleaned = src
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(cleaned)) !== null) {
      commands.add(match[1]);
    }
  }
  return commands;
}

// `lib.rs` の `generate_handler![...]` ブロックから登録済みコマンド名を抽出する。
// `ipcCommandParity.test.ts::extractRegisteredCommands` と同一ロジック
// (テスト間で import して共有するより、抽出部が同期して壊れないよう意図的に
// 同じ実装をここへも複製している — どちらかを変更したら両方直すこと)。
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

const defined = extractDefinedCommands(commandSources);
const registered = extractRegisteredCommands(libRs);

describe("コマンド登録パリティ (#[tauri::command] 定義 ⇔ generate_handler! 登録)", () => {
  it("commands/**/*.rs から十分な数のコマンドを抽出できている (抽出ロジックの保険)", () => {
    expect(defined.size).toBeGreaterThanOrEqual(30);
  });

  it("doc コメント中の `#[tauri::command]` 記法を誤検出しない (query.rs / sync.rs)", () => {
    // `commands/query.rs::run_query_inner` / `commands/sync.rs::apply_sync_sql_inner`
    // の直前の doc コメントには「The `#[tauri::command]` wrapper above is
    // intentionally a one-liner over this.」という説明文があり、コメント除去が
    // 効いていなければこの文中の記法を実際の属性だと誤認し、直後の `pub(crate)
    // async fn *_inner` を余計に抽出してしまう (Issue #1031 が名指しする境界ケース)。
    expect(defined.has("run_query_inner")).toBe(false);
    expect(defined.has("apply_sync_sql_inner")).toBe(false);
    // `commands/sandbox.rs` のモジュール doc (`//!`) にも同じ記法があるが、対応
    // する固有の関数名は無いため、こちらは下の完全一致テスト (抽出数が
    // `generate_handler!` 登録数と一致する) で誤検出ゼロを間接的に保証する。
  });

  it("#[tauri::command] が付いているのに generate_handler! に登録されていないコマンドが無い", () => {
    const unregistered = [...defined].filter((c) => !registered.has(c)).sort();
    expect(
      unregistered,
      `generate_handler! に登録されていない #[tauri::command]: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });
});
