import { describe, expect, it } from "vitest";
// `commandRegistrationParity.test.ts` 等と同じ `import.meta.glob` + `?raw` 方式。
// こちらは `commands/` に限らず `src-tauri/src/**/*.rs` 全体を読む。
const allSources = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// 「全 `#[tauri::command]` は `src-tauri/src/commands/` 配下にある」不変条件 (#2037)。
//
// read_only 分類 (readOnlyGuardParity)・serde 網羅 (serdeCoverageParity)・登録漏れ
// (commandRegistrationParity)・引数パリティ (ipcArgParity) は、いずれも
// `commands/**/*.rs` しか読まない。`commands/` の外に `#[tauri::command]` を定義して
// `generate_handler!` に登録すると 4 系統すべてから不可視になり、特に書き込み
// コマンドが read_only ガード網羅から漏れると read_only プロファイルで静かに
// 書き込みが通りうる。ここで置き場所そのものを強制する。

/**
 * 行コメント・ブロックコメントを除去する (説明文中の記法の誤検出を避ける)。
 * `"a/*b"` のような文字列リテラル内の `/*` `//` でその後ろを巻き込んで消さないよう、
 * 先にリテラルの中身を空にする (channelMessageParity の stripRustComments と同方式。
 * ここでは属性値を読まないので復元はしない)。
 */
function stripComments(src: string): string {
  const masked = src.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return masked.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const COMMAND_RE =
  /#\[tauri::command(?:\([^\]]*\))?\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** `#[tauri::command]` を含むファイルごとに、コマンド名と属性の出現数を返す。 */
function scan(sources: Record<string, string>): Map<string, { count: number; names: string[] }> {
  const result = new Map<string, { count: number; names: string[] }>();
  for (const [path, raw] of Object.entries(sources)) {
    const cleaned = stripComments(raw);
    const count = (cleaned.match(/#\[tauri::command\b/g) ?? []).length;
    if (count === 0) continue;
    const names = [...cleaned.matchAll(COMMAND_RE)].map((m) => m[1]);
    result.set(path, { count, names });
  }
  return result;
}

const isUnderCommands = (path: string) => path.includes("/src-tauri/src/commands/");

describe("#[tauri::command] の置き場所 (#2037)", () => {
  it("src-tauri/src/ 全体を走査できている", () => {
    const paths = Object.keys(allSources);
    expect(paths.some(isUnderCommands)).toBe(true);
    expect(paths.some((p) => !isUnderCommands(p))).toBe(true);
  });

  it("全 #[tauri::command] が commands/ 配下に定義されている", () => {
    const outside = [...scan(allSources).entries()]
      .filter(([path]) => !isUnderCommands(path))
      .map(([path, v]) => `${path} (${v.names.join(", ") || `${v.count} 件`})`);
    expect(
      outside,
      `commands/ の外に #[tauri::command] がある。read_only / serde / 引数 / 登録の各パリティ検査から不可視になるため commands/ 配下へ移すこと: ${outside.join("; ")}`,
    ).toEqual([]);
  });

  it("属性の数と関数名の抽出数が一致する (抽出漏れで素通りしない)", () => {
    const mismatched = [...scan(allSources).entries()]
      .filter(([, v]) => v.count !== v.names.length)
      .map(([path]) => path);
    expect(mismatched).toEqual([]);
  });

  it("検出ロジック: commands/ 外のダミー定義とコメント内の記法を区別する", () => {
    const dummy = {
      "/x/src-tauri/src/db/evil.rs": "#[tauri::command]\npub async fn evil() {}",
      "/x/src-tauri/src/db/doc.rs":
        "/// `#[tauri::command]` の説明\n// #[tauri::command]\n/* #[tauri::command] */",
    };
    const found = scan({
      ...dummy,
      "/x/src-tauri/src/db/args.rs":
        '#[tauri::command(rename_all = "snake_case")]\npub async fn with_args() {}',
      "/x/src-tauri/src/db/lit.rs": 'let s = "a/*b";\n#[tauri::command]\npub fn after_literal() {}',
    });
    expect([...found.keys()].sort()).toEqual([
      "/x/src-tauri/src/db/args.rs",
      "/x/src-tauri/src/db/evil.rs",
      "/x/src-tauri/src/db/lit.rs",
    ]);
    expect(found.get("/x/src-tauri/src/db/args.rs")?.names).toEqual(["with_args"]);
    expect(found.get("/x/src-tauri/src/db/lit.rs")?.names).toEqual(["after_literal"]);
    expect(found.get("/x/src-tauri/src/db/evil.rs")?.names).toEqual(["evil"]);
  });
});
