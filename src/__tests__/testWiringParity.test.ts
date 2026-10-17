import { describe, expect, it } from "vitest";

// Rust 統合 / ゴールデンテストの「結線」を固定するメタテスト (#1509)。
//
// `src-tauri/Cargo.toml` は `autotests = false` で、`tests/*.rs` は `[[test]]` の束ねバイナリ
// (`tests/groups/{golden,integration,external}.rs` が `#[path]` + `mod` で取り込む) か、
// `[[test]].path` で直接指す場合だけコンパイル・実行される。新しい `tests/<name>.rs` を作って
// 結線を忘れると、そのテストは一度もコンパイルされないまま CI が緑になる
// (`fixtureBothSidesParity.test.ts` は `include_str!` の生テキストしか見ないので捕捉できない)。
//   (a) `tests/*.rs` (`groups/` `common/` を除く) が groups の `#[path]` か `[[test]].path` に現れる
//   (b) 結線先 (`#[path]` / `[[test]].path`) のファイルが実在する (リネーム・削除の取り残し)
//   (c) `#[path]` の直後に `mod` が続く (属性だけ残してコメントアウトした場合などを検出)
// 命名規約 `*Parity.test.ts` により CI の `crosslang parity` ジョブで Rust のみの PR でも走る。

// `tests/` 直下の `.rs` (パスに `/` が 1 つだけ続くもの = 非再帰)。
const topLevel = import.meta.glob("../../src-tauri/tests/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const groups = import.meta.glob("../../src-tauri/tests/groups/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const cargo = import.meta.glob("../../src-tauri/Cargo.toml", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const testFiles = Object.keys(topLevel).map(baseName).sort();
const cargoToml = Object.values(cargo)[0] ?? "";

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** groups/*.rs の有効な (コメントアウトされていない) `#[path = "../x.rs"]` + `mod` の組。 */
function groupWiring(): { group: string; target: string; hasMod: boolean }[] {
  const out: { group: string; target: string; hasMod: boolean }[] = [];
  const re = /#\[path\s*=\s*"\.\.\/([^"/]+\.rs)"\s*\]\s*(mod\s+\w+\s*;)?/g;
  for (const [p, src] of Object.entries(groups)) {
    for (const m of stripLineComments(src).matchAll(re)) {
      out.push({ group: baseName(p), target: m[1], hasMod: m[2] !== undefined });
    }
  }
  return out;
}

/** Cargo.toml の `[[test]]` 配下で `tests/` 直下を直接指す `path = "tests/x.rs"`。 */
function cargoDirectTests(): string[] {
  const out: string[] = [];
  const re = /^\s*path\s*=\s*"tests\/([^"/]+\.rs)"/gm;
  for (const m of cargoToml.replace(/#.*$/gm, "").matchAll(re)) out.push(m[1]);
  return out;
}

const wired = new Set([...groupWiring().map((w) => w.target), ...cargoDirectTests()]);

describe("Rust tests/*.rs の結線パリティ (#1509)", () => {
  it("tests/ 直下の .rs とグループが読み込めている", () => {
    expect(testFiles.length).toBeGreaterThan(0);
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    expect(cargoToml).toContain("autotests = false");
  });

  it.each(testFiles)("%s は groups の #[path] か [[test]].path に結線されている", (file) => {
    expect(
      wired.has(file),
      `src-tauri/tests/${file} がどのテストバイナリにも結線されていません。` +
        `tests/groups/{golden,integration,external}.rs に #[path = "../${file}"] + mod を足すか、` +
        "Cargo.toml に [[test]] を足してください (足さないとこのテストは CI で一度も走りません)",
    ).toBe(true);
  });

  it("結線先のファイルが全て実在する", () => {
    const missing = [...wired].filter((f) => !testFiles.includes(f));
    expect(missing, "結線されているが tests/ に存在しないファイル").toEqual([]);
  });

  it("#[path] の直後に mod 宣言がある", () => {
    const dangling = groupWiring()
      .filter((w) => !w.hasMod)
      .map((w) => `${w.group}: ${w.target}`);
    expect(dangling, "#[path] だけで mod が続いていない結線").toEqual([]);
  });
});
